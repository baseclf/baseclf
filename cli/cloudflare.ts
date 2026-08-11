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
 * How long any one call waits. A judgment rather than a measurement: how long
 * Cloudflare really takes to create a database has not been timed. Too short fails
 * provisioning partway through, and idempotency is what covers that.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

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
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  // FormData carries its own content type, and the boundary inside it is the only
  // thing that lets the server find the parts. Setting a content type here would
  // replace that value with one that has no boundary. The upload is then rejected as
  // malformed, which at least is loud, but it is rejected for a reason that names
  // nothing the caller did.
  const carriesOwnContentType = init.body instanceof FormData;

  const response = await fetcher(`${API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${credentials.token}`,
      ...(carriesOwnContentType ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
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

/** Items per page. Cloudflare's maximum, and what wrangler asks for. */
const PAGE_SIZE = 100;

/**
 * A ceiling on the walk, so a list that never ends fails instead of hanging.
 *
 * Nothing in the API promises that asking for the next page returns anything new. A
 * server answering every page with a full one would spin here until somebody killed
 * the terminal, and a provisioning run that hangs is worse than one that says what it
 * could not do. Fifty pages is far more than this walk should ever need.
 */
const MAX_PAGES = 50;

/**
 * Every item from a list endpoint that pages by number.
 *
 * This exists because of a failure that only appears on a busy account.
 * `ensureNamespace` used to ask for one page of a hundred and stop. An account whose
 * namespace sat on the second page did not find it, went on to create it, met KV's
 * hard failure on a duplicate title, looked again at the same single page, and gave
 * up. The namespace existed the whole time, and the run was not repeatable, which is
 * the one property the whole provisioning chain is built for.
 *
 * ⚠️ `order` and `direction` are sent rather than left to the server, and that is not
 * tidiness. Paging by number over an unstated order can return one item twice and
 * skip another between two requests, so a walk without a stated order can miss the
 * thing it is walking to find. wrangler sends the same two for its own KV listing.
 *
 * A short page ends the walk. The envelope does carry `result_info` with a total, but
 * `call` unwraps to `result`, and a walk that needs a second accessor to know when to
 * stop is a walk with two ways to be wrong.
 */
async function listAllPages<T>(
  fetcher: Fetcher,
  credentials: Credentials,
  path: string,
  order: string,
): Promise<readonly T[]> {
  const items: T[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({
      per_page: String(PAGE_SIZE),
      order,
      direction: 'asc',
      page: String(page),
    });

    const received =
      (await call<readonly T[]>(fetcher, credentials, `${path}?${query.toString()}`)) ?? [];

    items.push(...received);
    if (received.length < PAGE_SIZE) return items;
  }

  throw new Error(
    `${path} still had more to give after ${MAX_PAGES} pages of ${PAGE_SIZE}. Either this ` +
      'account holds far more than provisioning expects, or that endpoint is not advancing.',
  );
}

/**
 * Find a KV namespace by title, or make one.
 *
 * ⚠️ KV hard-fails on a duplicate title, unlike D1. The list has to come first, and it
 * has no `?title=` filter, so it is a page walk. Every page of it: see `listAllPages`
 * for what asking only for the first one did to an account holding more than a
 * hundred namespaces.
 *
 * A mutation corrected the claim this comment used to make. It said the list was what
 * made a second run safe. It is not: the conflict handler below absorbs the duplicate
 * error and looks again, so removing the list leaves the outcome identical. What the
 * list actually buys is not making a request that is known to fail, which is worth
 * having and is a smaller claim. The test asserts the request count, so the two are
 * now told apart.
 *
 * The second walk, the one after a conflict, is the one that has to be complete
 * rather than quick. It runs when the namespace is known to exist and the first walk
 * did not show it, which is precisely the state a partial list produces.
 */
export async function ensureNamespace(
  fetcher: Fetcher,
  credentials: Credentials,
  title: string,
): Promise<{ namespace: Namespace; created: boolean }> {
  const path = `/accounts/${credentials.accountId}/storage/kv/namespaces`;

  const listed = await listAllPages<Namespace>(fetcher, credentials, path, 'title');

  const found = listed.find((namespace) => namespace.title === title);
  if (found !== undefined) return { namespace: found, created: false };

  try {
    const namespace = await call<Namespace>(fetcher, credentials, path, {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    return { namespace, created: true };
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;

    const again = await listAllPages<Namespace>(fetcher, credentials, path, 'title');
    const raced = again.find((namespace) => namespace.title === title);
    if (raced === undefined) throw error;

    return { namespace: raced, created: false };
  }
}

/**
 * Make a bucket, or find that it is already there.
 *
 * R2 is asked for one bucket by name rather than walked, and that is not the same
 * choice as the KV walk above because there is nothing dependable here to walk. The
 * list endpoint pages by cursor, the cursor arrives in `result_info`, and `call`
 * unwraps to `result`; Cloudflare's own SDK does not page this endpoint at all. A
 * walk would be built on a shape nothing within reach has measured. Asking for one
 * bucket by name is the endpoint wrangler uses for `r2 bucket info`, and it has no
 * page to miss. The list it replaces asked for no page size at all, so a busy account
 * was one truncation away from a create that was known to fail.
 *
 * ⚠️ The lookup is an optimisation and nothing more. A failure of any kind falls
 * through to the create, and the create absorbs a conflict, so a lookup that behaves
 * in some way this code did not predict costs one request that was going to fail and
 * never changes the answer. That is deliberate: correctness lives in the conflict
 * handler, which is measured, rather than in a 404 that is not.
 *
 * Jurisdiction, when it is needed, goes in the `cf-r2-jurisdiction` header rather
 * than the body, which is the kind of asymmetry that is invisible until a bucket
 * lands in the wrong region. It is sent on the lookup too, because a bucket in a
 * jurisdiction is not visible from outside it.
 */
export async function ensureBucket(
  fetcher: Fetcher,
  credentials: Credentials,
  name: string,
  jurisdiction?: string,
): Promise<{ bucket: { name: string }; created: boolean }> {
  const path = `/accounts/${credentials.accountId}/r2/buckets`;
  const headers: Record<string, string> =
    jurisdiction === undefined ? {} : { 'cf-r2-jurisdiction': jurisdiction };

  try {
    const existing = await call<{ name?: string }>(
      fetcher,
      credentials,
      `${path}/${encodeURIComponent(name)}`,
      { headers },
    );
    if (existing?.name === name) return { bucket: { name }, created: false };
  } catch {
    // Absent is the ordinary case and it arrives as a 404. Every other failure is
    // reported by the create below rather than swallowed here, so nothing is hidden
    // and none of them has to be recognised.
  }

  try {
    await call<unknown>(fetcher, credentials, path, {
      method: 'POST',
      body: JSON.stringify({ name }),
      headers,
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

/**
 * Set one secret on a script. Step 7 of the chain in `rules/02` §C.
 *
 * `secret_text` is the binding type Cloudflare stores it under, and it is what makes
 * the platform hide the value afterwards rather than hand it back the way it hands
 * back a `plain_text` variable. Measured against the shape wrangler's own client
 * sends, rather than recalled.
 *
 * ⚠️ The value is a body field. It is never a path segment and never a query
 * parameter, because a URL is written into access logs at both ends and into every
 * proxy between them, and none of those are places a value can be taken back out of
 * later. Nothing here logs, and the caller is the one that has to keep the value out
 * of whatever it prints: see `cli/secret.ts`, which puts every message it shows
 * through a redaction first.
 */
export async function putSecret(
  fetcher: Fetcher,
  credentials: Credentials,
  script: string,
  name: string,
  text: string,
): Promise<void> {
  await call<unknown>(
    fetcher,
    credentials,
    `/accounts/${credentials.accountId}/workers/scripts/${encodeURIComponent(script)}/secrets`,
    { method: 'PUT', body: JSON.stringify({ name, text, type: 'secret_text' }) },
  );
}

/** Whether a token can be used at all, and which account it names. */
export async function verifyToken(fetcher: Fetcher, credentials: Credentials): Promise<void> {
  await call<unknown>(fetcher, credentials, `/accounts/${credentials.accountId}`);
}

export interface Account {
  readonly id: string;
  readonly name: string;
}

/**
 * The accounts a credential can act on.
 *
 * Needed because nothing else knows the account id. The OAuth file `wrangler login`
 * writes holds a token, a refresh token, an expiry and a scope list, and no account
 * anywhere in it, so a run that takes its credential from there has to ask.
 *
 * ⚠️ Returns all of them rather than picking. Somebody with a personal account and a
 * work account would otherwise have a deployment appear in whichever one happened to
 * be first in the response, and Cloudflare does not promise an order. The caller
 * refuses and asks rather than guessing, which is the only answer that cannot put
 * somebody's database on their employer's bill.
 */
export async function listAccounts(fetcher: Fetcher, token: string): Promise<readonly Account[]> {
  // The one path that is not under an account, so there is no id to put in it.
  const result = await call<readonly Account[]>(fetcher, { accountId: '', token }, '/accounts');
  return result ?? [];
}

/**
 * The names of the secrets a script has, or `null` when there is no such script.
 *
 * ⭐ Names only. Cloudflare does not return the values and this does not want them.
 *
 * The three-way answer is what makes a second run safe, and each state needs
 * different handling:
 *
 *   - `null`, no script yet. First run. Generate a secret, upload without an
 *     `inherit` binding, then set it.
 *   - `[]` or a list without the signing secret. A run that was interrupted between
 *     the upload and the secret. Same handling as the first case, and an unconditional
 *     `inherit` would fail here too, because `bindings_inherit=strict` turns an
 *     inherit that resolves to nothing into an error.
 *   - a list containing it. A redeploy. Inherit it, and **do not generate a new one**:
 *     the signing secret is what every existing session and token was signed with, so
 *     replacing it silently signs everybody out.
 *
 * Measured on 2026-08-12: a missing script answers 404 with code 10007.
 */
export async function scriptSecretNames(
  fetcher: Fetcher,
  credentials: Credentials,
  script: string,
): Promise<readonly string[] | null> {
  try {
    const result = await call<readonly { readonly name?: string }[]>(
      fetcher,
      credentials,
      `/accounts/${credentials.accountId}/workers/scripts/${encodeURIComponent(script)}/secrets`,
    );
    return (result ?? []).map((secret) => secret.name ?? '').filter((name) => name !== '');
  } catch (error) {
    if (error instanceof CloudflareError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Set the cron triggers on a script.
 *
 * A separate call from the upload, and easy to leave out because nothing complains
 * when it is missing: the deployment answers every request correctly and simply never
 * runs its scheduled work. For this Worker that is the rate limit sweep and the
 * storage reconciliation, so the symptom is a table that grows without bound and a
 * drift check that never checks, months later and with nothing pointing back here.
 *
 * Measured on 2026-08-12: `PUT` takes a bare array of `{ cron }` and answers 200, and
 * `GET` returns them under a `schedules` key.
 */
export async function putSchedules(
  fetcher: Fetcher,
  credentials: Credentials,
  script: string,
  crons: readonly string[],
): Promise<void> {
  await call<unknown>(
    fetcher,
    credentials,
    `/accounts/${credentials.accountId}/workers/scripts/${encodeURIComponent(script)}/schedules`,
    { method: 'PUT', body: JSON.stringify(crons.map((cron) => ({ cron }))) },
  );
}

/**
 * A module in the uploaded script.
 *
 * The content is passed in rather than read from disk, because the CLI core does not
 * import `node:`. Opening the file is the caller's job and stays at the edge.
 */
export interface ScriptModule {
  readonly name: string;
  readonly content: string;
}

/**
 * A binding, in the three shapes this deployer can express.
 *
 * ⚠️ There is deliberately no shape for a secret. Secrets go in through
 * `PUT /accounts/{id}/workers/scripts/{name}/secrets`, which keeps them out of the
 * upload body and out of anything that ever logs a request. `inherit` is how a secret
 * that is already set survives a redeploy.
 */
export type ScriptBinding =
  | {
      readonly kind: 'resource';
      readonly type: BindingType;
      readonly name: string;
      readonly id: string;
    }
  | { readonly kind: 'text'; readonly name: string; readonly value: string }
  | { readonly kind: 'inherit'; readonly name: string };

/**
 * Set on every upload, and not a parameter.
 *
 * `nodejs_compat` is what makes `node:crypto` present, which is what Better Auth
 * hashes with. A deployment without it starts and then fails on the first request
 * that touches auth, so leaving it to a caller to remember is leaving room for a
 * failure that has nothing to do with the request that hits it.
 */
export const REQUIRED_COMPATIBILITY_FLAGS: readonly string[] = Object.freeze(['nodejs_compat']);

/** ESM. A module sent as anything else is read as a service worker script. */
export const MODULE_CONTENT_TYPE = 'application/javascript+module';

/**
 * Longer than the other calls, because this one carries the whole bundle.
 *
 * A judgment, not a measurement. The engine builds to roughly 1.8 MB before
 * compression, and 30 seconds of that is a slow uplink away from timing out on a
 * request that was going to succeed. Re-running the upload is safe, so erring long
 * costs a wait and erring short costs a failed provision.
 */
export const UPLOAD_TIMEOUT_MS = 120_000;

const COMPATIBILITY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Refused here, before anything is sent, because the request would be wrong. */
export class ScriptUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptUploadError';
  }
}

/**
 * One binding, in the shape the API reads.
 *
 * The last line is the only place `BINDING_ID_FIELD` is load-bearing rather than
 * documentation, and it is the reason that map is written down: the id for a D1
 * database goes under `id`, for KV under `namespace_id`, for R2 under `bucket_name`.
 * Getting it wrong uploads, reports success, and leaves an undefined binding.
 */
export function toApiBinding(binding: ScriptBinding): Record<string, string> {
  if (binding.kind === 'inherit') return { type: 'inherit', name: binding.name };
  if (binding.kind === 'text')
    return { type: 'plain_text', name: binding.name, text: binding.value };

  return {
    type: binding.type,
    name: binding.name,
    [BINDING_ID_FIELD[binding.type]]: binding.id,
  };
}

export interface UploadScriptOptions {
  readonly name: string;
  readonly modules: readonly ScriptModule[];
  /** Must name one of `modules`. Checked here so the failure names the cause. */
  readonly mainModule: string;
  /** Required, and no default. See the note on the 2021 fallback below. */
  readonly compatibilityDate: string;
  readonly compatibilityFlags?: readonly string[];
  readonly bindings?: readonly ScriptBinding[];
}

export interface UploadedScript {
  readonly id?: string;
  readonly etag?: string;
}

/**
 * Upload the Worker. Step 5 of provisioning, and the one that deploys anything.
 *
 * Two of the four traps this file exists for live in this function, and both of them
 * fail by reporting success:
 *
 *   - **`bindings_inherit=strict` is always on the query string.** Without it an
 *     `inherit` binding that cannot be resolved is dropped rather than refused, so a
 *     redeploy quietly ships a Worker missing a binding it had a minute earlier.
 *   - **`compatibility_date` has no default here, because the API's default is
 *     2021-11-02 rather than today.** A Worker dated 2021 runs, answers requests, and
 *     behaves differently from every measurement in this project. So it is a required
 *     argument, and the format is checked before sending rather than trusted to be
 *     rejected, since the failure mode for a value the API ignores is the same silence.
 *
 * ⚠️ The bindings array is authoritative: what is not listed is not on the deployed
 * Worker. That is why `inherit` exists and why secrets have their own endpoint. This
 * is the documented behaviour rather than a measured one, and confirming it needs a
 * real account.
 *
 * `PUT` on an existing script replaces it, so running this twice is safe by nature
 * rather than by the list-then-create the other steps need.
 */
export async function uploadScript(
  fetcher: Fetcher,
  credentials: Credentials,
  options: UploadScriptOptions,
): Promise<UploadedScript> {
  const { name, modules, mainModule, compatibilityDate, compatibilityFlags, bindings } = options;

  if (modules.length === 0) {
    throw new ScriptUploadError('A script upload needs at least one module, and none were given.');
  }

  const moduleNames = modules.map((module) => module.name);
  const duplicateModule = moduleNames.find((each, index) => moduleNames.indexOf(each) !== index);
  if (duplicateModule !== undefined) {
    // Two parts under one name is ambiguous, and which one the server keeps is not
    // something to find out by deploying.
    throw new ScriptUploadError(`Two modules are both named "${duplicateModule}".`);
  }

  if (!moduleNames.includes(mainModule)) {
    throw new ScriptUploadError(
      `The main module "${mainModule}" is not among the modules given (${moduleNames.join(', ')}).`,
    );
  }

  if (!COMPATIBILITY_DATE_PATTERN.test(compatibilityDate)) {
    throw new ScriptUploadError(
      `compatibility_date must look like 2026-07-28, and "${compatibilityDate}" does not. ` +
        'Without a date the platform uses 2021-11-02, so this is refused rather than sent.',
    );
  }

  const bindingList = bindings ?? [];
  const bindingNames = bindingList.map((binding) => binding.name);
  const duplicateBinding = bindingNames.find((each, index) => bindingNames.indexOf(each) !== index);
  if (duplicateBinding !== undefined) {
    throw new ScriptUploadError(`Two bindings are both named "${duplicateBinding}".`);
  }

  const metadata = {
    main_module: mainModule,
    compatibility_date: compatibilityDate,
    // Merged rather than replaced, so a caller adding a flag cannot drop the one the
    // engine cannot run without.
    compatibility_flags: [
      ...REQUIRED_COMPATIBILITY_FLAGS,
      ...(compatibilityFlags ?? []).filter((flag) => !REQUIRED_COMPATIBILITY_FLAGS.includes(flag)),
    ],
    bindings: bindingList.map(toApiBinding),
    // On for every deployment. A Worker with logs off is one `doctor` cannot explain
    // and its owner cannot read, and the whole point of that command is that the
    // silent failures in here are diagnosable from outside.
    observability: { enabled: true },
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  for (const module of modules) {
    form.append(
      module.name,
      new Blob([module.content], { type: MODULE_CONTENT_TYPE }),
      module.name,
    );
  }

  return (
    (await call<UploadedScript>(
      fetcher,
      credentials,
      `/accounts/${credentials.accountId}/workers/scripts/${encodeURIComponent(name)}?bindings_inherit=strict`,
      { method: 'PUT', body: form },
      UPLOAD_TIMEOUT_MS,
    )) ?? {}
  );
}
