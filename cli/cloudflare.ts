/**
 * The Cloudflare API, as much of it as provisioning needs.
 *
 * Four things in here are traps rather than details, and each one has cost this
 * project time already. They are the reason this file exists instead of a handful of
 * `fetch` calls at the call site.
 *
 *   1. **The binding field names are not consistent, and getting one wrong fails
 *      silently.** D1 uses `id`, KV uses `namespace_id`, R2 uses `bucket_name`,
 *      Queues uses `queue_name`, Vectorize uses `index_name`. A script uploaded with
 *      the wrong key deploys, reports success, and answers every request with an
 *      undefined binding. `BINDING_ID_FIELD` is the single place that mapping is
 *      written down, and there is a test that walks it.
 *   2. **KV hard-fails on a duplicate title, and D1 does not.** So "create if
 *      missing" cannot be one shape for all three. Provisioning has to be safe to
 *      run twice, because the first run is the one that gets interrupted.
 *   3. **A redeploy silently drops bindings** unless `bindings_inherit=strict` is on
 *      the query string. Not an error, not a warning: the binding is simply absent
 *      afterwards.
 *   4. **`compatibility_date` defaults to 2021-11-02** when it is not set, rather
 *      than to today. Every API the engine depends on behaves differently.
 *
 * No `node:` imports, and the fetcher is injected, so the whole client is exercised
 * in tests against a stand-in that models the behaviours above. ⚠️ That stand-in is
 * built from the documented and measured behaviour, not from the real API. It cannot
 * prove Cloudflare agrees; it can prove this code does what the record says to do.
 */

export const API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * Which field carries the resource id, per binding type.
 *
 * The asymmetry is Cloudflare's, not ours. Written once here because the failure
 * mode for getting it wrong is a deployment that reports success and then has an
 * undefined binding at runtime, which is the worst kind: nothing to search for.
 */
export const BINDING_ID_FIELD = Object.freeze({
  d1: 'id',
  kv_namespace: 'namespace_id',
  r2_bucket: 'bucket_name',
  queue: 'queue_name',
  vectorize: 'index_name',
} as const);

export type BindingType = keyof typeof BINDING_ID_FIELD;

/**
 * The permissions a token needs, and the reason this list is in the code.
 *
 * Cloudflare's own "Edit Cloudflare Workers" template does not include D1, so the
 * obvious choice produces a token that provisions everything except the database.
 * The permissions page also lists each one twice under different names (Read/Edit
 * for the dashboard, Read/Write for the API), and picking the wrong one gives a 403
 * that names nothing.
 */
export const REQUIRED_TOKEN_PERMISSIONS: readonly string[] = Object.freeze([
  'Account · Workers Scripts · Edit',
  'Account · D1 · Edit',
  'Account · Workers R2 Storage · Edit',
  'Account · Workers KV Storage · Edit',
  'Account · Account Settings · Read',
]);

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface Credentials {
  readonly accountId: string;
  readonly token: string;
}

export class CloudflareError extends Error {
  readonly status: number;
  /** Cloudflare's own error codes, which are worth reporting verbatim. */
  readonly codes: readonly number[];

  constructor(message: string, status: number, codes: readonly number[] = []) {
    super(message);
    this.name = 'CloudflareError';
    this.status = status;
    this.codes = codes;
  }
}

interface Envelope<T> {
  readonly success?: boolean;
  readonly result?: T;
  readonly errors?: readonly { readonly code?: number; readonly message?: string }[];
}

/**
 * One call, with the envelope unwrapped and a failure that names itself.
 *
 * Cloudflare answers 200 with `success: false` for some failures, so the status is
 * not enough on its own. Both are checked, because a client that trusts the status
 * treats a refusal as a result.
 */
async function call<T>(
  fetcher: Fetcher,
  credentials: Credentials,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetcher(`${API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${credentials.token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  let envelope: Envelope<T> = {};
  try {
    envelope = JSON.parse(text) as Envelope<T>;
  } catch {
    // A body that is not JSON is itself the diagnosis, and truncated because an
    // HTML error page is not worth putting in a terminal.
    throw new CloudflareError(
      `${path} answered ${response.status} with a body that is not JSON: ${text.slice(0, 120)}`,
      response.status,
    );
  }

  if (!response.ok || envelope.success === false) {
    const codes = (envelope.errors ?? []).map((error) => error.code ?? 0);
    const messages = (envelope.errors ?? []).map((error) => error.message ?? 'no message');

    throw new CloudflareError(
      `${path} answered ${response.status}: ${messages.join('; ') || 'no error given'}`,
      response.status,
      codes,
    );
  }

  return envelope.result as T;
}

/** Cloudflare's code for "that name is taken", which idempotency has to absorb. */
export const ALREADY_EXISTS_CODES: readonly number[] = Object.freeze([10014, 10021, 1004]);

function isAlreadyExists(error: unknown): boolean {
  if (!(error instanceof CloudflareError)) return false;
  if (error.codes.some((code) => ALREADY_EXISTS_CODES.includes(code))) return true;
  // Belt and braces. The codes above are the documented ones, and a message match
  // catches a code this list has not seen. Absorbing a conflict is safe in a way
  // that failing on one is not: the resource exists either way.
  return /already exists|duplicate|taken/i.test(error.message);
}

export interface Database {
  readonly uuid: string;
  readonly name: string;
}

/**
 * Find a database by name, or make one.
 *
 * D1's list endpoint takes `?name=`, so the lookup is one call rather than a page
 * walk. The create is still wrapped, because between the list and the create is a
 * window, and the whole point of this being idempotent is that the first run is the
 * one that gets interrupted.
 */
export async function ensureDatabase(
  fetcher: Fetcher,
  credentials: Credentials,
  name: string,
): Promise<{ database: Database; created: boolean }> {
  const existing = await call<readonly Database[]>(
    fetcher,
    credentials,
    `/accounts/${credentials.accountId}/d1/database?name=${encodeURIComponent(name)}`,
  );

  const found = (existing ?? []).find((database) => database.name === name);
  if (found !== undefined) return { database: found, created: false };

  try {
    const database = await call<Database>(
      fetcher,
      credentials,
      `/accounts/${credentials.accountId}/d1/database`,
      { method: 'POST', body: JSON.stringify({ name }) },
    );
    return { database, created: true };
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;

    // Somebody else created it between the two calls. Look again rather than
    // reporting a failure for a resource that now exists.
    const again = await call<readonly Database[]>(
      fetcher,
      credentials,
      `/accounts/${credentials.accountId}/d1/database?name=${encodeURIComponent(name)}`,
    );
    const raced = (again ?? []).find((database) => database.name === name);
    if (raced === undefined) throw error;

    return { database: raced, created: false };
  }
}

export interface Namespace {
  readonly id: string;
  readonly title: string;
}

/**
 * Find a KV namespace by title, or make one.
 *
 * ⚠️ KV hard-fails on a duplicate title, unlike D1. The list has to come first, and it
 * has no `?title=` filter, so it is a page walk.
 *
 * A mutation corrected the claim this comment used to make. It said the list was what
 * made a second run safe. It is not: the conflict handler below absorbs the duplicate
 * error and looks again, so removing the list leaves the outcome identical. What the
 * list actually buys is not making a request that is known to fail, which is worth
 * having and is a smaller claim. The test asserts the request count, so the two are
 * now told apart.
 */
export async function ensureNamespace(
  fetcher: Fetcher,
  credentials: Credentials,
  title: string,
): Promise<{ namespace: Namespace; created: boolean }> {
  const listed = await call<readonly Namespace[]>(
    fetcher,
    credentials,
    `/accounts/${credentials.accountId}/storage/kv/namespaces?per_page=100`,
  );

  const found = (listed ?? []).find((namespace) => namespace.title === title);
  if (found !== undefined) return { namespace: found, created: false };

  try {
    const namespace = await call<Namespace>(
      fetcher,
      credentials,
      `/accounts/${credentials.accountId}/storage/kv/namespaces`,
      { method: 'POST', body: JSON.stringify({ title }) },
    );
    return { namespace, created: true };
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;

    const again = await call<readonly Namespace[]>(
      fetcher,
      credentials,
      `/accounts/${credentials.accountId}/storage/kv/namespaces?per_page=100`,
    );
    const raced = (again ?? []).find((namespace) => namespace.title === title);
    if (raced === undefined) throw error;

    return { namespace: raced, created: false };
  }
}

/**
 * Make a bucket, or find that it is already there.
 *
 * R2 has no name filter on its list either. Jurisdiction, when it is needed, goes in
 * the `cf-r2-jurisdiction` header rather than the body, which is the kind of
 * asymmetry that is invisible until a bucket lands in the wrong region.
 */
export async function ensureBucket(
  fetcher: Fetcher,
  credentials: Credentials,
  name: string,
  jurisdiction?: string,
): Promise<{ bucket: { name: string }; created: boolean }> {
  const listed = await call<{ buckets?: readonly { name: string }[] }>(
    fetcher,
    credentials,
    `/accounts/${credentials.accountId}/r2/buckets`,
  );

  const found = (listed?.buckets ?? []).find((bucket) => bucket.name === name);
  if (found !== undefined) return { bucket: found, created: false };

  try {
    await call<unknown>(fetcher, credentials, `/accounts/${credentials.accountId}/r2/buckets`, {
      method: 'POST',
      body: JSON.stringify({ name }),
      ...(jurisdiction === undefined
        ? {}
        : { headers: { 'cf-r2-jurisdiction': jurisdiction } }),
    });
    return { bucket: { name }, created: true };
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    return { bucket: { name }, created: false };
  }
}

/**
 * The account's workers.dev subdomain, creating it if the account has none.
 *
 * A `PUT` rather than a `POST`, and idempotent by nature: setting it to what it
 * already is succeeds. The read comes first anyway, because an account that has one
 * must not have it changed by a tool the user ran to create a database.
 */
export async function ensureSubdomain(
  fetcher: Fetcher,
  credentials: Credentials,
  preferred: string,
): Promise<{ subdomain: string; created: boolean }> {
  try {
    const existing = await call<{ subdomain?: string }>(
      fetcher,
      credentials,
      `/accounts/${credentials.accountId}/workers/subdomain`,
    );
    if (existing?.subdomain !== undefined && existing.subdomain !== '') {
      return { subdomain: existing.subdomain, created: false };
    }
  } catch (error) {
    // A 404 here means the account has no subdomain yet, which is the case the
    // create below is for. Anything else is a real failure and is not swallowed.
    if (!(error instanceof CloudflareError) || error.status !== 404) throw error;
  }

  const made = await call<{ subdomain?: string }>(
    fetcher,
    credentials,
    `/accounts/${credentials.accountId}/workers/subdomain`,
    { method: 'PUT', body: JSON.stringify({ subdomain: preferred }) },
  );

  return { subdomain: made?.subdomain ?? preferred, created: true };
}

/** Turn the workers.dev route on for a script. Separate call from the upload. */
export async function enableWorkersDev(
  fetcher: Fetcher,
  credentials: Credentials,
  script: string,
): Promise<void> {
  await call<unknown>(
    fetcher,
    credentials,
    `/accounts/${credentials.accountId}/workers/scripts/${encodeURIComponent(script)}/subdomain`,
    { method: 'POST', body: JSON.stringify({ enabled: true }) },
  );
}

/** Whether a token can be used at all, and which account it names. */
export async function verifyToken(fetcher: Fetcher, credentials: Credentials): Promise<void> {
  await call<unknown>(fetcher, credentials, `/accounts/${credentials.accountId}`);
}
