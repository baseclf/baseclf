/**
 * `.auth`, driven against the real endpoints it was measured from.
 *
 * The measurements live in `auth-surface.test.ts` and this is what was built on them.
 * The two files are separate on purpose: one asserts what the deployment does, so a
 * change in Better Auth is a red test there rather than a client that emits requests
 * nobody answers; this one asserts what the client does with those answers.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { resetAuth, runAuthMigrations } from '../src/auth/index.js';
import { resetCatalogue } from '../src/db/introspect.js';
import worker, { type Env } from '../src/index.js';
import { seedDatabase, seedStandardPolicies } from '../src/policy/__fixtures__/schema.js';
import { resetRegistry } from '../src/policy/registry.js';
import { createClient } from './index.js';

const BASE_URL = 'https://baseclf.test';
const PASSWORD = 'a-password-of-ordinary-length';

const configured = {
  ...env,
  BETTER_AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
  BETTER_AUTH_URL: BASE_URL,
  BETTER_AUTH_EMAIL_PASSWORD: 'true',
  GITHUB_CLIENT_ID: 'github-id-not-real',
  GITHUB_CLIENT_SECRET: 'github-secret-not-real',
} as Env;

const intoWorker = (url: string, init?: RequestInit): Promise<Response> =>
  worker.fetch(new Request(url, init), configured);

const client = () => createClient(BASE_URL, { fetch: intoWorker });

beforeAll(async () => {
  await seedDatabase(env.DB);
  await seedStandardPolicies(env.DB);
  resetCatalogue();
  resetRegistry();
  resetAuth();
  await runAuthMigrations(configured);
}, 120_000);

describe('starting a social sign-in', () => {
  it('hands back the address rather than navigating to it', async () => {
    // ⭐ The difference that makes this usable outside a page. Reaching for
    // `window.location` would work in a browser and throw in the Node process an
    // application uses on its server, which is the same object.
    const { data, error } = await client().auth.signInWithOAuth({
      provider: 'github',
      callbackURL: `${BASE_URL}/callback`,
    });

    expect(error).toBeNull();
    expect(data?.url).toContain('github.com');
  });

  it('says the provider is not configured rather than repeating a 404', async () => {
    // Taken out rather than set to undefined, because the type says they are strings
    // and half a provider is no provider: `src/auth/providers.ts` withholds one that
    // is missing either variable, so nothing is registered to start.
    const {
      GITHUB_CLIENT_ID: _id,
      GITHUB_CLIENT_SECRET: _secret,
      ...withoutGithub
    } = configured;

    const bare = createClient(BASE_URL, {
      fetch: (url, init) => worker.fetch(new Request(url, init), withoutGithub as Env),
    });

    const { data, error } = await bare.auth.signInWithOAuth({
      provider: 'github',
      callbackURL: `${BASE_URL}/callback`,
    });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });
});

describe('the two tokens', () => {
  it('captures the session from the header, which is not in the body', async () => {
    // 🔴 The step the README calls the one people get stuck on. A client reading only
    // the body ends up with a signed-in user and nothing to do with it.
    const signed = client();
    const { data, error } = await signed.auth.signUp({
      email: 'frank@example.test',
      password: PASSWORD,
      name: 'Frank',
    });

    expect(error).toBeNull();
    expect(data?.user.email).toBe('frank@example.test');
    expect(signed.auth.getSession()).not.toBeNull();
  });

  it('exchanges the session for a JWT, and they are different tokens', async () => {
    const signed = client();
    await signed.auth.signUp({ email: 'gina@example.test', password: PASSWORD, name: 'Gina' });

    const jwt = await signed.auth.getToken();

    expect(jwt).not.toBeNull();
    expect(jwt).not.toBe(signed.auth.getSession());
    // Three parts, because the engine verifies this one and not the other.
    expect(jwt?.split('.')).toHaveLength(3);
  });

  it('reuses the JWT it already has rather than exchanging on every call', async () => {
    // ⚠️ Nine hundred seconds of life, measured. Exchanging per request would be a
    // round trip on every query for a token that had 899 seconds left.
    const exchanges: string[] = [];
    const counting = (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/api/auth/token')) exchanges.push(url);
      return intoWorker(url, init);
    };

    const signed = createClient(BASE_URL, { fetch: counting });
    await signed.auth.signUp({ email: 'hana@example.test', password: PASSWORD, name: 'Hana' });

    await signed.auth.getToken();
    await signed.auth.getToken();
    await signed.auth.getToken();

    expect(exchanges).toHaveLength(1);
  });

  it('gives nothing when nobody is signed in, without asking the deployment', async () => {
    const requests: string[] = [];
    const counting = (url: string, init?: RequestInit): Promise<Response> => {
      requests.push(url);
      return intoWorker(url, init);
    };

    const anonymous = createClient(BASE_URL, { fetch: counting });

    expect(await anonymous.auth.getToken()).toBeNull();
    expect(requests).toEqual([]);
  });
});

describe('who is signed in', () => {
  it('describes the user', async () => {
    const signed = client();
    await signed.auth.signUp({ email: 'iris@example.test', password: PASSWORD, name: 'Iris' });

    const { data, error } = await signed.auth.getUser();

    expect(error).toBeNull();
    expect(data?.user?.email).toBe('iris@example.test');
  });

  it('answers "nobody" rather than an error when nobody is', async () => {
    // 🔴 Measured: signed out is a 200 with a body of `null`, not a 401. A client that
    // treated any non-200 as signed out would be right by accident, and wrong the
    // first time the deployment had a real problem, which is exactly the case where
    // somebody needs to be told that something is broken.
    const { data, error } = await client().auth.getUser();

    expect(error).toBeNull();
    expect(data?.user).toBeNull();
  });
});

describe('signing out', () => {
  it('drops the session, and the JWT with it', async () => {
    const signed = client();
    await signed.auth.signUp({ email: 'jo@example.test', password: PASSWORD, name: 'Jo' });
    expect(await signed.auth.getToken()).not.toBeNull();

    const { error } = await signed.auth.signOut();

    expect(error).toBeNull();
    expect(signed.auth.getSession()).toBeNull();
    expect(await signed.auth.getToken()).toBeNull();
  });

  it('is safe to call when nobody is signed in', async () => {
    const { error } = await client().auth.signOut();

    expect(error).toBeNull();
  });
});

describe('what the identity does to a query', () => {
  it('⭐ signs the data request with the JWT, without being handed one', async () => {
    // The join between the two halves. Nothing tells `from()` about a token: it asks
    // `auth`, which exchanges the session it captured at sign-up.
    const signed = client();
    await signed.auth.signUp({ email: 'kit@example.test', password: PASSWORD, name: 'Kit' });

    const written = await signed
      .from('posts')
      .insert({
        id: 'p_sdk_auth',
        title: 'Written by a signed in client',
        body: 'body',
        status: 'draft',
        org_id: 'org_1',
        created_at: '2026-08-16T00:00:00Z',
      })
      .single();

    // A write at all is the proof: the anonymous role has no write policy here, so
    // this only succeeds if the request carried the identity.
    expect(written.error).toBeNull();
    expect(written.data?.['id']).toBe('p_sdk_auth');
  });

  it('goes back to anonymous after signing out', async () => {
    // ⚠️ The other direction, and the one that would be a leak rather than a bug: a
    // client still sending the token of somebody who signed out.
    const signed = client();
    await signed.auth.signUp({ email: 'lee@example.test', password: PASSWORD, name: 'Lee' });
    await signed.auth.signOut();

    const sent: (string | null)[] = [];
    const watching = createClient(BASE_URL, {
      fetch: (url, init) => {
        sent.push(new Headers(init?.headers).get('authorization'));
        return intoWorker(url, init);
      },
    });
    watching.auth.setSession(null);
    await watching.from('posts').select('id');

    expect(sent).toEqual([null]);
  });

  it('lets an explicit token win over a signed-in session', async () => {
    // A server that verified a token already is being deliberate. A session picked up
    // somewhere else quietly overriding it would send a request as somebody other than
    // the caller meant.
    const sent: (string | null)[] = [];
    const explicit = createClient(BASE_URL, {
      token: 'a-token-the-caller-chose',
      fetch: (url, init) => {
        sent.push(new Headers(init?.headers).get('authorization'));
        return intoWorker(url, init);
      },
    });

    await explicit.auth.signUp({ email: 'mo@example.test', password: PASSWORD, name: 'Mo' });
    await explicit.from('posts').select('id');

    expect(sent.at(-1)).toBe('Bearer a-token-the-caller-chose');
  });
});

describe('a JWT that has aged out, which is the case a client cannot wait for', () => {
  /** A clock the test moves by hand, so 900 seconds costs nothing to cross. */
  function clock(): { now: () => number; advance: (seconds: number) => void } {
    let value = Date.now();
    return {
      now: () => value,
      advance: (seconds) => {
        value += seconds * 1000;
      },
    };
  }

  it('exchanges again once the token is near its end', async () => {
    // 🔴 Measured at 900 seconds. Without this the client works for a quarter of an
    // hour and then every request is a 401, which reads as a policy refusal rather
    // than as a token nobody refreshed.
    const time = clock();
    const exchanges: string[] = [];
    const counting = (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/api/auth/token')) exchanges.push(url);
      return intoWorker(url, init);
    };

    const signed = createClient(BASE_URL, { fetch: counting, now: time.now });
    await signed.auth.signUp({ email: 'nia@example.test', password: PASSWORD, name: 'Nia' });

    const first = await signed.auth.getToken();
    expect(exchanges).toHaveLength(1);

    // Still well inside the window: no second exchange.
    time.advance(600);
    expect(await signed.auth.getToken()).toBe(first);
    expect(exchanges).toHaveLength(1);

    // Past the refresh margin, so it goes and gets another one.
    time.advance(300);
    const second = await signed.auth.getToken();

    expect(exchanges).toHaveLength(2);
    expect(second).not.toBeNull();
  });

  it('gives nothing rather than the stale token when the exchange fails', async () => {
    // ⚠️ Failing closed. Sending an expired token produces a 401 from the engine,
    // which a caller reads as "the policy refused me" rather than as "this client
    // could not refresh", and those two send somebody to different places.
    const time = clock();
    let refuse = false;
    const breaking = (url: string, init?: RequestInit): Promise<Response> => {
      if (refuse && url.endsWith('/api/auth/token')) {
        return Promise.resolve(new Response('{"message":"no"}', { status: 401 }));
      }
      return intoWorker(url, init);
    };

    const signed = createClient(BASE_URL, { fetch: breaking, now: time.now });
    await signed.auth.signUp({ email: 'omar@example.test', password: PASSWORD, name: 'Omar' });

    expect(await signed.auth.getToken()).not.toBeNull();

    refuse = true;
    time.advance(900);

    expect(await signed.auth.getToken()).toBeNull();
  });
});
