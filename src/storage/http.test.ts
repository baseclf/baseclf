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

describe('the shape of the URL, which is the defence rather than a check', () => {
  it('does not route a path with a third segment', async () => {
    // A file name cannot contain a separator because this does not parse as a
    // storage request at all. Nothing inside has to reject it.
    const response = await call('/storage/v1/avatars/nested/me.png', png(8));

    expect(response.status).toBe(404);
    expect(await env.BUCKET.head('avatars/nested/me.png')).toBeNull();
  });

  it('does not route a path with one segment', async () => {
    expect((await call('/storage/v1/avatars', png(8))).status).toBe(404);
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
