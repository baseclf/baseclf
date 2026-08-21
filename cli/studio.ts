/**
 * `baseclf studio`: the local half of the simulator, decision Q3.
 *
 * The Studio page compiles through `/mcp` and deliberately never touches data.
 * Rows come from here instead: a bridge on 127.0.0.1 that holds the operator's
 * own Cloudflare credential and answers one question, "what would this caller
 * be shown". The browser talks to the deployment for SQL and to this process
 * for rows, and the credential never reaches the page.
 *
 * ## What crosses the boundary, and what never does
 *
 * The page sends the same input `policy_simulate` takes: a table, a role, and
 * claims. Never SQL. The bridge loads the deployment's own catalogue and
 * registry over the D1 REST API and runs the engine's own read path, so what
 * executes is what the deployment would execute, compiled here by the same
 * code. Accepting a statement instead would make this a run-anything endpoint
 * one XSS away from the page, which is why it is not expressible.
 *
 * ## Reads only
 *
 * `select` is the only operation. The compiled SQL for a write is already on
 * screen; running it would change the operator's data, and a simulator that
 * writes is not a simulator.
 *
 * ## The key
 *
 * Anything on the machine can reach 127.0.0.1, including other pages in the
 * same browser. Every run therefore carries a key generated for this session
 * and printed once, compared in constant time. A request without it is refused
 * before anything holding a credential is touched.
 *
 * ## The lane this rides
 *
 * The D1 REST API, which `rules/01` section E is explicit is not a data plane.
 * Correct here for the same reason it is correct for `policy apply`: one
 * operator, their own machine, their own database, one click at a time. The
 * account-wide ceiling is 1,200 requests per five minutes, and each run costs
 * three.
 */

import type { D1Executor } from '../src/db/dialect.js';
import { introspect } from '../src/db/introspect.js';
import { loadRegistry } from '../src/policy/registry.js';
import { readTable } from '../src/rest/router.js';
import { BaseclfError } from '../src/utils/errors.js';
import { restExecutor } from './d1-api.js';
import { copyable, note, type Style, styledResultLine } from './output.js';
import { DEFAULT_PROJECT, endpointFor, type PolicyHost, type PolicyOutcome } from './policy.js';

type Write = (text: string) => void;

export const STUDIO_USAGE = [
  'baseclf studio            Start the local result bridge for the Studio simulator',
  '',
  'Options:',
  '  --project <name>   Which deployment. Defaults to "baseclf", the same default',
  '                     create-baseclf uses, which is also the database name.',
  '  --port <number>    Where the bridge listens on 127.0.0.1. Defaults to 4000.',
  '',
  'The Studio compiles a request into SQL through your deployment and never touches',
  'data. This bridge is where rows come from: it holds your Cloudflare credential,',
  'runs the same read the deployment would run, and answers the page on this',
  'machine only. It runs reads only, and every request needs the key it prints.',
].join('\n');

const READS_ONLY =
  'The bridge runs reads only. The compiled SQL for a write is already on screen, and running it would change your data.';

const CLOSE_HINT =
  'Reads only, on this machine only. Every run costs three requests against the D1 REST ceiling of 1,200 per five minutes. Stop it with Ctrl+C.';

/** Every fixed sentence this command can print, for the voice rules. */
export const STUDIO_FIXED_TEXT: readonly string[] = Object.freeze([
  STUDIO_USAGE,
  READS_ONLY,
  CLOSE_HINT,
]);

/** How many rows a run returns. Display-sized: the point is the difference between roles. */
const ROW_LIMIT = 50;

export interface BridgeRequest {
  readonly method: string;
  readonly path: string;
  readonly header: (name: string) => string | null;
  readonly bodyText: string;
}

export interface BridgeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type BridgeHandler = (request: BridgeRequest) => Promise<BridgeResponse>;

export interface StudioHost extends PolicyHost {
  /**
   * Bind the handler to 127.0.0.1 on this port. Resolving with `untilClosed`
   * is what lets the command print its instructions before it starts waiting.
   */
  readonly serve: (
    port: number,
    handler: BridgeHandler,
  ) => Promise<{ untilClosed: Promise<void> } | { error: string }>;
}

/**
 * Whether two keys match, in constant time.
 *
 * Digest both and compare every byte. `crypto.subtle.timingSafeEqual` is
 * workerd-only and this runs under Node, so the loop is written out; comparing
 * digests rather than the strings keeps the work independent of where they
 * first differ.
 */
async function keysMatch(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);

  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type, x-bridge-key',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-max-age': '600',
  };
}

function answer(status: number, origin: string, body: Record<string, unknown>): BridgeResponse {
  return {
    status,
    headers: { ...corsHeaders(origin), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** A plain object, or nothing. Claims are the caller's hypothesis, never logged. */
function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The bridge itself, separated from the server so a test can hand it requests.
 *
 * The key is checked before anything else runs: a request that fails it never
 * touches the executor, which is the object holding the credential.
 */
export function createBridge(options: {
  readonly key: string;
  readonly openExecutor: () => D1Executor;
  readonly log: (line: string) => void;
}): BridgeHandler {
  return async (request) => {
    const origin = request.header('origin') ?? '*';

    if (request.method === 'OPTIONS') {
      return { status: 204, headers: corsHeaders(origin), body: '' };
    }

    if (request.method !== 'POST' || request.path !== '/run') {
      return answer(404, origin, { error: 'Not found.' });
    }

    if (!(await keysMatch(request.header('x-bridge-key') ?? '', options.key))) {
      options.log('refused a run: the key did not match');
      return answer(401, origin, { error: 'The bridge refused the key.' });
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(request.bodyText) as Record<string, unknown>;
    } catch {
      return answer(400, origin, { error: 'The request body has to be JSON.' });
    }

    const table = asOptionalString(parsed.table);
    const role = asOptionalString(parsed.role);
    if (table === null || role === null) {
      return answer(400, origin, { error: 'A table and a role are required.' });
    }
    if (parsed.operation !== undefined && parsed.operation !== 'select') {
      return answer(400, origin, { error: READS_ONLY });
    }

    const claims = asPlainObject(parsed.claims) ?? {};
    const auth = Object.freeze({
      role,
      uid: asOptionalString(claims.uid),
      email: asOptionalString(claims.email),
      app: Object.freeze(asPlainObject(claims.app) ?? {}),
    });

    try {
      const executor = options.openExecutor();
      const [catalogue, registry] = await Promise.all([
        introspect(executor),
        loadRegistry(executor),
      ]);

      const result = await readTable<Record<string, unknown>>({
        executor,
        catalogue,
        registry,
        auth,
        table,
        search: new URLSearchParams(`limit=${ROW_LIMIT}`),
      });

      options.log(`ran select on "${table}" as ${role}: ${result.rows.length} row(s)`);
      return answer(200, origin, {
        rows: result.rows,
        rowsRead: result.rowsRead,
        limit: ROW_LIMIT,
      });
    } catch (cause) {
      if (cause instanceof BaseclfError) {
        // The engine said no, which for a simulator is an answer rather than a
        // failure. The message is the client-safe one the deployment would send.
        options.log(`refused select on "${table}" as ${role}`);
        return answer(200, origin, { refusal: cause.message });
      }
      options.log('a run failed before the engine answered');
      return answer(500, origin, { error: 'The deployment could not be read.' });
    }
  };
}

interface StudioOptions {
  readonly project: string;
  readonly port: number;
}

function parseStudioOptions(argv: readonly string[]): StudioOptions | { readonly error: string } {
  let project = DEFAULT_PROJECT;
  let port = 4000;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';

    if (argument === '--project') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        return { error: '--project needs a name after it.' };
      }
      project = value;
      index += 1;
      continue;
    }

    if (argument === '--port') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 65_535) {
        return { error: '--port needs a number between 1 and 65535 after it.' };
      }
      port = value;
      index += 1;
      continue;
    }

    return { error: `"${argument}" is not an option this command has.` };
  }

  return { project, port };
}

/** The command. Same host as `policy`, plus somewhere to bind a listener. */
export async function runStudio(
  argv: readonly string[],
  write: Write,
  style: Style,
  host: StudioHost,
): Promise<PolicyOutcome> {
  if (argv.includes('--help') || argv.includes('-h')) {
    write(STUDIO_USAGE);
    return 'ok';
  }

  const parsed = parseStudioOptions(argv);
  if ('error' in parsed) {
    write(`baseclf studio: ${parsed.error}\n\n${STUDIO_USAGE}`);
    return 'usage';
  }

  const resolved = await host.credentials();
  if (resolved === null) return 'failed';
  for (const warning of resolved.warnings) write(note(warning));

  const endpoint = await endpointFor(host, resolved.credentials, parsed.project, write, style);
  if (endpoint === null) return 'failed';

  const key = host.newId();
  const handler = createBridge({
    key,
    openExecutor: () => restExecutor(endpoint),
    log: (line) => write(note(line)),
  });

  const server = await host.serve(parsed.port, handler);
  if ('error' in server) {
    write(
      styledResultLine(
        'deny',
        `Could not listen on 127.0.0.1:${parsed.port}. ${server.error}`,
        style,
      ),
    );
    return 'failed';
  }

  write(
    styledResultLine('allow', `The result bridge is listening on 127.0.0.1:${parsed.port}.`, style),
  );
  write('Paste this key into the Result panel of the Studio simulator:');
  write('');
  write(copyable(key));
  write('');
  write(note(CLOSE_HINT));

  await server.untilClosed;
  return 'ok';
}
