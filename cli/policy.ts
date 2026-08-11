/**
 * `baseclf policy`: put a policy on a table without writing SQL.
 *
 * Until this existed, exposing a table meant hand-writing inserts into
 * `_exposed_tables`, `_policies` and `_policy_binds` and running them through
 * `wrangler d1 execute`, which the README documents as the path that bypasses the
 * engine entirely. So the only way to use the product was through the hole in it.
 *
 * ## What this command is careful about
 *
 *   1. **It refuses before it writes.** Parsing happens first and needs no network,
 *      so a document with a forbidden claim is rejected before anything is created.
 *      Then the live schema is read and the document is checked against it. Only then
 *      does anything change.
 *   2. **It leaves a closed state when it fails.** There is no transaction to be had
 *      here (see `policy-document.ts`), so the ordering carries it: the table stops
 *      being exposed at the first statement and starts again at the last.
 *   3. 🔴 **It does not take effect immediately, and it says so.** An earlier version
 *      of this comment claimed the version bump invalidated a cache. It does not:
 *      measured in `src/policy/registry-cache.test.ts`, the registry is a bare
 *      per-isolate memo and nothing reads the version at all. A change lands as
 *      isolates recycle, with no bound on how long that takes, so an operator who
 *      **narrows** a policy is the one who needs telling.
 *
 * ⚠️ Everything here goes over the D1 REST API, which `rules/01` section E is explicit
 * is not a data plane. That is correct for this and only this: one administrator, on
 * their own machine, changing their own policies.
 */

import type { Catalogue } from '../src/db/introspect.js';
import { introspect } from '../src/db/introspect.js';
import {
  type D1Credentials,
  type D1Endpoint,
  type Fetcher,
  findDatabase,
  restExecutor,
  runSql,
} from './d1-api.js';
import { nextAction, note, type Style, styledResultLine } from './output.js';
import {
  checkAgainstSchema,
  nextVersion,
  readPolicyDocument,
  writeStatements,
} from './policy-document.js';

type Write = (text: string) => void;

export type PolicyOutcome = 'ok' | 'usage' | 'failed';

export interface PolicyHost {
  readonly fetcher: Fetcher;
  /** The document, read at the edge. Undefined when there is no such file. */
  readonly readFile: (path: string) => string | undefined;
  /** Resolved the same way every other command resolves it. */
  readonly credentials: () => Promise<{
    credentials: D1Credentials;
    warnings: readonly string[];
  } | null>;
}

/**
 * The project whose database this is.
 *
 * `create` names the database after the project, so the name is the only handle the
 * CLI has. It is asked for rather than remembered because nothing writes a config
 * file yet, and inventing one to hold a single string would be a file to keep in step
 * with an account.
 */
export const DEFAULT_PROJECT = 'baseclf';

export const POLICY_USAGE = [
  'baseclf policy apply <file>     Store the policy document in this file',
  'baseclf policy list             Show which tables are exposed, and how many rules each has',
  'baseclf policy rm <table>       Stop exposing a table, and delete its rules',
  '',
  'Options:',
  '  --project <name>   Which deployment. Defaults to "baseclf", the same default',
  '                     create-baseclf uses, which is also the database name.',
  '  --confirm          Required by rm. Deleting rules is not undoable.',
  '',
  'A document looks like this:',
  '',
  '  {',
  '    "table": "posts",',
  '    "enabled": true,',
  '    "policies": [',
  '      { "name": "read_own", "for": "select", "to": ["authenticated"],',
  '        "using": { "author_id": { "_eq": "$auth.uid" } },',
  '        "columns": ["id", "title", "body"] }',
  '    ]',
  '  }',
  '',
  'Applying is safe to repeat. It replaces every rule on that table, and while it',
  'runs the table is not exposed at all, so an interrupted run leaves it closed',
  'rather than half open.',
].join('\n');

interface Options {
  readonly project: string;
  readonly confirm: boolean;
  readonly rest: readonly string[];
}

/**
 * Read the flags.
 *
 * Unknown options are refused rather than ignored. A misspelled `--project` that was
 * skipped would write policies into whichever deployment the default names, which is
 * the kind of mistake that is only noticed from the other side.
 */
export function parseOptions(argv: readonly string[]): Options | { readonly error: string } {
  let project = DEFAULT_PROJECT;
  let confirm = false;
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';

    if (argument === '--confirm') {
      confirm = true;
      continue;
    }

    if (argument === '--project') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        return { error: '--project needs a name after it.' };
      }
      project = value;
      index += 1;
      continue;
    }

    if (argument.startsWith('-')) {
      return { error: `There is no "${argument}" option.` };
    }

    rest.push(argument);
  }

  return { project, confirm, rest };
}

/** Open the database this project deployed to, or explain why not. */
async function endpointFor(
  host: PolicyHost,
  credentials: D1Credentials,
  project: string,
  write: Write,
  style: Style,
): Promise<D1Endpoint | null> {
  const database = await findDatabase(host.fetcher, credentials, project);

  if (database === null) {
    write(styledResultLine('deny', `No database called "${project}" on this account.`, style));
    write(note('That is the project name create-baseclf asked for. Pass a different one'));
    write(note('with --project, or run create-baseclf first.'));
    return null;
  }

  return { fetcher: host.fetcher, credentials, databaseId: database.uuid };
}

/** The version currently stored for a table, or null when it is not exposed. */
async function storedVersion(endpoint: D1Endpoint, table: string): Promise<number | null> {
  const [first] = await runSql(
    endpoint,
    'SELECT "version" FROM "_exposed_tables" WHERE "table_name" = ?',
    [table],
  );

  const row = first?.rows[0] as { version?: number } | undefined;
  return row?.version ?? null;
}

/**
 * Read and parse the document, before anything asks the network for anything.
 *
 * 🔴 Called before the credential is resolved and before the database is looked up,
 * and an earlier version was not. The difference is not efficiency. A document naming
 * `$auth.user.*` used to cost a round trip first, and if the project name happened to
 * be wrong as well the reader was told there was no such database, which is true and
 * is not the problem they have. The first thing that is wrong should be the thing
 * that gets reported.
 *
 * A test asserts the request count here rather than the statement count, because the
 * database lookup carries no SQL and counting statements passed either way.
 */
function loadDocument(
  host: PolicyHost,
  file: string,
  write: Write,
  style: Style,
): ReturnType<typeof readPolicyDocument> | null {
  const text = host.readFile(file);
  if (text === undefined) {
    write(styledResultLine('deny', `There is no file at ${file}.`, style));
    return null;
  }

  try {
    return readPolicyDocument(text);
  } catch (cause) {
    write(styledResultLine('deny', 'That document was refused.', style));
    write(note(cause instanceof Error ? cause.message : String(cause)));
    return null;
  }
}

async function apply(
  endpoint: D1Endpoint,
  document: ReturnType<typeof readPolicyDocument>,
  write: Write,
  style: Style,
): Promise<PolicyOutcome> {
  const table = document.definition.table;

  let catalogue: Catalogue;
  try {
    catalogue = await introspect(restExecutor(endpoint));
  } catch (cause) {
    write(styledResultLine('deny', 'Could not read the database schema.', style));
    write(note(cause instanceof Error ? cause.message : String(cause)));
    return 'failed';
  }

  try {
    checkAgainstSchema(catalogue, document.definition);
  } catch (cause) {
    write(
      styledResultLine('deny', `That document does not match the schema of "${table}".`, style),
    );
    write(note(cause instanceof Error ? cause.message : String(cause)));
    return 'usage';
  }

  const version = nextVersion(await storedVersion(endpoint, table));
  const statements = writeStatements(document, version);

  // One statement per request, because the endpoint refuses parameters otherwise.
  // The first one closes the table and the last one opens it, so an interruption
  // anywhere in between leaves it closed.
  for (const [index, statement] of statements.entries()) {
    try {
      await runSql(endpoint, statement.sql, statement.params);
    } catch (cause) {
      // ⚠️ This used to end with "Nothing is left half applied", and that sentence
      // is not always true. Measured in `src/policy/registry-cache.test.ts`: if two
      // runs touch the same table at once, the one that loses the race fails here
      // with its rules already written and the other run's row exposing the table,
      // so the effective policy is the union of two documents nobody wrote.
      //
      // A reassurance that is usually right is worse than none, because the one time
      // it is wrong is the time somebody needed to look.
      write(styledResultLine('deny', `Stopped partway through, at step ${index + 1}.`, style));
      write(note(cause instanceof Error ? cause.message : String(cause)));
      write(note(`Run "baseclf policy list" before anything else, and check "${table}".`));
      write(note('If it is not exposed, the table is closed and running this again is safe.'));
      write(note('If it is exposed, something else wrote it while this ran. Apply again to'));
      write(note('replace whatever is there.'));
      return 'failed';
    }
  }

  const rules = document.definition.policies.length;
  write(
    styledResultLine(
      'allow',
      `"${table}" is exposed with ${rules} ${rules === 1 ? 'rule' : 'rules'}, version ${version}.`,
      style,
    ),
  );

  if (!document.definition.enabled) {
    write(note('The document says enabled is false, so nothing can reach it yet.'));
  }

  // 🔴 Said on every apply, not only when a policy is narrowed, because the command
  // cannot tell the difference: it does not read the policy it is replacing.
  //
  // Measured in `src/policy/registry-cache.test.ts`. A deployment that has already
  // loaded its registry keeps the old one until that isolate recycles, and nothing
  // reads the version to know better. Somebody who has just taken a column out of a
  // grant and been told it worked would otherwise stop watching.
  write(note('This reaches the deployment as its instances recycle, not instantly.'));
  write(note('Until then, requests may still be answered under the previous rules.'));

  return 'ok';
}

async function list(endpoint: D1Endpoint, write: Write, style: Style): Promise<PolicyOutcome> {
  // ⚠️ `.rows`, not the result itself. An earlier version of this destructured the
  // statement result as though it were the rows, and `as` bridged the difference
  // without a complaint from the type checker: `exposed.length` would have been
  // undefined and the loop below would have iterated nothing, reporting an account
  // with policies as an account with none. `rules/03` section D bans `as` across a
  // boundary for exactly this, and this is what it looks like when it happens.
  const [exposedResult] = await runSql(
    endpoint,
    'SELECT "table_name", "enabled", "version" FROM "_exposed_tables" ORDER BY "table_name"',
  );

  const [countResult] = await runSql(
    endpoint,
    'SELECT "table_name", COUNT(*) AS "n" FROM "_policies" GROUP BY "table_name"',
  );

  const counts = new Map(
    (countResult?.rows ?? []).map((row) => {
      const { table_name, n } = row as { table_name: string; n: number };
      return [table_name, n] as const;
    }),
  );

  const exposed = (exposedResult?.rows ?? []).map(
    (row) => row as { table_name: string; enabled: number; version: number },
  );

  if (exposed.length === 0) {
    write(styledResultLine('attention', 'No table is exposed.', style));
    write(note('Nothing can be read or written through /rest/v1 until one is.'));
    write(note('Write a document and run: baseclf policy apply <file>'));
    return 'ok';
  }

  for (const row of exposed) {
    const rules = counts.get(row.table_name) ?? 0;

    // A table with no rules is not a working table. Invariant I1 makes the engine
    // throw for it, so reporting it as exposed would be reporting the opposite of
    // what a request will get.
    const verdict = row.enabled === 1 && rules > 0 ? 'allow' : 'attention';
    const why =
      row.enabled !== 1
        ? 'disabled'
        : rules === 0
          ? 'no rules, so every request is refused'
          : `${rules} rules`;

    write(styledResultLine(verdict, `${row.table_name}: ${why}, version ${row.version}`, style));
  }

  return 'ok';
}

async function remove(
  endpoint: D1Endpoint,
  table: string,
  confirmed: boolean,
  write: Write,
  style: Style,
): Promise<PolicyOutcome> {
  if (!confirmed) {
    write(styledResultLine('attention', `This deletes every rule on "${table}".`, style));
    write(note('The rules are not stored anywhere else. Keep the document that made'));
    write(note('them, then run the same command again with --confirm.'));
    return 'usage';
  }

  // Same order as a write, and for the same reason: the table stops being reachable
  // before its rules go, never after.
  for (const sql of [
    'DELETE FROM "_exposed_tables" WHERE "table_name" = ?',
    'DELETE FROM "_policy_binds" WHERE "table_name" = ?',
    'DELETE FROM "_policies" WHERE "table_name" = ?',
  ]) {
    await runSql(endpoint, sql, [table]);
  }

  write(styledResultLine('allow', `"${table}" is no longer exposed.`, style));
  return 'ok';
}

/**
 * The command.
 *
 * Returns the outcome rather than an exit code, the same way the other subcommands
 * do, so the mapping from meaning to number stays in one place in `main.ts`.
 */
export async function runPolicy(
  argv: readonly string[],
  write: Write,
  style: Style,
  host: PolicyHost,
): Promise<PolicyOutcome> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    write(POLICY_USAGE);
    return argv.length === 0 ? 'usage' : 'ok';
  }

  const parsed = parseOptions(argv);
  if ('error' in parsed) {
    write(`baseclf policy: ${parsed.error}\n\n${POLICY_USAGE}`);
    return 'usage';
  }

  const [verb, target] = parsed.rest;

  if (verb !== 'apply' && verb !== 'list' && verb !== 'rm') {
    write(
      verb === undefined
        ? `baseclf policy needs a verb.\n\n${POLICY_USAGE}`
        : `baseclf policy: there is no "${verb}" verb.\n\n${POLICY_USAGE}`,
    );
    return 'usage';
  }

  if (verb !== 'list' && target === undefined) {
    write(`baseclf policy ${verb} needs ${verb === 'apply' ? 'a file' : 'a table name'}.`);
    return 'usage';
  }

  // Before the credential and before the lookup. See `loadDocument`.
  const document = verb === 'apply' ? loadDocument(host, target ?? '', write, style) : null;
  if (verb === 'apply' && document === null) return 'usage';

  const resolved = await host.credentials();
  if (resolved === null) return 'failed';
  for (const warning of resolved.warnings) write(note(warning));

  const endpoint = await endpointFor(host, resolved.credentials, parsed.project, write, style);
  if (endpoint === null) return 'failed';

  try {
    if (verb === 'list') return await list(endpoint, write, style);
    if (verb === 'rm') return await remove(endpoint, target ?? '', parsed.confirm, write, style);

    if (document === null) return 'usage';
    const outcome = await apply(endpoint, document, write, style);

    if (outcome === 'ok') {
      // ⚠️ The table comes from the document, not from the arguments. An earlier
      // version read `parsed.rest[1]`, which is the path to the file, and then
      // decided the value looked like a filename and printed `your-table` instead.
      // The one thing this line could say for certain, it left out. Found by
      // reading the output of a real run rather than by any test, because every
      // test asserted the command's outcome and none read the sentence.
      write(
        nextAction({
          goal: 'see it working',
          steps: ['Ask the deployment for the table, as somebody who is not signed in:'],
          copy: `curl https://${parsed.project}.<your-subdomain>.workers.dev/rest/v1/${document.definition.table}`,
          verify: 'baseclf policy list',
        }),
      );
    }

    return outcome;
  } catch (cause) {
    write(styledResultLine('deny', 'The database refused that.', style));
    write(note(cause instanceof Error ? cause.message : String(cause)));
    return 'failed';
  }
}

/** Every fixed string this command can print, for the voice rules to check. */
export const POLICY_FIXED_TEXT: readonly string[] = Object.freeze([POLICY_USAGE]);
