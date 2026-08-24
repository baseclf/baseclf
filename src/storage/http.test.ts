/**
 * The storage path over HTTP, from a URL to an object and back.
 *
 * The unit tests around `policy.ts` and `router.ts` prove the decisions. This one
 * proves the wiring: that a real request reaches them, that the identity comes
 * from the token rather than from anything in the path, and that the shape of the
 * URL is doing the work it is supposed to.
 *
 * The URL shape is the part worth testing here rather than anywhere else. A file
 * name cannot contain a separator because a third path segment does not parse, so
 * the defence is the route and not a check inside it. That is only true while the
 * route is written that way.
 */

import { env } from 'cloudflare:workers';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { bearer, jwt } from 'better-auth/plugins';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import worker, { type Env } from '../index.js';
import { seedDatabase, seedStandardPolicies } from '../policy/__fixtures__/schema.js';
import { resetRegistry } from '../policy/registry.js';
import { resetStorageRegistry } from './registry.js';
import { STORAGE_SCHEMA } from './schema.js';

const BASE_URL = 'https://baseclf.test';
const SECRET = 'test-secret-not-used-to-sign-anything-real';

const deployment: Env = {
  ...env,
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: BASE_URL,
  BETTER_AUTH_TRUSTED_ORIGINS: 'https://app.example.test',
};

/**
 * A signed-in caller, minted by the real issuer.
 *
 * Through Better Auth rather than hand-signed, because the point of this file is
 * that the wiring works end to end, and a token this worker's own verifier accepts
 * is part of that.
 */
const authOptions = {
  database: env.DB,
  secret: SECRET,
  baseURL: BASE_URL,
  emailAndPassword: { enabled: true },
  plugins: [
    bearer(),
    jwt({
      jwks: { keyPairConfig: { alg: 'ES256' as const } },
      jwt: {
        definePayload: ({ user }: { user: { email: string } }) => ({
          email: user.email,
          role: 'authenticated',
        }),
      },
    }),
  ],
};

const realFetch = globalThis.fetch;
let token = '';
let uid = '';

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeAll(async () => {
  const issuer = betterAuth(authOptions);

  // The verifier fetches JWKS from this same worker, so that one URL is routed
  // back into the issuer and everything else is refused loudly.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(`${BASE_URL}/api/auth/jwks`)) {
      return issuer.handler(new Request(url, { method: 'GET' }));
    }
    throw new Error(`unexpected outbound request in a test: ${url}`);
  }) as typeof fetch;

  await (await getMigrations(authOptions)).runMigrations();

  // The REST side is seeded too, and not for its own sake. The I8 tests at the
  // bottom have to show that an engine table is refused *because of its prefix*,
  // and that only means something if an ordinary exposed table answers 200 in the
  // same run. Without this the registry cannot load at all and every REST request
  // answers 500, which is fail-closed and proves nothing about I8.
  await seedDatabase(env.DB);
  await seedStandardPolicies(env.DB);
  resetRegistry();

  for (const statement of STORAGE_SCHEMA) {
    await env.DB.prepare(statement).run();
  }
  await env.DB.prepare('DELETE FROM _storage_policies').run();
  await env.DB.prepare('DELETE FROM _storage_buckets').run();

  await env.DB.prepare('INSERT INTO _storage_buckets (bucket, enabled, version) VALUES (?, 1, 1)')
    .bind('avatars')
    .run();

  const insert = env.DB.prepare(
    'INSERT INTO _storage_policies (bucket, name, operation, roles, prefix, max_size_bytes,' +
      ' mime_types) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  await env.DB.batch([
    insert.bind(
      'avatars',
      'upload_own',
      'upload',
      '["authenticated"]',
      'avatars/$auth.uid/',
      1024,
      '["image/png"]',
    ),
    insert.bind(
      'avatars',
      'read_own',
      'download',
      '["authenticated"]',
      'avatars/$auth.uid/',
      null,
      null,
    ),
    insert.bind(
      'avatars',
      'delete_own',
      'delete',
      '["authenticated"]',
      'avatars/$auth.uid/',
      null,
      null,
    ),
    insert.bind(
      'avatars',
      'list_own',
      'list',
      '["authenticated"]',
      'avatars/$auth.uid/',
      null,
      null,
    ),
  ]);
  resetStorageRegistry();

  const signUp = await issuer.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'storage@example.test',
        password: 'a-password-of-ordinary-length',
        name: 'Storage',
      }),
    }),
  );

  const minted = await issuer.handler(
    new Request(`${BASE_URL}/api/auth/token`, {
      method: 'GET',
      headers: { authorization: `Bearer ${signUp.headers.get('set-auth-token')}` },
    }),
  );
  token = ((await minted.json()) as { token: string }).token;
  uid = String(JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))).sub);
}, 60_000);

function call(path: string, init: RequestInit & { signedIn?: boolean } = {}): Promise<Response> {
  const { signedIn = true, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('CF-Connecting-IP', '198.51.100.7');
  if (signedIn) headers.set('authorization', `Bearer ${token}`);

  return worker.fetch(new Request(`${BASE_URL}${path}`, { ...rest, headers }), deployment);
}

function png(bytes: number): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'image/png', 'content-length': String(bytes) },
    body: new Uint8Array(bytes).fill(65),
  };
}

describe('an object over HTTP', () => {
  it('is uploaded, read back, and deleted', async () => {
    const created = await call('/storage/v1/avatars/me.png', png(64));
    expect(created.status).toBe(201);

    // The key comes back because the caller did not choose it, and it is the only
    // way they can address what they just uploaded.
    const body = (await created.json()) as { key: string; etag: string };
    expect(body.key).toBe(`avatars/${uid}/me.png`);
    expect(body.etag).toBeTruthy();

    const read = await call('/storage/v1/avatars/me.png');
    expect(read.status).toBe(200);
    expect(read.headers.get('content-type')).toBe('image/png');
    expect((await read.arrayBuffer()).byteLength).toBe(64);

    expect((await call('/storage/v1/avatars/me.png', { method: 'DELETE' })).status).toBe(204);
    expect((await call('/storage/v1/avatars/me.png')).status).toBe(404);
  });

  it('is refused for a caller with no token, because anon has no policy', async () => {
    const response = await call('/storage/v1/avatars/me.png', { ...png(8), signedIn: false });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found.', code: 'NOT_FOUND' });
  });

  it('is refused for a method the path does not offer', async () => {
    const response = await call('/storage/v1/avatars/me.png', { method: 'PATCH' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toContain('PUT');
  });
});

/**
 * Debt 59, end to end.
 *
 * The unit tests prove the decisions; this proves that a real request reaches
 * them, and above all that what comes back is a set of NAMES. A listing that
 * handed out keys would hand every caller a path, and every other operation here
 * is built on them never having one.
 */
describe('a listing over HTTP', () => {
  it('returns the names in the caller own directory, and nothing else', async () => {
    await call('/storage/v1/avatars/one.png', png(8));
    await call('/storage/v1/avatars/two.png', png(8));
    // Somebody else's object, written straight to R2 so no policy is involved.
    await env.BUCKET.put('avatars/u_somebody/theirs.png', 'x');

    const response = await call('/storage/v1/avatars');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      objects: { name: string; size: number }[];
      folders: number;
      truncated: boolean;
    };

    expect(body.objects.map((object) => object.name).sort()).toEqual(['one.png', 'two.png']);
    // Names, not keys. The assertion that says the boundary held.
    for (const object of body.objects) expect(object.name).not.toContain('/');
    expect(body.truncated).toBe(false);

    await env.BUCKET.delete('avatars/u_somebody/theirs.png');
    await call('/storage/v1/avatars/one.png', { method: 'DELETE' });
    await call('/storage/v1/avatars/two.png', { method: 'DELETE' });
  });

  it('is refused for a caller with no token, because anon has no list policy', async () => {
    const response = await call('/storage/v1/avatars', { signedIn: false });
    expect(response.status).toBe(404);
  });

  it('counts a directory it cannot address rather than pretending it is not there', async () => {
    // `wrangler r2 object put` can write a nested key even though this API cannot,
    // and such an object has no name a download could take back. Reporting the
    // count keeps a screen from calling the directory empty when it is not.
    await env.BUCKET.put(`avatars/${uid}/old/archived.png`, 'x');

    const body = (await (await call('/storage/v1/avatars')).json()) as {
      objects: unknown[];
      folders: number;
    };

    expect(body.objects).toHaveLength(0);
    expect(body.folders).toBe(1);

    await env.BUCKET.delete(`avatars/${uid}/old/archived.png`);
  });

  it('resumes from a name, and refuses one that reaches out of the directory', async () => {
    await call('/storage/v1/avatars/a.png', png(8));
    await call('/storage/v1/avatars/b.png', png(8));

    const after = (await (await call('/storage/v1/avatars?after=a.png')).json()) as {
      objects: { name: string }[];
    };
    expect(after.objects.map((object) => object.name)).toEqual(['b.png']);

    // A name is all a caller may hand back, so this is the only escape to try.
    expect((await call('/storage/v1/avatars?after=../u_somebody/x.png')).status).toBe(404);

    await call('/storage/v1/avatars/a.png', { method: 'DELETE' });
    await call('/storage/v1/avatars/b.png', { method: 'DELETE' });
  });
});

describe('the shape of the URL, which is the defence rather than a check', () => {
  it('does not route a path with a third segment', async () => {
    // A file name cannot contain a separator because this does not parse as a
    // storage request at all. Nothing inside has to reject it.
    const response = await call('/storage/v1/avatars/nested/me.png', png(8));

    expect(response.status).toBe(404);
    expect(await env.BUCKET.head('avatars/nested/me.png')).toBeNull();
  });

  it('routes a path with one segment to a listing, and to nothing else', async () => {
    // Changed on 2026-08-24 with debt 59. One segment used to route nowhere; it
    // is now a listing, and the two-segment rule above is untouched, so the
    // segment count still decides which of the two a path is and a third segment
    // is still neither.
    expect((await call('/storage/v1/avatars')).status).toBe(200);
    expect((await call('/storage/v1/avatars', png(8))).status).toBe(405);
  });

  it('refuses an encoded separator, at the layer after the route', async () => {
    // Two layers, and the order is deliberate. The path is split before it is
    // decoded, so `%2F` stays one segment and cannot become two. Decoding then
    // produces a name with a separator in it, which the policy refuses. Either
    // layer alone would be enough; neither is relied on alone.
    const response = await call(`/storage/v1/avatars/..%2F${uid}%2Fescaped.png`, png(8));

    expect(response.status).toBe(404);
    expect(await env.BUCKET.head(`avatars/${uid}/escaped.png`)).toBeNull();
  });

  it('refuses a malformed escape rather than taking it literally', async () => {
    // `%zz` is not an escape. Taking the raw text would give a second spelling for
    // the same object, which is how two names for one key end up disagreeing about
    // who owns it.
    expect((await call('/storage/v1/avatars/bad%zz.png', png(8))).status).toBe(404);
  });

  it('refuses an unregistered bucket the same way as a missing object', async () => {
    const unknown = await call('/storage/v1/not-a-bucket/me.png', png(8));
    const missing = await call('/storage/v1/avatars/never-uploaded.png');

    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual(await missing.json());
  });
});

describe('the limits, enforced over HTTP', () => {
  it('refuses an upload declaring more than the policy allows', async () => {
    expect((await call('/storage/v1/avatars/big.png', png(2048))).status).toBe(413);
  });

  it('refuses an upload with a type the policy does not list', async () => {
    const response = await call('/storage/v1/avatars/doc.png', {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf', 'content-length': '8' },
      body: new Uint8Array(8),
    });

    expect(response.status).toBe(415);
  });

  it('refuses an upload that declares no length', async () => {
    // Built by hand, because passing a buffer makes the runtime set the header.
    const response = await worker.fetch(
      new Request(`${BASE_URL}/storage/v1/avatars/unbounded.png`, {
        method: 'PUT',
        headers: {
          'content-type': 'image/png',
          authorization: `Bearer ${token}`,
          'CF-Connecting-IP': '198.51.100.7',
        },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit),
      deployment,
    );

    expect(response.status).toBe(411);
  });
});

describe('CORS on the storage path', () => {
  it('allows a preflight for PUT, which the upload path needs', async () => {
    // This is a regression test for a real bug. PUT was missing from
    // ALLOWED_METHODS when the storage route was added, so a browser preflighting
    // an upload was refused and the console said nothing about a method.
    const response = await worker.fetch(
      new Request(`${BASE_URL}/storage/v1/avatars/me.png`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example.test',
          'Access-Control-Request-Method': 'PUT',
          'CF-Connecting-IP': '198.51.100.7',
        },
      }),
      deployment,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain('PUT');
  });

  it('carries CORS headers on a storage refusal, so the browser shows the status', async () => {
    const response = await worker.fetch(
      new Request(`${BASE_URL}/storage/v1/avatars/nope.png`, {
        method: 'GET',
        headers: {
          Origin: 'https://app.example.test',
          authorization: `Bearer ${token}`,
          'CF-Connecting-IP': '198.51.100.7',
        },
      }),
      deployment,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
  });
});

/**
 * Invariant I8 for the three tables this slice added.
 *
 * The `_` prefix is what keeps them off the API, and I8 asks for that in two
 * independent places so that neither has to be right on its own. Both already
 * existed and neither needed changing, which is the point of the convention. This
 * asserts it rather than assuming it, because "it inherits the protection" is a
 * claim and the tables are new.
 */
describe('the storage tables are never reachable through REST', () => {
  const engineTables = ['_storage_objects', '_storage_policies', '_storage_buckets'];

  it('lets an ordinary exposed table through, so the refusals below mean something', async () => {
    // The control. If this were 404 as well, the tests after it would pass for the
    // wrong reason: nothing exposed rather than this prefix refused.
    expect((await call('/rest/v1/posts')).status).toBe(200);
  });

  it('refuses a read of each one', async () => {
    for (const table of engineTables) {
      const response = await call(`/rest/v1/${table}`);

      expect(response.status, `${table} answered ${response.status}`).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not found.', code: 'NOT_FOUND' });
    }
  });

  it('refuses a write to each one', async () => {
    for (const table of engineTables) {
      const response = await call(`/rest/v1/${table}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'avatars/anything.png' }),
      });

      expect(response.status, `${table} answered ${response.status}`).toBe(404);
    }
  });

  it('still refuses one that somebody added to _exposed_tables on purpose', async () => {
    // The second of the two places. A migration bug, or somebody being clever with
    // `wrangler d1 execute`, can put an engine table in the exposure list. The
    // registry drops such a row at load, so the router never gets the chance, and
    // the router would refuse it anyway.
    await env.DB.prepare(
      'INSERT OR REPLACE INTO _exposed_tables (table_name, enabled, version) VALUES (?, 1, 1)',
    )
      .bind('_storage_objects')
      .run();

    try {
      const response = await call('/rest/v1/_storage_objects');
      expect(response.status).toBe(404);
    } finally {
      await env.DB.prepare('DELETE FROM _exposed_tables WHERE table_name = ?')
        .bind('_storage_objects')
        .run();
    }
  });
});
