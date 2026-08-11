/**
 * Provisioning, against a stand-in that behaves badly on purpose.
 *
 * A forgiving fake proves nothing. This one models the behaviours the record says the
 * real API has, and they are the awkward ones:
 *
 *   - **KV hard-fails on a duplicate title.** D1 does not. So "create if missing"
 *     cannot be one shape for both.
 *   - **D1's list takes `?name=`.** KV's and R2's do not.
 *   - **R2 jurisdiction is a header**, not a body field.
 *   - **Some failures arrive as 200 with `success: false`**, so a client that trusts
 *     the status treats a refusal as a result.
 *
 * ⚠️ What this cannot do is prove Cloudflare agrees. The stand-in is built from
 * documented and measured behaviour (`rules/02` §C), so these tests establish that the
 * client does what the record says to do. Confirming the record still needs a real
 * account, and that is not something a test suite should be doing.
 *
 * The property under most of this is idempotency: running twice has to change nothing
 * and fail nothing, because the first run is the one that gets interrupted.
 */

import { describe, expect, it } from 'vitest';

import {
  BINDING_ID_FIELD,
  CloudflareError,
  type Credentials,
  ensureBucket,
  ensureDatabase,
  ensureNamespace,
  ensureSubdomain,
  enableWorkersDev,
  type Fetcher,
  MODULE_CONTENT_TYPE,
  REQUIRED_COMPATIBILITY_FLAGS,
  REQUIRED_TOKEN_PERMISSIONS,
  type ScriptBinding,
  ScriptUploadError,
  toApiBinding,
  uploadScript,
} from './cloudflare.js';

const CREDENTIALS: Credentials = { accountId: 'acct_7f3c91', token: 'cfut_not-a-real-token' };

/**
 * A binding as it arrives over the wire.
 *
 * `type` and `name` are always there; which field carries the id depends on the type,
 * which is the asymmetry the whole map exists for.
 */
interface ApiBinding {
  type: string;
  name: string;
  [field: string]: string;
}

/** What the stand-in ends up with after an upload, in the shape a test can read. */
interface DeployedScript {
  mainModule: string;
  /** ⚠️ The platform's own default when the upload does not carry one. */
  compatibilityDate: string;
  compatibilityFlags: string[];
  bindings: ApiBinding[];
  moduleNames: string[];
  moduleTypes: Record<string, string>;
  observability: unknown;
  /** Inherit bindings the platform could not resolve and threw away in silence. */
  droppedInherits: string[];
}

interface State {
  databases: { uuid: string; name: string }[];
  namespaces: { id: string; title: string }[];
  buckets: { name: string }[];
  subdomain: string | null;
  workersDev: string[];
  /** Every request made, so a test can assert how many calls a run costs. */
  calls: string[];
  jurisdictions: Record<string, string>;
  scripts: Record<string, DeployedScript>;
  /** Binding names already on the deployed script, which `inherit` can resolve to. */
  existingBindings: Record<string, string[]>;
  /** Bytes actually received per module, so a truncated body is visible. */
  receivedModuleBytes: Record<string, number>;
}

function freshState(): State {
  return {
    databases: [],
    namespaces: [],
    buckets: [],
    subdomain: null,
    workersDev: [],
    calls: [],
    jurisdictions: {},
    scripts: {},
    existingBindings: {},
    receivedModuleBytes: {},
  };
}

/**
 * What the API uses when an upload carries no `compatibility_date`.
 *
 * Not today, and not an error. A Worker dated this runs and answers requests while
 * behaving differently from every API this project measured.
 */
const PLATFORM_DEFAULT_COMPATIBILITY_DATE = '2021-11-02';

const MODULE = { name: 'index.js', content: 'export default { fetch: () => new Response() }' };

function uploadOptions(overrides: Record<string, unknown> = {}) {
  return {
    name: 'baseclf',
    modules: [MODULE],
    mainModule: 'index.js',
    compatibilityDate: '2026-07-28',
    ...overrides,
  } as Parameters<typeof uploadScript>[2];
}

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), { status: 200 });
}

/** A refusal shaped the way Cloudflare sends one: 200, `success: false`, a code. */
function refuse(code: number, message: string, status = 200): Response {
  return new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), { status });
}

function api(state: State): Fetcher {
  const account = `/accounts/${CREDENTIALS.accountId}`;

  return async (rawUrl, init) => {
    const url = new URL(rawUrl);
    const path = url.pathname.replace('/client/v4', '');
    const method = init?.method ?? 'GET';
    state.calls.push(`${method} ${path}${url.search}`);

    const upload = /\/workers\/scripts\/([^/]+)$/.exec(path);
    if (upload !== null && method === 'PUT') {
      const script = decodeURIComponent(upload[1] as string);
      const body = init?.body;

      // A content type set by hand replaces the boundary the parts are found with,
      // so the server has a body it cannot read. Modelled rather than assumed away,
      // because the obvious client sets `application/json` on everything.
      const declared = new Headers(init?.headers).get('content-type');
      if (declared !== null && !declared.startsWith('multipart/')) {
        return refuse(10021, `a multipart body declared as ${declared} cannot be parsed`, 400);
      }
      if (!(body instanceof FormData)) {
        return refuse(10021, 'expected multipart/form-data', 400);
      }

      const metadataPart = body.get('metadata');
      const metadata = JSON.parse(await (metadataPart as Blob).text()) as Record<string, unknown>;

      const moduleNames: string[] = [];
      const moduleTypes: Record<string, string> = {};
      for (const [key, value] of body.entries()) {
        if (key === 'metadata' || typeof value === 'string') continue;
        moduleNames.push(key);
        moduleTypes[key] = (value as Blob).type;
        // Read the bytes rather than trusting the part is there. A body that carries
        // a truncated module deploys and then fails at runtime.
        state.receivedModuleBytes[key] = (await (value as Blob).text()).length;
      }

      // ⚠️ The trap, modelled the way the record describes it. An inherit binding
      // that resolves to nothing is dropped in silence unless `bindings_inherit`
      // says strict, in which case it is refused.
      const strict = url.searchParams.get('bindings_inherit') === 'strict';
      const known = state.existingBindings[script] ?? [];
      const declaredBindings = (metadata.bindings ?? []) as ApiBinding[];
      const kept: ApiBinding[] = [];
      const dropped: string[] = [];

      for (const binding of declaredBindings) {
        if (binding.type === 'inherit' && !known.includes(binding.name)) {
          if (strict) {
            return refuse(10021, `cannot inherit binding "${binding.name}": it is not set`, 400);
          }
          dropped.push(binding.name);
          continue;
        }
        kept.push(binding);
      }

      state.scripts[script] = {
        mainModule: String(metadata.main_module ?? ''),
        // No date in the upload does not mean an error. It means 2021.
        compatibilityDate: String(
          metadata.compatibility_date ?? PLATFORM_DEFAULT_COMPATIBILITY_DATE,
        ),
        compatibilityFlags: (metadata.compatibility_flags ?? []) as string[],
        bindings: kept,
        moduleNames,
        moduleTypes,
        observability: metadata.observability,
        droppedInherits: dropped,
      };
      state.existingBindings[script] = kept.map((binding) => binding.name);

      return ok({ id: script, etag: `etag_${Object.keys(state.scripts).length}` });
    }

    if (path === `${account}/d1/database` && method === 'GET') {
      // D1 filters by name, which is why the lookup is one call rather than a walk.
      const wanted = url.searchParams.get('name');
      return Promise.resolve(
        ok(wanted === null ? state.databases : state.databases.filter((d) => d.name === wanted)),
      );
    }
    if (path === `${account}/d1/database` && method === 'POST') {
      const { name } = JSON.parse(String(init?.body)) as { name: string };
      // D1 tolerates a duplicate name and makes a second database. Not an error, and
      // not something this project wants, which is why the list comes first.
      const created = { uuid: `d1_${state.databases.length + 1}`, name };
      state.databases.push(created);
      return Promise.resolve(ok(created));
    }

    if (path === `${account}/storage/kv/namespaces` && method === 'GET') {
      // No title filter, so a page walk is the only option, and this pages by
      // number the way the real endpoint does.
      //
      // ⚠️ It did not, until a mutation survived. A stand-in that answers every
      // page with the whole list makes a walk and a single request return the same
      // thing, so removing the walk changes nothing any test can see. The paging is
      // the point of the fixture, not decoration on it.
      const perPage = Number(url.searchParams.get('per_page') ?? '100');
      const page = Number(url.searchParams.get('page') ?? '1');
      const ordered = [...state.namespaces].sort((a, b) => (a.title < b.title ? -1 : 1));

      return Promise.resolve(ok(ordered.slice((page - 1) * perPage, page * perPage)));
    }
    if (path === `${account}/storage/kv/namespaces` && method === 'POST') {
      const { title } = JSON.parse(String(init?.body)) as { title: string };
      if (state.namespaces.some((n) => n.title === title)) {
        // ⚠️ The behaviour that makes KV different: a duplicate title is a hard
        // failure, so provisioning cannot just create and shrug.
        return Promise.resolve(refuse(10014, 'a namespace with this account ID and title already exists'));
      }
      const created = { id: `kv_${state.namespaces.length + 1}`, title };
      state.namespaces.push(created);
      return Promise.resolve(ok(created));
    }

    // One bucket by name, which is what `r2 bucket info` asks and what the lookup
    // uses. Absent arrives as a 404, and jurisdiction is a header here too: a
    // bucket in a jurisdiction is not visible from outside it.
    const byName = /\/r2\/buckets\/([^/]+)$/.exec(path);
    if (byName !== null && method === 'GET') {
      const wanted = decodeURIComponent(byName[1] as string);
      const jurisdiction = new Headers(init?.headers).get('cf-r2-jurisdiction');
      const found = state.buckets.find(
        (bucket) => bucket.name === wanted && (state.jurisdictions[wanted] ?? null) === jurisdiction,
      );

      return Promise.resolve(
        found === undefined
          ? refuse(10006, 'The specified bucket does not exist', 404)
          : ok({ name: found.name }),
      );
    }

    if (path === `${account}/r2/buckets` && method === 'GET') {
      return Promise.resolve(ok({ buckets: state.buckets }));
    }
    if (path === `${account}/r2/buckets` && method === 'POST') {
      const { name } = JSON.parse(String(init?.body)) as { name: string };
      const jurisdiction = new Headers(init?.headers).get('cf-r2-jurisdiction');
      if (jurisdiction !== null) state.jurisdictions[name] = jurisdiction;
      if (state.buckets.some((b) => b.name === name)) {
        return Promise.resolve(refuse(10021, 'The bucket you tried to create already exists'));
      }
      state.buckets.push({ name });
      return Promise.resolve(ok({ name }));
    }

    if (path === `${account}/workers/subdomain` && method === 'GET') {
      return state.subdomain === null
        ? Promise.resolve(refuse(10007, 'workers.dev subdomain not found', 404))
        : Promise.resolve(ok({ subdomain: state.subdomain }));
    }
    if (path === `${account}/workers/subdomain` && method === 'PUT') {
      const { subdomain } = JSON.parse(String(init?.body)) as { subdomain: string };
      state.subdomain = subdomain;
      return Promise.resolve(ok({ subdomain }));
    }

    const workersDev = /\/workers\/scripts\/([^/]+)\/subdomain$/.exec(path);
    if (workersDev !== null && method === 'POST') {
      state.workersDev.push(decodeURIComponent(workersDev[1] as string));
      return Promise.resolve(ok({ enabled: true }));
    }

    if (path === account && method === 'GET') {
      return Promise.resolve(ok({ id: CREDENTIALS.accountId }));
    }

    return Promise.resolve(refuse(7003, `no route for ${method} ${path}`, 404));
  };
}

describe('the binding field names, which are not consistent', () => {
  it('names the field Cloudflare actually reads, per binding type', () => {
    // Getting one wrong deploys, reports success, and leaves an undefined binding at
    // runtime. Written down once because there is nothing to search for when it
    // happens.
    expect(BINDING_ID_FIELD).toEqual({
      d1: 'id',
      kv_namespace: 'namespace_id',
      r2_bucket: 'bucket_name',
      queue: 'queue_name',
      vectorize: 'index_name',
    });
  });

  it('does not use the same field for two different types', () => {
    // The asymmetry is the trap. If this ever passes trivially because everything
    // uses `id`, the map has been "tidied" and the tidying is the bug.
    const fields = Object.values(BINDING_ID_FIELD);
    expect(new Set(fields).size).toBe(fields.length);
  });
});

describe('the permissions a token needs', () => {
  it('includes D1, which the obvious Cloudflare template leaves out', () => {
    // "Edit Cloudflare Workers" has Workers Scripts, KV, R2 and Account Settings, and
    // no D1. So the obvious choice provisions everything except the database.
    expect(REQUIRED_TOKEN_PERMISSIONS.some((line) => line.includes('D1'))).toBe(true);
  });
});

describe('creating a database', () => {
  it('makes one when there is none', async () => {
    const state = freshState();
    const { database, created } = await ensureDatabase(api(state), CREDENTIALS, 'baseclf');

    expect(created).toBe(true);
    expect(database.name).toBe('baseclf');
    expect(state.databases).toHaveLength(1);
  });

  it('finds the existing one on a second run, and makes no second database', async () => {
    // D1 tolerates a duplicate name and would happily make a second one, so this is
    // the list doing its job rather than the API protecting anybody.
    const state = freshState();
    const first = await ensureDatabase(api(state), CREDENTIALS, 'baseclf');
    const second = await ensureDatabase(api(state), CREDENTIALS, 'baseclf');

    expect(second.created).toBe(false);
    expect(second.database.uuid).toBe(first.database.uuid);
    expect(state.databases).toHaveLength(1);
  });

  it('asks by name rather than walking every database', async () => {
    const state = freshState();
    await ensureDatabase(api(state), CREDENTIALS, 'baseclf');

    expect(state.calls[0]).toContain('name=baseclf');
  });
});

describe('creating a KV namespace, where a duplicate is a hard failure', () => {
  it('makes one when there is none', async () => {
    const state = freshState();
    const { created, namespace } = await ensureNamespace(api(state), CREDENTIALS, 'baseclf-cache');

    expect(created).toBe(true);
    expect(namespace.title).toBe('baseclf-cache');
  });

  it('finds the existing one on a second run without attempting a create', async () => {
    // The request count, not just the outcome, and a mutation is why. Removing the
    // list leaves the outcome identical, because the conflict handler absorbs the
    // duplicate error and looks again. What the list buys is not making a request
    // that is known to fail, and only the count shows that.
    const state = freshState();
    const fetcher = api(state);
    await ensureNamespace(fetcher, CREDENTIALS, 'baseclf-cache');

    const before = state.calls.length;
    const second = await ensureNamespace(fetcher, CREDENTIALS, 'baseclf-cache');
    const madeOnSecondRun = state.calls.slice(before);

    expect(second.created).toBe(false);
    expect(state.namespaces).toHaveLength(1);
    expect(madeOnSecondRun.filter((call) => call.startsWith('POST'))).toEqual([]);
  });

  it('absorbs a conflict whose code it has never seen, by the message', async () => {
    // Belt and braces, and separately tested because a mutation showed the two paths
    // cover for each other. The documented codes are the first check; a message match
    // is the second, for a code this list has not seen. Absorbing a conflict is safe
    // in a way that failing on one is not, because the resource exists either way.
    const state = freshState();
    const fetcher = api(state);
    let listed = 0;

    const unknownCode: Fetcher = (url, init) => {
      const isList = (init?.method ?? 'GET') === 'GET' && url.includes('/r2/buckets');
      if (isList && listed++ === 0) return Promise.resolve(ok({ buckets: [] }));
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/r2/buckets')) {
        // A code nothing recognises, with a message that says what happened.
        return Promise.resolve(refuse(999_999, 'The bucket you tried to create already exists'));
      }
      return fetcher(url, init);
    };

    const result = await ensureBucket(unknownCode, CREDENTIALS, 'baseclf-objects');
    expect(result.created).toBe(false);
  });

  it('absorbs the duplicate error when the list missed it', async () => {
    // The window between the list and the create. Belt and braces: the resource
    // exists either way, so a conflict is not a failure worth reporting.
    const state = freshState();
    const fetcher = api(state);
    let listed = 0;

    const raced: Fetcher = (url, init) => {
      const isList = (init?.method ?? 'GET') === 'GET' && url.includes('/storage/kv/namespaces');
      if (isList && listed++ === 0) {
        // The first list is empty, then somebody else creates it.
        state.namespaces.push({ id: 'kv_elsewhere', title: 'baseclf-cache' });
        return Promise.resolve(ok([]));
      }
      return fetcher(url, init);
    };

    const result = await ensureNamespace(raced, CREDENTIALS, 'baseclf-cache');

    expect(result.created).toBe(false);
    expect(result.namespace.id).toBe('kv_elsewhere');
    expect(state.namespaces).toHaveLength(1);
  });
});

describe('walking a list that does not fit on one page', () => {
  it('finds a namespace that sits past the first page', async () => {
    // What asking for only the first page did: the namespace was not found, so it
    // was created, so KV hard-failed on the duplicate title, so the code looked
    // again at the same single page and gave up. The account was fine throughout.
    const state = freshState();
    for (let n = 0; n < 150; n += 1) {
      state.namespaces.push({ id: `kv_${n}`, title: `other-${String(n).padStart(3, '0')}` });
    }
    state.namespaces.push({ id: 'kv_wanted', title: 'zz-baseclf-cache' });

    const result = await ensureNamespace(api(state), CREDENTIALS, 'zz-baseclf-cache');

    expect(result.created).toBe(false);
    expect(result.namespace.id).toBe('kv_wanted');
    expect(state.namespaces).toHaveLength(151);
  });

  it('asks for a second page rather than trusting the first to hold everything', async () => {
    const state = freshState();
    for (let n = 0; n < 150; n += 1) {
      state.namespaces.push({ id: `kv_${n}`, title: `other-${String(n).padStart(3, '0')}` });
    }

    await ensureNamespace(api(state), CREDENTIALS, 'zz-baseclf-cache');

    expect(state.calls.some((call) => call.includes('page=2'))).toBe(true);
  });

  it('stops rather than walking forever when a list never says it is done', async () => {
    // Not a hang. An endpoint that answers every page with a full one would spin
    // until the invocation was killed, and nothing would say why.
    const endless: Fetcher = () =>
      Promise.resolve(
        ok(Array.from({ length: 100 }, (_, n) => ({ id: `kv_${n}`, title: `never-${n}` }))),
      );

    await expect(ensureNamespace(endless, CREDENTIALS, 'baseclf-cache')).rejects.toThrow(
      /not advancing|far more than/,
    );
  });
});

describe('creating a bucket', () => {
  it('finds an existing one by name without attempting a create', async () => {
    // The lookup is an optimisation: a conflict on the create is absorbed either
    // way. What it buys is not sending a request that is known to fail, and only
    // the request count shows that, which is the same lesson KV taught.
    const state = freshState();
    state.buckets.push({ name: 'baseclf-objects' });

    const before = state.calls.length;
    const result = await ensureBucket(api(state), CREDENTIALS, 'baseclf-objects');

    expect(result.created).toBe(false);
    expect(state.calls.slice(before).filter((call) => call.startsWith('POST'))).toEqual([]);
  });

  it('is safe to run twice', async () => {
    const state = freshState();
    await ensureBucket(api(state), CREDENTIALS, 'baseclf-objects');
    const second = await ensureBucket(api(state), CREDENTIALS, 'baseclf-objects');

    expect(second.created).toBe(false);
    expect(state.buckets).toHaveLength(1);
  });

  it('sends jurisdiction as a header, not in the body', async () => {
    // The asymmetry that is invisible until a bucket lands in the wrong region.
    const state = freshState();
    await ensureBucket(api(state), CREDENTIALS, 'baseclf-eu', 'eu');

    expect(state.jurisdictions['baseclf-eu']).toBe('eu');
  });
});

describe('the workers.dev subdomain', () => {
  it('creates one when the account has none', async () => {
    const state = freshState();
    const { subdomain, created } = await ensureSubdomain(api(state), CREDENTIALS, 'raspy-firefly');

    expect(created).toBe(true);
    expect(subdomain).toBe('raspy-firefly');
  });

  it('leaves an existing one alone rather than renaming it', async () => {
    // Somebody running this to create a database must not have their account's
    // subdomain changed underneath them. Every URL already handed out depends on it.
    const state = freshState();
    state.subdomain = 'already-chosen';

    const { subdomain, created } = await ensureSubdomain(api(state), CREDENTIALS, 'raspy-firefly');

    expect(created).toBe(false);
    expect(subdomain).toBe('already-chosen');
    expect(state.subdomain).toBe('already-chosen');
  });

  it('does not swallow a failure that is not "no subdomain yet"', async () => {
    // A 404 means the account has none. Anything else is real, and treating it as
    // "none" would follow it with a PUT that overwrites something.
    const state = freshState();
    const fetcher = api(state);
    const broken: Fetcher = (url, init) =>
      url.includes('/workers/subdomain') && (init?.method ?? 'GET') === 'GET'
        ? Promise.resolve(refuse(10000, 'Authentication error', 403))
        : fetcher(url, init);

    await expect(ensureSubdomain(broken, CREDENTIALS, 'raspy-firefly')).rejects.toBeInstanceOf(
      CloudflareError,
    );
    expect(state.subdomain).toBeNull();
  });
});

describe('a refusal that arrives as 200', () => {
  it('is treated as a failure, not as a result', async () => {
    // Cloudflare answers 200 with `success: false` for some failures. A client that
    // trusts the status reports a refusal as a successful provision.
    const refusing: Fetcher = () => Promise.resolve(refuse(10000, 'Authentication error'));

    const error = await ensureDatabase(refusing, CREDENTIALS, 'baseclf').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CloudflareError);
    expect((error as CloudflareError).codes).toContain(10000);
  });

  it('carries the codes through, because they are what a reader can search for', async () => {
    const refusing: Fetcher = () => Promise.resolve(refuse(7003, 'Could not route', 404));
    const error = await ensureDatabase(refusing, CREDENTIALS, 'x').catch((e: unknown) => e);

    expect((error as CloudflareError).status).toBe(404);
    expect((error as CloudflareError).codes).toEqual([7003]);
  });

  it('says what it got when the body is not JSON at all', async () => {
    // An HTML error page from a proxy, which is what a wrong base URL produces.
    const html: Fetcher = () => Promise.resolve(new Response('<html>504</html>', { status: 504 }));
    const error = await ensureDatabase(html, CREDENTIALS, 'x').catch((e: unknown) => e);

    expect((error as CloudflareError).message).toContain('not JSON');
    expect((error as CloudflareError).status).toBe(504);
  });
});

describe('the whole chain, run twice', () => {
  it('changes nothing the second time and fails nothing', async () => {
    // The property that matters most. The first run is the one that gets interrupted,
    // so a second run has to be able to finish it.
    const state = freshState();
    const fetcher = api(state);

    const provision = async () => {
      await ensureSubdomain(fetcher, CREDENTIALS, 'raspy-firefly');
      await ensureDatabase(fetcher, CREDENTIALS, 'baseclf');
      await ensureBucket(fetcher, CREDENTIALS, 'baseclf-objects');
      await ensureNamespace(fetcher, CREDENTIALS, 'baseclf-cache');
      await enableWorkersDev(fetcher, CREDENTIALS, 'baseclf');
    };

    await provision();
    const after = {
      databases: state.databases.length,
      buckets: state.buckets.length,
      namespaces: state.namespaces.length,
      subdomain: state.subdomain,
    };

    await provision();

    expect({
      databases: state.databases.length,
      buckets: state.buckets.length,
      namespaces: state.namespaces.length,
      subdomain: state.subdomain,
    }).toEqual(after);
  });

  it('resumes an interrupted run rather than starting over', async () => {
    // Half provisioned, which is the realistic state to arrive in.
    const state = freshState();
    state.subdomain = 'raspy-firefly';
    state.databases.push({ uuid: 'd1_existing', name: 'baseclf' });

    const fetcher = api(state);
    const database = await ensureDatabase(fetcher, CREDENTIALS, 'baseclf');
    const bucket = await ensureBucket(fetcher, CREDENTIALS, 'baseclf-objects');

    expect(database.created).toBe(false);
    expect(database.database.uuid).toBe('d1_existing');
    expect(bucket.created).toBe(true);
  });
});

describe('uploading the script, which is the step that deploys anything', () => {
  it('sends a multipart body rather than one declared as JSON', async () => {
    // The client sets a JSON content type on every other call. Doing it here replaces
    // the boundary the parts are found with, and the body becomes unreadable.
    const state = freshState();
    await uploadScript(api(state), CREDENTIALS, uploadOptions());

    expect(state.scripts.baseclf?.moduleNames).toEqual(['index.js']);
  });

  it('sends the module as ESM, not as a service worker script', async () => {
    const state = freshState();
    await uploadScript(api(state), CREDENTIALS, uploadOptions());

    expect(state.scripts.baseclf?.moduleTypes['index.js']).toBe(MODULE_CONTENT_TYPE);
  });

  it('names the main module, so the platform knows which part to start', async () => {
    const state = freshState();
    await uploadScript(api(state), CREDENTIALS, uploadOptions());

    expect(state.scripts.baseclf?.mainModule).toBe('index.js');
  });

  it('carries a module the size of the real bundle without truncating it', async () => {
    // Every other test here uses a module of a few dozen bytes, and the engine builds
    // to roughly 1.8 MB. A body that is fine small and lossy large would pass all of
    // them and ship a broken Worker, so this one is the size of the real thing.
    const state = freshState();
    const big = 'x'.repeat(1_800_000);
    await uploadScript(
      api(state),
      CREDENTIALS,
      uploadOptions({ modules: [{ name: 'index.js', content: big }] }),
    );

    expect(state.scripts.baseclf?.moduleNames).toEqual(['index.js']);
    expect(state.receivedModuleBytes['index.js']).toBe(big.length);
  });
});

describe('the compatibility date, whose default is 2021 rather than today', () => {
  it('deploys the date it was given, and never the platform default', async () => {
    const state = freshState();
    await uploadScript(api(state), CREDENTIALS, uploadOptions());

    expect(state.scripts.baseclf?.compatibilityDate).toBe('2026-07-28');
    expect(state.scripts.baseclf?.compatibilityDate).not.toBe(
      PLATFORM_DEFAULT_COMPATIBILITY_DATE,
    );
  });

  it('refuses a malformed date before anything is sent', async () => {
    // Refused here rather than trusted to be rejected there. A value the API ignores
    // fails exactly the way a missing one does, which is silently and in 2021.
    const state = freshState();
    const error = (await uploadScript(
      api(state),
      CREDENTIALS,
      uploadOptions({ compatibilityDate: 'last tuesday' }),
    ).catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(ScriptUploadError);
    expect(error.message).toContain('compatibility_date');
    expect(state.calls).toEqual([]);
  });

  it('refuses an empty date, which is the missing case wearing a different hat', async () => {
    const state = freshState();
    const error = (await uploadScript(
      api(state),
      CREDENTIALS,
      uploadOptions({ compatibilityDate: '' }),
    ).catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(ScriptUploadError);
    expect(error.message).toContain('compatibility_date');
    expect(state.calls).toEqual([]);
  });

  it('keeps nodejs_compat even when the caller passes flags of its own', async () => {
    // Without it `node:crypto` is absent, and the failure lands on the first request
    // that touches auth rather than on the deploy that caused it.
    const state = freshState();
    await uploadScript(
      api(state),
      CREDENTIALS,
      uploadOptions({ compatibilityFlags: ['streaming_tail_worker'] }),
    );

    expect(state.scripts.baseclf?.compatibilityFlags).toContain('nodejs_compat');
    expect(state.scripts.baseclf?.compatibilityFlags).toContain('streaming_tail_worker');
  });

  it('does not list nodejs_compat twice when the caller passes it too', async () => {
    const state = freshState();
    await uploadScript(
      api(state),
      CREDENTIALS,
      uploadOptions({ compatibilityFlags: ['nodejs_compat'] }),
    );

    const flags = state.scripts.baseclf?.compatibilityFlags ?? [];
    expect(flags.filter((flag) => flag === 'nodejs_compat')).toHaveLength(1);
  });

  it('has a required-flags list that is not empty, or the merge guards nothing', () => {
    expect(REQUIRED_COMPATIBILITY_FLAGS.length).toBeGreaterThan(0);
  });
});

describe('bindings_inherit, which decides whether a lost binding is loud', () => {
  it('asks for strict, so an unresolvable inherit is refused', async () => {
    const state = freshState();
    await uploadScript(api(state), CREDENTIALS, uploadOptions());

    expect(state.calls.some((call) => call.includes('bindings_inherit=strict'))).toBe(true);
  });

  it('fails rather than deploying a Worker missing a binding it asked to keep', async () => {
    // The failure this guards against is a redeploy that silently ships without a
    // secret that was set an hour ago. Nothing errors, and every request afterwards
    // is answered by a Worker that cannot verify a token.
    const state = freshState();
    const inherit: readonly ScriptBinding[] = [
      { kind: 'inherit', name: 'BETTER_AUTH_SECRET' },
    ];

    await expect(
      uploadScript(api(state), CREDENTIALS, uploadOptions({ bindings: inherit })),
    ).rejects.toBeInstanceOf(CloudflareError);

    expect(state.scripts.baseclf).toBeUndefined();
  });

  it('carries an inherit through when the binding is actually there', async () => {
    const state = freshState();
    state.existingBindings.baseclf = ['BETTER_AUTH_SECRET'];

    await uploadScript(
      api(state),
      CREDENTIALS,
      uploadOptions({ bindings: [{ kind: 'inherit', name: 'BETTER_AUTH_SECRET' }] }),
    );

    expect(state.scripts.baseclf?.bindings).toEqual([
      { type: 'inherit', name: 'BETTER_AUTH_SECRET' },
    ]);
    expect(state.scripts.baseclf?.droppedInherits).toEqual([]);
  });
});

describe('binding shapes, where the id field differs per type', () => {
  it('puts each resource id under the field Cloudflare reads for that type', async () => {
    const state = freshState();
    const bindings: readonly ScriptBinding[] = [
      { kind: 'resource', type: 'd1', name: 'DB', id: 'd1_1' },
      { kind: 'resource', type: 'kv_namespace', name: 'CACHE', id: 'kv_1' },
      { kind: 'resource', type: 'r2_bucket', name: 'BUCKET', id: 'baseclf-objects' },
    ];

    await uploadScript(api(state), CREDENTIALS, uploadOptions({ bindings }));

    expect(state.scripts.baseclf?.bindings).toEqual([
      { type: 'd1', name: 'DB', id: 'd1_1' },
      { type: 'kv_namespace', name: 'CACHE', namespace_id: 'kv_1' },
      { type: 'r2_bucket', name: 'BUCKET', bucket_name: 'baseclf-objects' },
    ]);
  });

  it('sends a var as plain_text, and has no shape that puts a secret in the body', () => {
    // Secrets go in on their own endpoint. `inherit` is how one already set survives
    // a redeploy, so nothing here ever needs to carry a secret value.
    const text = toApiBinding({ kind: 'text', name: 'BETTER_AUTH_URL', value: 'https://x.dev' });

    expect(text).toEqual({
      type: 'plain_text',
      name: 'BETTER_AUTH_URL',
      text: 'https://x.dev',
    });
  });

  it('refuses two bindings under one name rather than letting the server pick', async () => {
    const state = freshState();
    const clashing: readonly ScriptBinding[] = [
      { kind: 'resource', type: 'd1', name: 'DB', id: 'd1_1' },
      { kind: 'resource', type: 'd1', name: 'DB', id: 'd1_2' },
    ];

    const error = (await uploadScript(
      api(state),
      CREDENTIALS,
      uploadOptions({ bindings: clashing }),
    ).catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(ScriptUploadError);
    expect(error.message).toContain('Two bindings are both named');
    expect(state.calls).toEqual([]);
  });
});

describe('what the upload refuses locally, before spending a request', () => {
  // Each of these asserts the message, not only the type. Four refusals share one
  // error class, and an empty module list satisfies the main-module check too, so a
  // test that reads the type alone passes whichever branch fired. That has already
  // caught this project out twice.
  const refusal = async (overrides: Record<string, unknown>, state: State) =>
    (await uploadScript(api(state), CREDENTIALS, uploadOptions(overrides)).catch(
      (error: unknown) => error,
    )) as Error;

  it('refuses a main module that is not among the modules', async () => {
    const state = freshState();
    const error = await refusal({ mainModule: 'worker.js' }, state);

    expect(error).toBeInstanceOf(ScriptUploadError);
    expect(error.message).toContain('is not among the modules given');
    expect(state.calls).toEqual([]);
  });

  it('refuses two modules under one name, since which part survives is unknown', async () => {
    const state = freshState();
    const error = await refusal(
      { modules: [MODULE, { name: 'index.js', content: 'other' }] },
      state,
    );

    expect(error).toBeInstanceOf(ScriptUploadError);
    expect(error.message).toContain('Two modules are both named');
    expect(state.calls).toEqual([]);
  });

  it('refuses an upload with no modules at all, naming that as the reason', async () => {
    const state = freshState();
    const error = await refusal({ modules: [] }, state);

    expect(error).toBeInstanceOf(ScriptUploadError);
    // Not the main-module message, which an empty list also satisfies.
    expect(error.message).toContain('at least one module');
    expect(state.calls).toEqual([]);
  });
});

describe('observability, which is what makes a broken deployment readable', () => {
  it('is on for every upload rather than left to a caller to remember', async () => {
    const state = freshState();
    await uploadScript(api(state), CREDENTIALS, uploadOptions());

    expect(state.scripts.baseclf?.observability).toEqual({ enabled: true });
  });
});

describe('uploading twice', () => {
  it('replaces rather than accumulating, so a rerun finishes an interrupted one', async () => {
    const state = freshState();
    const fetcher = api(state);

    await uploadScript(fetcher, CREDENTIALS, uploadOptions());
    await uploadScript(fetcher, CREDENTIALS, uploadOptions());

    expect(Object.keys(state.scripts)).toEqual(['baseclf']);
    expect(state.scripts.baseclf?.moduleNames).toEqual(['index.js']);
  });

  it('reports a refusal that arrives as 200 rather than treating it as deployed', async () => {
    const refusing: Fetcher = () => Promise.resolve(refuse(10000, 'Authentication error'));

    const error = await uploadScript(refusing, CREDENTIALS, uploadOptions()).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(CloudflareError);
    expect((error as CloudflareError).codes).toContain(10000);
  });
});
