/**
 * What the auth endpoints actually take and return, measured before `.auth` is built.
 *
 * 🔴 **The shape is not the one `supabase-js` has, and building `.auth` from that
 * habit would produce calls this deployment refuses.** `signInWithOAuth` there
 * redirects the browser; here the flow is a POST that answers with a URL to send the
 * browser to, then a session token in a header, then a second call to exchange it for
 * the JWT the engine verifies. Three steps where the familiar client has one.
 *
 * That is the same trap the data path already walked into once, so this file exists
 * before the code rather than after it. Every assertion here is a fact `.auth` will be
 * built on, and a change in Better Auth turns into a red test rather than into an SDK
 * that emits requests nobody answers.
 *
 * ⚠️ Providers are configured with made-up credentials. Nothing here talks to Google
 * or GitHub: the flow stops at the URL this deployment hands back, which is the last
 * step that belongs to us.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { resetAuth, runAuthMigrations } from '../src/auth/index.js';
import worker, { type Env } from '../src/index.js';

const BASE_URL = 'https://baseclf.test';
const PASSWORD = 'a-password-of-ordinary-length';

const configured = {
  ...env,
  BETTER_AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
  BETTER_AUTH_URL: BASE_URL,
  BETTER_AUTH_EMAIL_PASSWORD: 'true',
  GOOGLE_CLIENT_ID: 'google-id-not-real',
  GOOGLE_CLIENT_SECRET: 'google-secret-not-real',
  GITHUB_CLIENT_ID: 'github-id-not-real',
  GITHUB_CLIENT_SECRET: 'github-secret-not-real',
} as Env;

const call = (path: string, init: RequestInit = {}): Promise<Response> =>
  worker.fetch(new Request(`${BASE_URL}${path}`, init), configured);

/** The session token, which is not the JWT. Keeping the two apart is half of `.auth`. */
let sessionToken: string;

beforeAll(async () => {
  resetAuth();
  await runAuthMigrations(configured);

  const signUp = await call('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'erin@example.test', password: PASSWORD, name: 'Erin' }),
  });
  expect(signUp.status).toBe(200);

  sessionToken = signUp.headers.get('set-auth-token') ?? '';
  expect(sessionToken).not.toBe('');
}, 120_000);

describe('starting a social sign-in', () => {
  it('answers with a URL to send the browser to, rather than redirecting', async () => {
    // ⭐ The difference `.auth` has to carry. `supabase-js` navigates; this hands back
    // a URL and leaves the navigating to the caller, which is the only thing that
    // works in a Worker, in Node, and in a browser without assuming a `window`.
    const response = await call('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'github', callbackURL: `${BASE_URL}/api/auth/token` }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { url?: string; redirect?: boolean };

    console.log(`  sign-in/social keys: ${Object.keys(body).join(', ')}`);
    expect(typeof body.url).toBe('string');
    expect(body.url).toContain('github.com');
  });

  it('refuses a provider this deployment has no credentials for', async () => {
    // Half a provider is no provider: `src/auth/providers.ts` withholds one that is
    // missing either variable, so the endpoint has nothing registered to start.
    const response = await call('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'apple', callbackURL: BASE_URL }),
    });

    console.log(`  unknown provider answers ${response.status}`);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the two tokens, which are not the same token', () => {
  it('hands back a session token in a header, not in the body', async () => {
    // 🔴 The step that is easy to miss, and the one the README calls out as the place
    // people get stuck. The value arrives in `set-auth-token`, so a client reading
    // only the body has a signed-in user and nothing to do with it.
    const signIn = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'erin@example.test', password: PASSWORD }),
    });

    expect(signIn.status).toBe(200);
    expect(signIn.headers.get('set-auth-token')).not.toBeNull();
  });

  it('exchanges the session token for the JWT the engine verifies', async () => {
    // The session token authenticates against Better Auth. The engine's policies take
    // a JWT, and this is where one comes from. Two names, two lifetimes, one flow.
    const response = await call('/api/auth/token', {
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { token?: string };

    console.log(`  /api/auth/token keys: ${Object.keys(body).join(', ')}`);
    expect(typeof body.token).toBe('string');
    expect(body.token?.split('.')).toHaveLength(3);
  });

  it('refuses to mint a JWT without a session', async () => {
    const response = await call('/api/auth/token');

    console.log(`  /api/auth/token with no session answers ${response.status}`);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('reading and ending a session', () => {
  it('describes the signed-in user, and says which fields it gives', async () => {
    const response = await call('/api/auth/get-session', {
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { user?: Record<string, unknown> } | null;

    console.log(`  get-session user keys: ${Object.keys(body?.user ?? {}).join(', ')}`);
    expect(body?.user?.['email']).toBe('erin@example.test');
  });

  it('answers with no user rather than an error when there is no session', async () => {
    // ⚠️ Worth knowing before `.auth.getUser()` is written: this is not a 401, so a
    // client that treated any non-200 as "signed out" would be right by accident and
    // wrong the first time the deployment had a real problem.
    const response = await call('/api/auth/get-session');
    const text = await response.text();

    console.log(
      `  get-session with no session answers ${response.status}, body ${text || '(empty)'}`,
    );
    expect(response.status).toBe(200);
  });

  it('ends the session, after which the same token buys nothing', async () => {
    const signIn = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'erin@example.test', password: PASSWORD }),
    });
    const doomed = signIn.headers.get('set-auth-token') ?? '';

    const out = await call('/api/auth/sign-out', {
      method: 'POST',
      headers: { authorization: `Bearer ${doomed}`, 'content-type': 'application/json' },
    });
    console.log(`  sign-out answers ${out.status}`);
    expect(out.status).toBe(200);

    // ⭐ The assertion that makes the one above mean something: a sign-out that
    // answered 200 and left the token working is the failure worth catching.
    const after = await call('/api/auth/get-session', {
      headers: { authorization: `Bearer ${doomed}` },
    });
    const body = (await after.json()) as { user?: unknown } | null;

    expect(body?.user ?? null).toBeNull();
  });
});
