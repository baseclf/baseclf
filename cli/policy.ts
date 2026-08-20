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
 *      measured in `src/policy/registry-cache.test.ts`, nothing reads the version at
 *      all. What the engine has now is an expiry, `MAX_REGISTRY_AGE_MS`, so a change
 *      lands within about half a minute rather than whenever an isolate recycles.
 *      That bound belongs to the **deployed** engine, and this command cannot see
 *      which version answers, so it says both. An operator who **narrows** a policy
 *      is the one who needs telling.
 *
 * ⚠️ Everything here goes over the D1 REST API, which `rules/01` section E is explicit
 * is not a data plane. That is correct for this and only this: one administrator, on
 * their own machine, changing their own policies.
 */

import type { Catalogue } from '../src/db/introspect.js';
import { introspect } from '../src/db/introspect.js';
import { type LintFinding, lintTable } from '../src/policy/lint.js';
import { loadRegistry } from '../src/policy/registry.js';
import { POLICY_SCHEMA } from '../src/policy/schema.js';
import type { TableDefinition } from '../src/policy/types.js';
import { BaseclfError } from '../src/utils/errors.js';
import { MAX_REGISTRY_AGE_MS } from '../src/utils/memo.js';
import {
  type D1Credentials,
  type D1Endpoint,
  type Fetcher,
  findDatabase,
  restExecutor,
  runSql,
} from './d1-api.js';
import { copyable, nextAction, note, type Style, styledResultLine } from './output.js';
import {
  acquireLockStatement,
  checkAgainstSchema,
  nextVersion,
  POLICY_LOCK_SECONDS,
  readPolicyDocument,
  releaseLockStatement,
  writeStatements,
} from './policy-document.js';

type Write = (text: string) => void;

export type PolicyOutcome = 'ok' | 'usage' | 'failed';

export interface PolicyHost {
  readonly fetcher: Fetcher;
  /** The document, read at the edge. Undefined when there is no such file. */
  readonly readFile: (path: string) => string | undefined;
  /**
   * A value no other run of this command will produce.
   *
   * It names the holder of the write lock, so it has to be unique across machines and
   * across runs on one machine. Supplied by the host rather than generated here so a
   * test can say what it will be, which is what lets an assertion look at the guard on
   * the statement that exposes the table.
   */
  readonly newId: () => string;
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
  'baseclf policy lint             Report what the stored policies will cost to run',
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

/** Open the database this project deployed to, or explain why not. Shared with `user.ts`. */
export async function endpointFor(
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
 * Print what the linter found, or nothing at all when it found nothing.
 *
 * ⚠️ Warnings, never a refusal, and never an exit code. `src/policy/lint.ts` says why
 * at length: these findings are about money and about surprise, not about who may read
 * what, and refusing a policy that grants exactly what its author meant would be the
 * engine overruling them on a question they are allowed to be wrong about.
 *
 * The remedy goes on its own line, unindented, because that is the line somebody
 * double-clicks. A `CREATE INDEX` with two spaces in front of it does not copy
 * cleanly, and the person who pastes the spaces gets a syntax error from D1 with
 * nothing to explain it.
 */
function writeFindings(findings: readonly LintFinding[], write: Write, style: Style): void {
  if (findings.length === 0) return;

  // 🔴 One statement per distinct remedy, however many policies asked for it. Found
  // by running the command rather than by a test: two policies on the same table both
  // compared `author_id`, so the identical `CREATE INDEX` was printed twice, and the
  // reader who runs both gets an error from D1 on the second saying the index already
  // exists. Every test asserted that the statement appeared, and none counted them.
  //
  // The finding stays per policy, because which policies are paying for a missing
  // index is worth knowing. It is the remedy that is per index.
  const printed = new Set<string>();

  write('');
  for (const finding of findings) {
    write(styledResultLine('attention', `${finding.policy}: ${finding.detail}`, style));

    // `copyable` supplies the blank line on each side. Adding more here was the first
    // version, and it doubled them.
    if (finding.remedy !== undefined && !printed.has(finding.remedy)) {
      printed.add(finding.remedy);
      write(copyable(finding.remedy));
    }
  }
}

/**
 * What a change to the stored policies has not done yet.
 *
 * Both `apply` and `rm` say this, and it is one function so that the two cannot drift
 * into disagreeing about how the product behaves. The last sentence differs because
 * the rules still in force differ: an apply leaves the previous document running, and
 * an rm leaves the document it deleted running.
 *
 * ⚠️ Two sentences rather than one, and the second is the awkward one that has to be
 * there. The window is a property of the **deployed engine**, not of this command, and
 * this command cannot see which version is deployed. Saying only "thirty seconds"
 * would be a promise on behalf of a deployment that may predate the bound existing,
 * made to somebody who is revoking access.
 *
 * The number comes from the engine's own constant rather than from prose here, so the
 * two cannot say different things.
 */
function writeNotImmediate(write: Write, stillInForce: string): void {
  const seconds = Math.round(MAX_REGISTRY_AGE_MS / 1000);

  // ⚠️ The line break is placed rather than left to fall where it lands. The first
  // draft split between the number and its unit, so the terminal showed "about 30" at
  // the end of one line and "seconds" at the start of the next. Found by running the
  // command and reading it, which is the only thing that finds this.
  write(note('Not instant. A deployment on this version re-reads its policies within'));
  write(note(`about ${seconds} seconds. An older one waits to recycle instead, with no bound.`));
  write(note(stillInForce));
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

/**
 * Give the lock back, and never fail the run over it.
 *
 * ⚠️ Swallowed on purpose, which is the opposite of how everything else here treats a
 * database error. A release that fails leaves a row that expires on its own within
 * `POLICY_LOCK_SECONDS`, so the cost is a wait. Turning that into a failure would
 * report a successful apply as a failed one, and the reader would apply again over a
 * result that was already correct.
 */
async function releaseLock(endpoint: D1Endpoint, table: string, holder: string): Promise<void> {
  const release = releaseLockStatement(table, holder);
  try {
    await runSql(endpoint, release.sql, release.params);
  } catch {
    // Expires by itself. See above.
  }
}

/**
 * What to show the operator when the engine refuses their document.
 *
 * 🔴 `detail` rather than `message`, and the reason is that this is a terminal and
 * not an HTTP response. The engine splits the two on purpose: `message` is what a
 * caller over HTTP may see, and `detail` names the column or the table, which
 * invariants I5 and I9 keep off the wire because telling "does not exist" apart
 * from "not yours" is how somebody maps a schema they have no rights to.
 *
 * None of that applies here. This runs on the machine of the person who owns the
 * deployment, against their own database, under their own credential. There is
 * nobody to withhold it from, and withholding it turns
 *
 *   Policy document refers to something that does not exist.
 *
 * into a message that cannot be acted on, when the engine already produced
 *
 *   Policy "read_published" names column "autor_id" on table "posts", which does
 *   not exist. Matching is exact and case sensitive.
 *
 * Measured on 2026-08-14: an operator hit the first form and could not tell whether
 * the table was missing or a column name was wrong.
 */
function explain(cause: unknown): string {
  if (cause instanceof BaseclfError && cause.detail !== undefined) return cause.detail;
  return cause instanceof Error ? cause.message : String(cause);
}

async function apply(
  endpoint: D1Endpoint,
  document: ReturnType<typeof readPolicyDocument>,
  host: PolicyHost,
  write: Write,
  style: Style,
): Promise<PolicyOutcome> {
  const table = document.definition.table;

  let catalogue: Catalogue;
  try {
    catalogue = await introspect(restExecutor(endpoint));
  } catch (cause) {
    write(styledResultLine('deny', 'Could not read the database schema.', style));
    write(note(explain(cause)));
    return 'failed';
  }

  try {
    checkAgainstSchema(catalogue, document.definition);
  } catch (cause) {
    write(
      styledResultLine('deny', `That document does not match the schema of "${table}".`, style),
    );
    write(note(explain(cause)));
    return 'usage';
  }

  // 🔴 The whole engine schema, not just the lock table, and the difference is the
  // one this got wrong. The Worker creates these tables, but only on a request to
  // `/rest/v1` or `/storage/v1`: `/health` and `/_schema` deliberately do not pay
  // for it. So a deployment that has been created and checked but never asked for
  // data has no `_exposed_tables`, and this command used to fail against it with a
  // raw SQLite error naming a table the reader has never heard of.
  //
  // Measured on 2026-08-14 on a fresh deployment, after `doctor` had reported the
  // engine tables present. `IF NOT EXISTS` throughout, from the engine's own
  // constant, so there is one definition and running it twice costs nothing.
  for (const statement of POLICY_SCHEMA) await runSql(endpoint, statement);

  const holder = host.newId();
  const lock = acquireLockStatement(table, holder);
  const [taken] = await runSql(endpoint, lock.sql, lock.params);

  if ((taken?.rows.length ?? 0) === 0) {
    // 🔴 Debt F3. Refused before anything is deleted, so a run that loses here has
    // changed nothing at all rather than leaving its rules beside somebody else's.
    write(styledResultLine('deny', `Another apply is working on "${table}".`, style));
    // The number stays early in the line so a longer one cannot be orphaned from its
    // unit at the wrap, which is a mistake this file has already made once.
    write(note(`A lock is held for ${POLICY_LOCK_SECONDS} seconds at most. If the run that`));
    write(note('took it has stopped, this clears on its own and running this again'));
    write(note('after that is safe. Nothing here has been changed.'));
    return 'failed';
  }

  const version = nextVersion(await storedVersion(endpoint, table));
  const statements = writeStatements(document, version, holder);

  // One statement per request, because the endpoint refuses parameters otherwise.
  // The first one closes the table and the last one opens it, so an interruption
  // anywhere in between leaves it closed.
  let exposed = false;
  for (const [index, statement] of statements.entries()) {
    try {
      const [result] = await runSql(endpoint, statement.sql, statement.params);
      // The last statement is guarded on still holding the lock and returns the table
      // name when it wrote. Every other one returns nothing and is not asked.
      if (index === statements.length - 1) exposed = (result?.rows.length ?? 0) > 0;
    } catch (cause) {
      // ⚠️ This used to end with "Nothing is left half applied", which was not always
      // true, and then with an explanation of the union it could leave behind. Neither
      // applies now: the lock means nothing else is writing this table, so a failure
      // here leaves the table closed with this run's rules half written, and running
      // it again replaces them.
      write(styledResultLine('deny', `Stopped partway through, at step ${index + 1}.`, style));
      write(note(cause instanceof Error ? cause.message : String(cause)));
      write(note(`"${table}" is not exposed, which is the safe half of this. Run this`));
      write(note('again once the cause is fixed.'));
      await releaseLock(endpoint, table, holder);
      return 'failed';
    }
  }

  await releaseLock(endpoint, table, holder);

  if (!exposed) {
    // The guard on the last statement refused. Somebody took the lock while this run
    // was working, finished, and this run's rules were replaced by theirs on the way
    // past. Nothing here is half applied: their document is what is exposed.
    write(styledResultLine('deny', `Another apply overtook this one on "${table}".`, style));
    write(note('Nothing from this document is exposed. Run "baseclf policy list" to see'));
    write(note('what is, then apply again if it is not what you want.'));
    return 'failed';
  }

  const rules = document.definition.policies.length;
  write(
    styledResultLine(
      'allow',
      `"${table}" is exposed with ${rules} ${rules === 1 ? 'rule' : 'rules'}, version ${version}.`,
      style,
    ),
  );

  // After the write rather than before it, and that is the difference between a lint
  // and a gate. The policy is stored either way; this is the moment the author is
  // still looking, which is the only moment a warning about a bill gets read.
  writeFindings(lintTable(catalogue, document.definition), write, style);

  if (!document.definition.enabled) {
    write(note('The document says enabled is false, so nothing can reach it yet.'));
  }

  // 🔴 Said on every apply, not only when a policy is narrowed, because the command
  // cannot tell the difference: it does not read the policy it is replacing.
  //
  // Measured in `src/policy/registry-cache.test.ts`. A deployment that has already
  // loaded its registry answers from that until it expires, and nothing reads the
  // version to know better. Somebody who has just taken a column out of a grant and
  // been told it worked would otherwise stop watching.
  writeNotImmediate(write, 'Until then, requests may still be answered under the previous rules.');

  return 'ok';
}

/**
 * Lint what is already stored, rather than what is being written.
 *
 * ⭐ Reads through `loadRegistry`, which is the engine's own loader, so it lints the
 * definitions the deployment will actually run: binds already expanded, every stored
 * row parsed by the same code that parses them at request time. A second reader here
 * would be a second opinion about what a stored policy means, and the two would drift
 * in the direction where this one is quieter.
 *
 * ⚠️ It reports nothing when a table is exposed with no rules. `policy list` is the
 * command that says so, and it says it as `attention` rather than as a lint finding,
 * because a table with no rules refuses every request rather than costing anything.
 */
async function lint(endpoint: D1Endpoint, write: Write, style: Style): Promise<PolicyOutcome> {
  const executor = restExecutor(endpoint);

  let catalogue: Catalogue;
  let definitions: ReadonlyMap<string, TableDefinition>;
  try {
    [catalogue, { definitions }] = await Promise.all([
      introspect(executor),
      loadRegistry(executor),
    ]);
  } catch (cause) {
    // `loadRegistry` refuses the whole registry when one row is unusable, so this is
    // also how somebody finds out that a deployment is refusing every table.
    write(styledResultLine('deny', 'Could not read the stored policies.', style));
    write(note(cause instanceof Error ? cause.message : String(cause)));
    return 'failed';
  }

  const findings = [...definitions.values()].flatMap((definition) =>
    lintTable(catalogue, definition).map((finding) => ({
      ...finding,
      policy: `${definition.table}.${finding.policy}`,
    })),
  );

  if (findings.length === 0) {
    write(styledResultLine('allow', 'Nothing to report.', style));
    write(note('Every policy column is indexed, and none of them is wide enough to'));
    write(note('worry about. This does not run the query planner, so a policy it is'));
    write(note('quiet about can still be slow.'));
    return 'ok';
  }

  writeFindings(findings, write, style);
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

/**
 * The refusal for an `rm` that was not confirmed.
 *
 * ⚠️ The gate is in `runPolicy` and nowhere else, and a version of this had it in both
 * places. Two gates read as defence in depth and are not, because the inner one is
 * unreachable while the outer one holds: no test can tell whether it is still there,
 * so removing it breaks nothing that anybody would notice. That is the shape of debt
 * D3 in this project, where a second layer hid a bug in the first rather than
 * catching it.
 *
 * So `remove` no longer takes a `confirmed` argument. It cannot be handed one it
 * ignores, and the single gate is the one the tests and the mutations both point at.
 */
function refuseUnconfirmed(table: string, write: Write, style: Style): PolicyOutcome {
  write(styledResultLine('attention', `This deletes every rule on "${table}".`, style));
  write(note('The rules are not stored anywhere else. Keep the document that made'));
  write(note('them, then run the same command again with --confirm.'));
  return 'usage';
}

async function remove(
  endpoint: D1Endpoint,
  table: string,
  write: Write,
  style: Style,
): Promise<PolicyOutcome> {
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

  // 🔴 Said here for the same reason `apply` says it, and this is the command that
  // needed it most. `apply` warns on every run because it cannot tell whether the new
  // document is narrower than the one it replaced. `rm` always is: it takes a table
  // from exposed to not exposed, which is the largest narrowing available.
  //
  // Measured against a real deployment on 2026-08-12, twice, and the spread was the
  // result rather than either number. One run was still serving the removed table to
  // anonymous callers 393 seconds after this line reported success; another stopped
  // after 57. Nothing in the product moved between them: it was however long the
  // isolate holding the old registry happened to live.
  //
  // That measurement is why `MAX_REGISTRY_AGE_MS` exists, and it is also why the text
  // below still names the older behaviour. The bound is in the engine, this command
  // talks to whichever engine is deployed, and the deployment those numbers came from
  // is one of the ones without it.
  //
  // Left out of the first version of this command, which is how somebody revoking
  // access in a hurry would have been told it was done.
  writeNotImmediate(write, 'Until then, the table may still answer under the rules just deleted.');

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

  if (verb !== 'apply' && verb !== 'list' && verb !== 'lint' && verb !== 'rm') {
    write(
      verb === undefined
        ? `baseclf policy needs a verb.\n\n${POLICY_USAGE}`
        : `baseclf policy: there is no "${verb}" verb.\n\n${POLICY_USAGE}`,
    );
    return 'usage';
  }

  if (verb !== 'list' && verb !== 'lint' && target === undefined) {
    write(`baseclf policy ${verb} needs ${verb === 'apply' ? 'a file' : 'a table name'}.`);
    return 'usage';
  }

  // Before the credential and before the lookup. See `loadDocument`.
  const document = verb === 'apply' ? loadDocument(host, target ?? '', write, style) : null;
  if (verb === 'apply' && document === null) return 'usage';

  // The same rule, applied to the other branch, and it was not here at first.
  // Whether `--confirm` was passed is knowable with no network at all, so asking for a
  // credential first meant a reader who forgot the flag and whose login had expired
  // was told to log in, for a command that was never going to delete anything. The
  // first thing that is wrong should be the thing that gets reported.
  if (verb === 'rm' && !parsed.confirm) return refuseUnconfirmed(target ?? '', write, style);

  const resolved = await host.credentials();
  if (resolved === null) return 'failed';
  for (const warning of resolved.warnings) write(note(warning));

  const endpoint = await endpointFor(host, resolved.credentials, parsed.project, write, style);
  if (endpoint === null) return 'failed';

  try {
    if (verb === 'list') return await list(endpoint, write, style);
    if (verb === 'lint') return await lint(endpoint, write, style);
    if (verb === 'rm') return await remove(endpoint, target ?? '', write, style);

    if (document === null) return 'usage';
    const outcome = await apply(endpoint, document, host, write, style);

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
