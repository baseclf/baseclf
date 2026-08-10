/**
 * What a deployment can offer, and what it says when it cannot.
 *
 * The invariants under test are about the difference between three states that
 * are easy to collapse into two: configured, absent, and half configured. The
 * third one is the interesting one. It has to behave like absent, because a
 * client id without a secret cannot complete a sign-in, while being reported
 * unlike absent, because somebody believed they had set it up.
 */

import { env } from 'cloudflare:workers';
import { betterAuth } from 'better-auth';
import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_VARIABLES,
  callbackUrl,
  type ProviderEnv,
  providerStatuses,
  socialProviders,
} from './providers.js';

const BASE_URL = 'https://baseclf-abc123.example.workers.dev';

/**
 * Fake credentials carrying a marker that would be unmistakable if it ever
 * turned up somewhere it should not. Not secrets: they authenticate nothing.
 */
const CANARY = 'canary-8f21c7-must-not-be-reported';
const GOOGLE_ID = `google-id-${CANARY}`;
const GOOGLE_SECRET = `google-secret-${CANARY}`;
const GITHUB_ID = `github-id-${CANARY}`;
const GITHUB_SECRET = `github-secret-${CANARY}`;

const fullyConfigured: ProviderEnv = {
  GOOGLE_CLIENT_ID: GOOGLE_ID,
  GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
  GITHUB_CLIENT_ID: GITHUB_ID,
  GITHUB_CLIENT_SECRET: GITHUB_SECRET,
};

function statusFor(provider: 'google' | 'github', on: ProviderEnv) {
  const status = providerStatuses(on, BASE_URL).find((entry) => entry.provider === provider);
  if (status === undefined) throw new Error(`no status reported for ${provider}`);
  return status;
}

describe('a provider that is only half set up', () => {
  it('counts as not configured', () => {
    const status = statusFor('google', { GOOGLE_CLIENT_ID: GOOGLE_ID });
    expect(status.configured).toBe(false);
  });

  it('names the variable that is missing, and only that one', () => {
    const status = statusFor('google', { GOOGLE_CLIENT_ID: GOOGLE_ID });
    expect(status.missing).toEqual(['GOOGLE_CLIENT_SECRET']);
  });

  it('is kept out of the options handed to the identity provider', () => {
    // Handing over an id with no secret would produce a sign-in button that
    // fails at the provider rather than one that is honestly absent.
    expect(socialProviders({ GOOGLE_CLIENT_ID: GOOGLE_ID })).toEqual({});
  });

  it('is half set up in either direction', () => {
    const status = statusFor('github', { GITHUB_CLIENT_SECRET: GITHUB_SECRET });
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual(['GITHUB_CLIENT_ID']);
  });
});

describe('a deployment that configures no social login at all', () => {
  it('does not throw, because that is a valid deployment', () => {
    // Unlike a missing BETTER_AUTH_SECRET, which is fatal. Nobody has to offer
    // Google.
    expect(() => socialProviders({})).not.toThrow();
    expect(() => providerStatuses({}, BASE_URL)).not.toThrow();
  });

  it('offers nothing to the identity provider', () => {
    expect(Object.keys(socialProviders({}))).toHaveLength(0);
  });

  it('still reports every provider, with both of its variables named', () => {
    const statuses = providerStatuses({}, BASE_URL);

    expect(statuses.map((status) => status.provider)).toEqual(['google', 'github']);
    expect(statusFor('google', {}).missing).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(statusFor('github', {}).missing).toEqual(['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']);
  });
});

describe('a provider with both values', () => {
  it('reaches the identity provider intact', () => {
    expect(socialProviders(fullyConfigured)).toEqual({
      google: { clientId: GOOGLE_ID, clientSecret: GOOGLE_SECRET },
      github: { clientId: GITHUB_ID, clientSecret: GITHUB_SECRET },
    });
  });

  it('reports itself as configured with nothing missing', () => {
    const status = statusFor('google', fullyConfigured);
    expect(status.configured).toBe(true);
    expect(status.missing).toEqual([]);
  });

  it('is accepted by better-auth in the shape it is produced in', async () => {
    // The shape is the risky part of this module: it is consumed by somebody
    // else's type. Constructing for real is cheaper than assuming.
    const auth = betterAuth({
      database: env.DB,
      secret: 'test-secret-not-used-to-sign-anything-real',
      baseURL: BASE_URL,
      socialProviders: socialProviders(fullyConfigured),
    });

    expect(typeof auth.handler).toBe('function');
    const response = await auth.handler(new Request(`${BASE_URL}/api/auth/ok`));
    expect(response).toBeInstanceOf(Response);
  });
});

describe('a variable that is set but empty', () => {
  it('counts as unset, in both the status and the options', () => {
    // What a `wrangler secret put` with an accidental newline, or an empty
    // value in a dashboard, actually leaves behind. Treating it as present
    // moves the failure to the provider, where the message is useless.
    const blank: ProviderEnv = {
      GOOGLE_CLIENT_ID: GOOGLE_ID,
      GOOGLE_CLIENT_SECRET: '   \n ',
    };

    expect(statusFor('google', blank).configured).toBe(false);
    expect(statusFor('google', blank).missing).toEqual(['GOOGLE_CLIENT_SECRET']);
    expect(socialProviders(blank)).toEqual({});
  });

  it('does not carry surrounding whitespace into a credential', () => {
    expect(
      socialProviders({ GITHUB_CLIENT_ID: ` ${GITHUB_ID} `, GITHUB_CLIENT_SECRET: GITHUB_SECRET }),
    ).toEqual({ github: { clientId: GITHUB_ID, clientSecret: GITHUB_SECRET } });
  });
});

describe('the redirect URI an operator has to register', () => {
  it('is the address the provider will be called back on', () => {
    expect(callbackUrl(BASE_URL, 'google')).toBe(`${BASE_URL}/api/auth/callback/google`);
    expect(callbackUrl(BASE_URL, 'github')).toBe(`${BASE_URL}/api/auth/callback/github`);
  });

  it('does not double the slash when the base URL ends in one', () => {
    // Providers compare this string literally, so a double slash is a rejected
    // sign-in for a reason nobody can see by looking at it.
    expect(callbackUrl(`${BASE_URL}/`, 'google')).toBe(`${BASE_URL}/api/auth/callback/google`);
    expect(callbackUrl(`${BASE_URL}//`, 'google')).toBe(`${BASE_URL}/api/auth/callback/google`);
  });

  it('drops credentials carried by the base URL, which a public report must not repeat', () => {
    // A URL is allowed to hold a user and password in front of the host, and
    // this string is served by a public endpoint. Trimming a trailing slash
    // would leave them in place, so the value goes through URL.origin instead.
    expect(callbackUrl('https://operator:s3cret@baseclf.example.com', 'google')).toBe(
      'https://baseclf.example.com/api/auth/callback/google',
    );
  });

  it('is relative rather than invented when the base URL is not an origin', () => {
    // There is no usable callback address for a deployment whose base URL is
    // not a URL. Echoing whatever was typed would both look authoritative and
    // put an unfiltered value into a public body.
    expect(callbackUrl('not a url', 'google')).toBe('/api/auth/callback/google');
  });

  it('is reported for a provider that has not been configured yet', () => {
    // The order of operations is: read the redirect URI, create the OAuth app
    // with it, then set the variables. It has to be available before the
    // provider is configured or it is available too late to be useful.
    expect(statusFor('google', {}).redirectUri).toBe(`${BASE_URL}/api/auth/callback/google`);
  });
});

describe('what a provider status is allowed to contain', () => {
  it('never contains a credential value', () => {
    // The status feeds a public endpoint. Values leave this module through
    // socialProviders and nowhere else.
    const serialised = JSON.stringify(providerStatuses(fullyConfigured, BASE_URL));

    expect(serialised).not.toContain(CANARY);
    for (const value of [GOOGLE_ID, GOOGLE_SECRET, GITHUB_ID, GITHUB_SECRET]) {
      expect(serialised).not.toContain(value);
      expect(serialised).not.toContain(value.slice(0, 12));
    }
  });

  it('reports presence rather than validity', () => {
    // "not set" helps whoever deployed this. "wrong" helps whoever is guessing.
    const status = statusFor('google', fullyConfigured);
    expect(Object.keys(status).sort()).toEqual([
      'configured',
      'missing',
      'provider',
      'redirectUri',
    ]);
  });

  it('only ever names variables that exist', () => {
    const known = new Set([...CREDENTIAL_VARIABLES.google, ...CREDENTIAL_VARIABLES.github]);

    for (const status of providerStatuses({}, BASE_URL)) {
      for (const name of status.missing) expect(known.has(name)).toBe(true);
    }
  });
});
