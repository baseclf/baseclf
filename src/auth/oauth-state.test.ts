/**
 * The OAuth callback reaching the provider exchange instead of dying on a cookie.
 *
 * 🔴 What this is really testing, because a test that only read the config would be
 * worth very little. Better Auth stores the OAuth state twice: a row in
 * `verification`, and a signed cookie named `state`. The sign-in that creates them is
 * a cross-origin POST from the application, and this Worker does not return
 * `Access-Control-Allow-Credentials`, so a browser never stores that cookie. Without
 * `skipStateCookieCheck` the callback then refuses every sign-in that ever worked,
 * with `state_mismatch`, after the reader has already authorised the application at
 * the provider. Measured on a live deployment before this was changed.
 *
 * The observable difference is which failure the callback reaches. A request carrying
 * a real `state` and no cookie either stops at the state check, or gets past it and
 * fails later trying to redeem a code the provider never issued. Those are different
 * errors, and telling them apart is the whole assertion.
 *
 * ⚠️ What it does not cover: the provider half. Nothing here can make GitHub answer,
 * so a complete sign-in is proved by doing one, not by this file.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import worker, { type Env } from '../index.js';
import { ensureAuthSchema } from './bootstrap.js';

const BASE_URL = 'https://engine.test';
const APP_ORIGIN = 'https://app.test';

/** A deployment with GitHub configured. The values never reach GitHub in this file. */
const configured = {
  ...env,
  BETTER_AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
  BETTER_AUTH_URL: BASE_URL,
  BETTER_AUTH_TRUSTED_ORIGINS: APP_ORIGIN,
  GITHUB_CLIENT_ID: 'test-github-client-id',
  GITHUB_CLIENT_SECRET: 'test-github-client-secret',
} as unknown as Env;

const call = (path: string, init?: RequestInit): Promise<Response> =>
  worker.fetch(new Request(`${BASE_URL}${path}`, init), configured);

beforeAll(async () => {
  await ensureAuthSchema(env.DB, configured);
});

/** Starts a sign-in the way the application does, and returns the state issued. */
async function beginSignIn(): Promise<string> {
  const response = await call('/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
    body: JSON.stringify({ provider: 'github', callbackURL: APP_ORIGIN }),
  });

  expect(response.status).toBe(200);
  const body = (await response.json()) as { url?: string };
  const state = new URL(body.url ?? '').searchParams.get('state');
  expect(state).not.toBeNull();
  return state as string;
}

describe('the OAuth callback, arriving without the cookie a cross-origin sign-in cannot set', () => {
  it('gets past the state check rather than refusing a sign-in that worked', async () => {
    const state = await beginSignIn();

    // No cookie header, which is exactly what a browser sends here after a
    // cross-origin sign-in: it never stored one.
    const back = await call(`/api/auth/callback/github?state=${state}&code=not-a-real-code`);

    const destination = back.headers.get('location') ?? '';
    expect(destination).not.toContain('state_mismatch');
    // It fails somewhere, because the code is invented. Failing on the code is the
    // provider's business; failing on the state was ours.
    expect(destination).toContain('error');
  });

  it('still refuses a state that was never issued', async () => {
    // 🔴 The half that has to keep working. Skipping the cookie check does not make
    // the state ornamental: the verification row is what proves the flow was started
    // here, and a state with no row behind it has to be refused.
    const back = await call('/api/auth/callback/github?state=never-issued&code=x');

    expect(back.headers.get('location') ?? '').toContain('state_mismatch');
  });

  it('refuses a state that has already been spent', async () => {
    // Single use is the property doing most of the work now that the cookie is gone.
    // The row is deleted on first use, so a replay looks like a state nobody issued.
    const state = await beginSignIn();

    await call(`/api/auth/callback/github?state=${state}&code=first`);
    const replayed = await call(`/api/auth/callback/github?state=${state}&code=second`);

    expect(replayed.headers.get('location') ?? '').toContain('state_mismatch');
  });
});
