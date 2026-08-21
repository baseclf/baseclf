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
 * ## What the bridge will and will not do
 *
 * On `/run`, `select` is the only operation. The compiled SQL for a write is
 * already on screen; running it would change the operator's data, and a
 * simulator that writes is not a simulator.
 *
 * On `/apply`, the bridge stores a policy document the operator explicitly
 * submitted. The page sends the document text, never SQL, and the bridge runs
 * the exact code path `baseclf policy apply` runs: the engine's own validator
 * decides first (a document naming `$auth.user.*` is refused before anything
 * leaves this machine), then the CLI's apply takes the same lock, writes the
 * same close-first-open-last statements, and reports the same lint findings.
 * There is no second implementation to drift. Deleting rules stays with the
 * CLI and its typed `--confirm`.
 *
 * On `/document`, the bridge reads back the stored source document for one
 * table, so the editor edits what is actually running. Predicates reach the
 * operator's own page over loopback with the session key, which is the same
 * trust as the CLI reading their file; `policy_list` over the network still
 * withholds them.
 *
 * On `/rows`, the bridge reads one page of one application table as the
 * operator, newest first, no policy applied: the Tables screen's "did my data
 * land" question, answerable on a table nobody has exposed yet. The page
 * sends a table name and an offset, never SQL; `cli/browse.ts` holds the
 * statement, the refusals (engine tables stay CLI-only), and the scan
 * ceiling, since rows read is what D1 bills.
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
import { type Catalogue, introspect } from '../src/db/introspect.js';
import { loadRegistry } from '../src/policy/registry.js';
import { readTable } from '../src/rest/router.js';
import { BaseclfError } from '../src/utils/errors.js';
import { MAX_REGISTRY_AGE_MS } from '../src/utils/memo.js';
import { BROWSE_PAGE_SIZE, browseStatement } from './browse.js';
import { restExecutor } from './d1-api.js';
import { copyable, note, PLAIN, type Style, styledResultLine } from './output.js';
import {
  applyDocument as applyPolicyDocument,
  DEFAULT_PROJECT,
  endpointFor,
  type PolicyHost,
  type PolicyOutcome,
  readStoredDocument,
} from './policy.js';
import { type PolicyDocument, readPolicyDocument } from './policy-document.js';

type Write = (text: string) => void;

export const STUDIO_USAGE = [
  'baseclf studio            Start the local bridge for the Studio',
  '',
  'Options:',
  '  --project <name>   Which deployment. Defaults to "baseclf", the same default',
  '                     create-baseclf uses, which is also the database name.',
  '  --port <number>    Where the bridge listens on 127.0.0.1. Defaults to 4000.',
  '',
  'The Studio compiles a request into SQL through your deployment and never touches',
  'data. This bridge holds your Cloudflare credential and answers the page on this',
  'machine only: it runs the same read the deployment would run, and it applies a',
  'policy document you explicitly submit, through the same validation and the same',
  'steps as baseclf policy apply. Every request needs the key it prints.',
].join('\n');

const READS_ONLY =
  'The bridge runs reads only here. The compiled SQL for a write is already on screen, and running it would change your data.';

const CLOSE_HINT =
  'Reads, plus the policy documents you apply. On this machine only. Requests count against the D1 REST ceiling of 1,200 per five minutes. Stop it with Ctrl+C.';

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
  /** The query string, "?"-prefixed or empty, for routes that take one. */
  readonly search: string;
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
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    // Private Network Access. A public https page reaching into 127.0.0.1 is
    // exactly what this bridge is for, and Chromium gates that behind a
    // preflight the server has to opt into; without this header the fetch
    // dies before the bridge ever sees a request. Measured from the deployed
    // Studio on 2026-08-21; a localhost page never trips it, which is why no
    // local test could. The key remains the actual gate.
    'access-control-allow-private-network': 'true',
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

/** What one apply came back with: the CLI's own outcome and its printed lines. */
export interface BridgeApplyAnswer {
  readonly outcome: PolicyOutcome;
  readonly lines: readonly string[];
}

/**
 * The bridge itself, separated from the server so a test can hand it requests.
 *
 * The key is checked before anything else runs: a request that fails it never
 * touches the executor or the apply path, which are what hold the credential.
 */
export function createBridge(options: {
  readonly key: string;
  readonly openExecutor: () => D1Executor;
  /** The stored source document for a table, or null when it is not exposed. */
  readonly readDocument: (table: string) => Promise<Record<string, unknown> | null>;
  /**
   * Store one already-validated document, through the CLI's own apply.
   *
   * Takes the PARSED document on purpose: validation lives in the route, before
   * this is called, so a refused document provably never reaches the network.
   */
  readonly applyDocument: (document: PolicyDocument) => Promise<BridgeApplyAnswer>;
  readonly log: (line: string) => void;
}): BridgeHandler {
  // One catalogue per bridge process, refreshed on the engine's own clock.
  // /run rebuilds per request because a policy applied a moment ago has to be
  // simulated a moment later; a schema, unlike a policy, has no write lane
  // here, and a page turner re-reading it per click would pay the whole
  // PRAGMA sweep over a transport with no batch. A failed read is not kept.
  let rememberedCatalogue: { readonly at: number; readonly catalogue: Catalogue } | null = null;
  const catalogueFor = async (): Promise<Catalogue> => {
    if (rememberedCatalogue !== null && Date.now() - rememberedCatalogue.at < MAX_REGISTRY_AGE_MS) {
      return rememberedCatalogue.catalogue;
    }
    const catalogue = await introspect(options.openExecutor());
    rememberedCatalogue = { at: Date.now(), catalogue };
    return catalogue;
  };

  return async (request) => {
    const origin = request.header('origin') ?? '*';

    if (request.method === 'OPTIONS') {
      return { status: 204, headers: corsHeaders(origin), body: '' };
    }

    const route =
      request.method === 'POST' && request.path === '/run'
        ? 'run'
        : request.method === 'POST' && request.path === '/apply'
          ? 'apply'
          : request.method === 'GET' && request.path === '/document'
            ? 'document'
            : request.method === 'GET' && request.path === '/rows'
              ? 'rows'
              : null;

    if (route === null) {
      return answer(404, origin, { error: 'Not found.' });
    }

    if (!(await keysMatch(request.header('x-bridge-key') ?? '', options.key))) {
      options.log(`refused a ${route}: the key did not match`);
      return answer(401, origin, { error: 'The bridge refused the key.' });
    }

    if (route === 'document') {
      const table = new URLSearchParams(request.search).get('table') ?? '';
      if (table === '') {
        return answer(400, origin, { error: 'A table is required.' });
      }
      try {
        const document = await options.readDocument(table);
        options.log(`read the stored document for "${table}"`);
        return answer(200, origin, { document });
      } catch {
        options.log('a document read failed before it finished');
        return answer(500, origin, { error: 'The deployment could not be read.' });
      }
    }

    if (route === 'rows') {
      const params = new URLSearchParams(request.search);
      const table = params.get('table') ?? '';
      if (table === '') {
        return answer(400, origin, { error: 'A table is required.' });
      }
      const offset = Number(params.get('offset') ?? '0');

      try {
        const plan = browseStatement(await catalogueFor(), table, offset);
        if (!plan.ok) {
          options.log(`refused a browse of "${table}"`);
          return answer(400, origin, { error: plan.refusal });
        }

        const result = await options
          .openExecutor()
          .prepare(plan.sql)
          .bind(...plan.parameters)
          .all<Record<string, unknown>>();
        const rows = result.results ?? [];
        const scanned = (result.meta as { rows_read?: unknown } | undefined)?.rows_read;
        const rowsRead = typeof scanned === 'number' ? scanned : null;

        options.log(`browsed "${table}": ${rows.length} row(s), ${rowsRead ?? '?'} scanned`);
        return answer(200, origin, { rows, rowsRead, limit: BROWSE_PAGE_SIZE, offset });
      } catch {
        options.log('a row browse failed before it finished');
        return answer(500, origin, { error: 'The deployment could not be read.' });
      }
    }

    if (route === 'apply') {
      let text: string;
      try {
        const parsed = JSON.parse(request.bodyText) as Record<string, unknown>;
        text = typeof parsed.text === 'string' ? parsed.text : '';
      } catch {
        return answer(400, origin, { error: 'The request body has to be JSON.' });
      }
      if (text === '') {
        return answer(400, origin, { error: 'A document is required, as text.' });
      }

      // The engine's own validator, before anything touches the network. A
      // document it refuses, a forbidden claim included, ends here: the answer
      // carries the reason, and provably zero statements have left this machine.
      let document: PolicyDocument;
      try {
        document = readPolicyDocument(text);
      } catch (cause) {
        options.log('refused a document: the engine would not store it');
        return answer(400, origin, {
          refusal: cause instanceof Error ? cause.message : String(cause),
        });
      }

      try {
        const applied = await options.applyDocument(document);
        options.log(`applied a document to "${document.definition.table}": ${applied.outcome}`);
        return answer(200, origin, {
          applied: applied.outcome === 'ok',
          lines: applied.lines,
        });
      } catch {
        options.log('an apply failed before the CLI path answered');
        return answer(500, origin, { error: 'The deployment could not be written.' });
      }
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
    readDocument: (table) => readStoredDocument(endpoint, table),
    // The CLI's own apply, with its lines collected for the page instead of a
    // terminal. PLAIN on purpose: colour codes are for terminals, and these
    // lines end up rendered in a browser.
    applyDocument: async (document) => {
      const lines: string[] = [];
      const outcome = await applyPolicyDocument(
        endpoint,
        document,
        { newId: host.newId },
        (line) => lines.push(line),
        PLAIN,
      );
      return { outcome, lines };
    },
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
