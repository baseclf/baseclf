/**
 * BaseCLF worker entry point.
 *
 * Reads and writes both go through the policy engine, and both get their
 * identity from `identify`, which is the only way to obtain one inside `fetch`.
 * A request with no token is anonymous, which is a role with policies of its
 * own rather than an absence of checks; a request with a bad one is refused.
 *
 * Three things sit in front of the identity provider, in this order, and the
 * order is the design:
 *
 *   1. The diagnostic, which answers even when nothing else can.
 *   2. The rate limiter, which counts in D1 because every alternative on this
 *      platform fails quietly. See `utils/ratelimit.ts`.
 *   3. Better Auth itself.
 */

import { diagnose } from './auth/diagnose.js';
import { type AuthEnv, authConfig, getAuth, isAuthPath, verifierConfig } from './auth/index.js';
import { providerStatuses } from './auth/providers.js';
import { authenticate } from './auth/verify.js';
import { getCatalogue } from './db/index.js';
import type { AuthCtx } from './policy/index.js';
import { getRegistry } from './policy/index.js';
import type { WriteOperation } from './policy/write.js';
import { operationForMethod, readTable, tableFromPath, writeTable } from './rest/index.js';
import { BaseclfError } from './utils/errors.js';
import { logError } from './utils/log.js';
import {
  checkRateLimit,
  cleanupRateLimits,
  deriveRateLimitKey,
  ensureRateLimitTable,
  type RateLimitRule,
} from './utils/ratelimit.js';

export interface Env extends AuthEnv {
  readonly DB: D1Database;
}

/** Where the diagnostic lives. Checked before the identity provider sees a path. */
const DIAGNOSE_PATH = '/api/auth/_diagnose';

/** The key set this worker serves, and fetches from itself while verifying. */
const JWKS_PATH = '/api/auth/jwks';

/**
 * What the auth endpoints cost a caller.
 *
 * Two budgets rather than one. The endpoints that take a password or mint a
 * session are the ones worth guessing at, and they get a limit a person will
 * never reach and a script will reach in seconds. Everything else under the
 * prefix gets a looser one, because a signed-in client legitimately calls
 * session and token endpoints often and locking it out is not a security win.
 *
 * These numbers are a starting point rather than a measurement. Per-endpoint
 * tuning belongs with the CLI that will configure it.
 */
const CREDENTIAL_LIMIT: RateLimitRule = { limit: 20, windowSeconds: 60 };
const AUTH_LIMIT: RateLimitRule = { limit: 100, windowSeconds: 60 };

/**
 * How long a spent counter row is kept before the sweep removes it.
 *
 * An order of magnitude beyond the longest window above, so a row can only be
 * deleted once nothing could still be counting against it. Deleting one early
 * would reset an attacker's allowance, which would make the cleanup job a way
 * around the limiter rather than a way of tidying up after it.
 */
const RATE_LIMIT_RETENTION_SECONDS = 3_600;

/** Paths where a wrong guess is worth something to an attacker. */
const CREDENTIAL_PATHS =
  /\/(sign-in|sign-up|sign-out|callback|reset-password|forget-password|change-password|change-email|verify-email|two-factor)(\/|$)/;

/**
 * Which budget a path draws on, or none at all.
 *
 * JWKS is deliberately unlimited. It serves public key material, so there is
 * nothing in it to guess, and the verifier fetches it from this same worker on
 * the way to checking a token. Limiting it would mean a burst arriving on cold
 * isolates could exhaust the budget and turn every subsequent request into a
 * 401, which is a self-inflicted outage in exchange for protecting a public
 * key. The diagnostic is unlimited for a related reason: it is what somebody
 * reaches for when the deployment is broken, and it must not be the thing that
 * breaks with it.
 */
function rateLimitFor(pathname: string): { bucket: string; rule: RateLimitRule } | null {
  if (pathname === JWKS_PATH || pathname.startsWith(`${JWKS_PATH}/`)) return null;
  if (pathname === DIAGNOSE_PATH) return null;

  return CREDENTIAL_PATHS.test(pathname)
    ? { bucket: 'auth_credential', rule: CREDENTIAL_LIMIT }
    : { bucket: 'auth', rule: AUTH_LIMIT };
}

/**
 * Make sure the counter table exists, once per isolate.
 *
 * The limiter fails closed, so without the table every auth request is refused.
 * That is the right behaviour for a limiter and the wrong first impression for
 * a deployment, and the difference between them is one idempotent statement.
 * Concurrent isolates racing here is harmless: `CREATE TABLE IF NOT EXISTS` is
 * idempotent, and the memo is only set on success so a failure is retried
 * rather than cached.
 *
 * Provisioning should still create it up front. This is the floor, not the plan.
 */
let rateLimitTableReady: Promise<void> | null = null;

async function ensureRateLimitTableOnce(db: D1Database): Promise<void> {
  rateLimitTableReady ??= ensureRateLimitTable(db).catch((error: unknown) => {
    rateLimitTableReady = null;
    throw error;
  });
  await rateLimitTableReady;
}

/** For tests, which start from a database that has just been rebuilt. */
export function resetRateLimitTableMemo(): void {
  rateLimitTableReady = null;
}

/**
 * Count this request, and refuse it if the budget is spent.
 *
 * Returns the refusal rather than throwing it, because a 429 is not an error in
 * the sense the error handler means: it carries a Retry-After that a client is
 * meant to obey, and routing it through `BaseclfError` would lose the header.
 */
async function enforceRateLimit(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  const applicable = rateLimitFor(pathname);
  if (applicable === null) return null;

  await ensureRateLimitTableOnce(env.DB);

  const result = await checkRateLimit(env.DB, {
    key: deriveRateLimitKey(request, applicable.bucket),
    ...applicable.rule,
  });

  if (result.allowed) return null;

  return Response.json(
    { error: 'Too many requests.', code: 'RATE_LIMITED' },
    {
      status: 429,
      // A client that respects this backs off on its own. One that does not
      // keeps paying for a statement per attempt and never gets through.
      headers: { 'retry-after': String(result.retryAfterSeconds) },
    },
  );
}

/**
 * What is configured, and what is wrong with it.
 *
 * Reads configuration through `authConfig` rather than `authSettings` on
 * purpose: the latter refuses a deployment with no secret, and this is the one
 * endpoint that has to keep answering for a deployment in exactly that state.
 * It touches no database either, so it survives an outage that takes out
 * everything else. See the auth skill, trap 1.
 */
function describeDeployment(request: Request, env: Env): Response {
  const config = authConfig(env);

  return Response.json(
    diagnose({
      requestUrl: request.url,
      requestOrigin: request.headers.get('origin'),
      baseUrlConfig: config.baseURL,
      trustedOrigins: config.trustedOrigins,
      providers: providerStatuses(env, config.baseURL),
      secretConfigured: config.secretConfigured,
    }),
  );
}

/**
 * Who this request is, or a refusal.
 *
 * Both data paths go through here, and there is deliberately no third way to
 * obtain a context inside `fetch`. A bad token throws rather than degrading to
 * anonymous: silently serving the public view to somebody whose session just
 * expired looks like their data vanished.
 *
 * When authentication is not configured at all, this is still not a reason to
 * let a request through as anonymous. `authSettings` throws, the request gets a
 * 500, and the deployment is visibly broken rather than quietly open.
 */
async function identify(request: Request, env: Env): Promise<AuthCtx> {
  return authenticate(request, verifierConfig(env));
}

/**
 * A read-only view of what the engine can see.
 *
 * The catalogue is memoised per isolate, so this costs one round of PRAGMA
 * reads per cold start rather than one per request. Building it lazily inside
 * `fetch` is deliberate: the Workers startup CPU budget is one second and
 * module scope work counts against it.
 */
async function describeSchema(env: Env): Promise<Response> {
  const catalogue = await getCatalogue(env.DB);

  const tables = [...catalogue.tables.values()]
    .filter((table) => !table.isSystem)
    .map((table) => ({
      name: table.name,
      columns: table.columns.size,
      indexes: table.indexes.length,
      foreignKeys: table.foreignKeys.length,
    }));

  return Response.json({ tables });
}

/**
 * The bookmark, and what the statement cost.
 *
 * Without the bookmark round trip a read can be served by a replica that has
 * not caught up, so a client that writes and immediately reads does not see its
 * own write. It is the kind of bug that only appears under load and is
 * miserable to track down.
 */
function resultHeaders(
  session: D1DatabaseSession,
  result: { readonly rowsRead: number | null },
): Record<string, string> {
  return {
    'x-d1-bookmark': session.getBookmark() ?? '',
    // What the statement actually scanned. D1 bills for rows read rather than
    // rows returned, so a policy column without an index shows up here long
    // before it shows up on an invoice.
    ...(result.rowsRead === null ? {} : { 'x-baseclf-rows-read': String(result.rowsRead) }),
  };
}

/**
 * Read a table.
 *
 * The session is opened from the bookmark the client sent back and its new
 * bookmark is returned. Without that round trip a read can be served by a
 * replica that has not caught up, so a client that writes and immediately reads
 * does not see its own write. It is the kind of bug that only appears under
 * load and is miserable to track down.
 */
async function handleRead(request: Request, env: Env, table: string): Promise<Response> {
  const session = env.DB.withSession(request.headers.get('x-d1-bookmark') ?? 'first-unconstrained');

  const [auth, catalogue, registry] = await Promise.all([
    identify(request, env),
    getCatalogue(session),
    getRegistry(session),
  ]);

  const result = await readTable({
    executor: session,
    catalogue,
    registry,
    auth,
    table,
    search: new URL(request.url).searchParams,
  });

  return Response.json(result.rows, { headers: resultHeaders(session, result) });
}

/**
 * Whether the caller wants the rows back.
 *
 * PostgREST spells this `Prefer: return=representation`, and its default is
 * `minimal`. Following the default matters here beyond compatibility: a write
 * that says nothing back is the cheaper answer, and the rows are only ever
 * useful to a caller that asked for them.
 */
function wantsRepresentation(request: Request): boolean {
  const prefer = request.headers.get('prefer') ?? '';
  return /(^|[,\s])return=representation([,;\s]|$)/.test(prefer);
}

/**
 * Insert, update or delete one row.
 *
 * Zero rows in RETURNING is a 404, whether the row was not there or the policy
 * would not have it. Rule 00 invariant I5: a caller who can tell those apart
 * can walk a range of ids and learn which of them exist.
 */
async function handleWrite(
  request: Request,
  env: Env,
  table: string,
  operation: WriteOperation,
): Promise<Response> {
  let body: Record<string, unknown> | null = null;
  if (operation !== 'delete') {
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json(
        { error: 'The request body must be JSON.', code: 'UNSUPPORTED_QUERY' },
        { status: 400 },
      );
    }
  }

  const session = env.DB.withSession(request.headers.get('x-d1-bookmark') ?? 'first-unconstrained');
  const [auth, catalogue, registry] = await Promise.all([
    identify(request, env),
    getCatalogue(session),
    getRegistry(session),
  ]);

  const result = await writeTable({
    executor: session,
    catalogue,
    registry,
    auth,
    table,
    search: new URL(request.url).searchParams,
    operation,
    body,
  });

  const headers = resultHeaders(session, result);

  if (result.rows.length === 0) {
    return Response.json({ error: 'Not found.', code: 'NOT_FOUND' }, { status: 404, headers });
  }

  if (!wantsRepresentation(request)) {
    return new Response(null, { status: operation === 'insert' ? 201 : 204, headers });
  }

  return Response.json(result.rows, { status: operation === 'insert' ? 201 : 200, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/health') {
        return Response.json({ status: 'ok', version: '0.0.0' });
      }

      if (url.pathname === '/_schema') {
        return await describeSchema(env);
      }

      // The identity provider owns this prefix. It is checked before the table
      // router rather than after, so a table can never shadow it, and it never
      // reaches `tableFromPath` in the first place.
      if (isAuthPath(url.pathname)) {
        // Before the handler, and before anything that reads configuration.
        // This path answers for a deployment too broken to answer anywhere
        // else, which is the only time anybody looks at it.
        if (url.pathname === DIAGNOSE_PATH) {
          return describeDeployment(request, env);
        }

        // Better Auth ships a limiter of its own and it is not the one to
        // rely on here: measured in workerd on 2026-08-11, it defaults to
        // disabled because it keys off NODE_ENV, which Workers does not set,
        // and its storage is a module-scope Map, so switching it on gives a
        // limit multiplied by however many isolates a caller reached. This
        // one counts in D1, which every isolate shares. See the auth skill,
        // trap 5.
        const limited = await enforceRateLimit(request, env, url.pathname);
        if (limited !== null) return limited;

        return await getAuth(env).handler(request);
      }

      const table = tableFromPath(url.pathname);
      if (table !== null) {
        if (request.method === 'GET' || request.method === 'HEAD') {
          return await handleRead(request, env, table);
        }

        const operation = operationForMethod(request.method);
        if (operation === null) {
          return Response.json(
            { error: 'Method not allowed.', code: 'UNSUPPORTED_QUERY' },
            { status: 405, headers: { allow: 'GET, HEAD, POST, PATCH, DELETE' } },
          );
        }
        return await handleWrite(request, env, table, operation);
      }

      return Response.json({ error: 'Not found.', code: 'NOT_FOUND' }, { status: 404 });
    } catch (error) {
      if (error instanceof BaseclfError) {
        // The detail goes to the log, never to the response. It is where the
        // useful diagnosis lives, and also where the table names live.
        logError({ event: 'error', code: error.code, detail: error.detail ?? error.message });
        return Response.json(error.toResponseBody(), { status: error.status });
      }

      logError({
        event: 'error',
        code: 'INTERNAL',
        detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      return Response.json({ error: 'Internal error.', code: 'INTERNAL' }, { status: 500 });
    }
  },

  /**
   * Sweep counter rows whose window closed long ago.
   *
   * On a cron rather than on the request path. The alternative, deleting
   * opportunistically while counting, would put a scan on every request to save
   * a table that a scheduled statement clears in one.
   *
   * The retention is far longer than any window in use. Deleting a row that is
   * still being counted against would hand its caller a fresh allowance, which
   * is the one way a cleanup job can become a bypass.
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await cleanupRateLimits(env.DB, RATE_LIMIT_RETENTION_SECONDS);
  },
} satisfies ExportedHandler<Env>;
