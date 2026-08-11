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
  REQUIRED_TOKEN_PERMISSIONS,
} from './cloudflare.js';

const CREDENTIALS: Credentials = { accountId: 'acct_7f3c91', token: 'cfut_not-a-real-token' };

interface State {
  databases: { uuid: string; name: string }[];
  namespaces: { id: string; title: string }[];
  buckets: { name: string }[];
  subdomain: string | null;
  workersDev: string[];
  /** Every request made, so a test can assert how many calls a run costs. */
  calls: string[];
  jurisdictions: Record<string, string>;
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
  };
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

  return (rawUrl, init) => {
    const url = new URL(rawUrl);
    const path = url.pathname.replace('/client/v4', '');
    const method = init?.method ?? 'GET';
    state.calls.push(`${method} ${path}${url.search}`);

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
      // No title filter. A page walk is the only option.
      return Promise.resolve(ok(state.namespaces));
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

describe('creating a bucket', () => {
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
