/**
 * `baseclf user set-app`: put server-set claims on one user.
 *
 * `$auth.app.*` is the metadata a policy may trust, and it may trust it only
 * because the end user cannot write it. So the write path is this command and
 * nothing else: the operator's own machine, the operator's own Cloudflare
 * credential, over the D1 REST API. There is deliberately no HTTP surface on
 * the Worker that writes these rows, because an endpoint that grants claims is
 * an escalation surface the product does not need to have.
 *
 * Ordering is the same discipline `policy apply` follows: the document is
 * validated by the engine's own validator before any credential is resolved and
 * before anything goes over the network, so the first thing that is wrong is
 * the thing that gets reported.
 */

import { APP_METADATA_SCHEMA, upsertAppMetadataStatement } from '../src/auth/app-metadata.js';
import { BaseclfError } from '../src/utils/errors.js';
import { runSql } from './d1-api.js';
import { note, type Style, styledResultLine } from './output.js';
import { endpointFor, type PolicyHost, type PolicyOutcome, parseOptions } from './policy.js';

type Write = (text: string) => void;

export const USER_USAGE = [
  'baseclf user set-app <user-id> <file>   Store the claims in this JSON file for one user',
  '',
  'Options:',
  '  --project <name>   Which deployment. Defaults to "baseclf", the same default',
  '                     create-baseclf uses, which is also the database name.',
  '',
  'The file is one JSON object. Policies read it as $auth.app.<name>:',
  '',
  '  { "plan": "pro", "region": "apac" }',
  '',
  'Applying replaces the whole record for that user. The claims land in the next',
  'token the user is minted; tokens live fifteen minutes, so a change is complete',
  'within that without a redeploy. The user id is the "sub" claim in their JWT.',
].join('\n');

const LANDS_WITHIN = [
  'Lands in the next token this user exchanges their session for. Tokens live',
  'fifteen minutes, so the change is complete within that; nothing redeploys.',
].join(' ');

/** Every fixed sentence this command can print, for the voice rules. */
export const USER_FIXED_TEXT: readonly string[] = Object.freeze([USER_USAGE, LANDS_WITHIN]);

/**
 * The command. Takes the same host as `policy`, because it needs exactly the
 * same four things: a fetcher, a file reader, and a resolved credential. A
 * second host shape would be a second implementation of one judgement.
 */
export async function runUser(
  argv: readonly string[],
  write: Write,
  style: Style,
  host: PolicyHost,
): Promise<PolicyOutcome> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    write(USER_USAGE);
    return argv.length === 0 ? 'usage' : 'ok';
  }

  const parsed = parseOptions(argv);
  if ('error' in parsed) {
    write(`baseclf user: ${parsed.error}\n\n${USER_USAGE}`);
    return 'usage';
  }

  const [verb, userId, file] = parsed.rest;

  if (verb !== 'set-app') {
    write(
      verb === undefined
        ? `baseclf user needs a verb. The only one is "set-app".\n\n${USER_USAGE}`
        : `baseclf user: there is no "${verb}" verb.\n\n${USER_USAGE}`,
    );
    return 'usage';
  }

  if (userId === undefined || file === undefined) {
    write(`baseclf user set-app needs a user id and a file.\n\n${USER_USAGE}`);
    return 'usage';
  }

  // Everything knowable without a network round trip is decided first.
  const raw = host.readFile(file);
  if (raw === undefined) {
    write(styledResultLine('deny', `There is no file at "${file}".`, style));
    return 'usage';
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    write(styledResultLine('deny', `"${file}" is not JSON: ${reason}`, style));
    return 'usage';
  }

  // The engine's validator, not a copy of it. A refused document has not
  // touched the network and will never reach the database.
  let statement: ReturnType<typeof upsertAppMetadataStatement>;
  try {
    statement = upsertAppMetadataStatement(userId, document);
  } catch (cause) {
    const reason = cause instanceof BaseclfError ? cause.message : String(cause);
    write(styledResultLine('deny', reason, style));
    return 'usage';
  }

  const resolved = await host.credentials();
  if (resolved === null) return 'failed';
  for (const warning of resolved.warnings) write(note(warning));

  const endpoint = await endpointFor(host, resolved.credentials, parsed.project, write, style);
  if (endpoint === null) return 'failed';

  try {
    // The floor, not the plan: a deployment provisioned before this table
    // existed has no row to update and no table to hold one. IF NOT EXISTS
    // throughout, from the engine's own constant.
    for (const ddl of APP_METADATA_SCHEMA) await runSql(endpoint, ddl);

    // A claim stored under a mistyped id is not an error anywhere, ever: it
    // sits in the table and no token ever reads it. Refusing here is the only
    // place the mistake can be caught.
    const [found] = await runSql(endpoint, 'SELECT id FROM user WHERE id = ?1', [userId]);
    if ((found?.rows.length ?? 0) === 0) {
      write(
        styledResultLine(
          'deny',
          `No user "${userId}" on this deployment. The id is the "sub" claim in their token.`,
          style,
        ),
      );
      return 'failed';
    }

    await runSql(endpoint, statement.sql, statement.parameters);

    const names = Object.keys(document as Record<string, unknown>);
    const listed = names.length === 0 ? 'an empty record' : names.join(', ');
    write(
      styledResultLine(
        'allow',
        `Stored ${names.length === 1 ? 'one claim' : `${names.length} claims`} for that user: ${listed}.`,
        style,
      ),
    );
    write(note(LANDS_WITHIN));
    return 'ok';
  } catch (cause) {
    const reason =
      cause instanceof BaseclfError && cause.detail !== undefined
        ? cause.detail
        : cause instanceof Error
          ? cause.message
          : String(cause);
    write(styledResultLine('deny', `The deployment did not take the write: ${reason}`, style));
    return 'failed';
  }
}
