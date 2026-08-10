/**
 * The diagnostic body: what it has to notice, and what it must never say.
 *
 * Two groups of invariants live here. The first is that a base URL which does
 * not match the hostname serving the request is reported, because that single
 * mistake accounts for most sign-ins that never work and it is invisible from
 * every other vantage point. The second, and the more important one, is that
 * this body is safe to serve to anybody at all: it is a public endpoint, so a
 * credential value appearing in it would be a disclosure rather than a bug in
 * the report.
 */

import { describe, expect, it } from 'vitest';

import { type CorsFacts, type DiagnoseInput, type DiagnoseReport, diagnose } from './diagnose.js';
import { type ProviderEnv, providerStatuses } from './providers.js';

const CONFIGURED_URL = 'https://baseclf-abc123.example.workers.dev';

/**
 * Fake credentials with a marker that could not appear by coincidence. Not
 * secrets: they authenticate nothing.
 */
const CANARY = 'canary-4d0b19-must-not-be-reported';
const CREDENTIALS: ProviderEnv = {
  GOOGLE_CLIENT_ID: `google-id-${CANARY}`,
  GOOGLE_CLIENT_SECRET: `google-secret-${CANARY}`,
  GITHUB_CLIENT_ID: `github-id-${CANARY}`,
  GITHUB_CLIENT_SECRET: `github-secret-${CANARY}`,
};

/**
 * What the CORS layer would have decided, as this pure function receives it.
 *
 * Handed in rather than worked out, which is the point of `CorsFacts`: the only
 * implementation of the decision lives in `src/index.ts`. That the two agree is
 * not something this file can prove, so it is proved where both are real, in
 * `src/cors.test.ts`.
 */
const NO_ORIGIN_ALLOWED: CorsFacts = {
  allowedOriginForCaller: null,
  allowedRequestHeaders: ['authorization', 'content-type'],
  exposedResponseHeaders: ['x-d1-bookmark'],
  preflightMaxAgeSeconds: 600,
};

function report(overrides: Partial<DiagnoseInput> = {}): DiagnoseReport {
  const baseUrlConfig = overrides.baseUrlConfig ?? CONFIGURED_URL;

  return diagnose({
    requestUrl: `${CONFIGURED_URL}/api/auth/_diagnose`,
    requestOrigin: null,
    trustedOrigins: ['https://app.example.com'],
    providers: providerStatuses(CREDENTIALS, baseUrlConfig),
    secretConfigured: true,
    cors: NO_ORIGIN_ALLOWED,
    ...overrides,
    baseUrlConfig,
  });
}

/**
 * The mismatch warning, identified by the provider error it predicts. Matching
 * on that string rather than on the array being empty keeps this test about one
 * warning while other checks are free to fire.
 */
function mismatchWarnings(of: DiagnoseReport): readonly string[] {
  return of.warnings.filter((warning) => warning.includes('redirect_uri_mismatch'));
}

describe('a request served from a hostname other than BETTER_AUTH_URL', () => {
  it('is warned about, because it is why sign-in fails', () => {
    const result = report({ requestUrl: 'https://baseclf.mydomain.com/api/auth/_diagnose' });

    expect(mismatchWarnings(result)).toHaveLength(1);
    expect(result.base_url_matches).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('names both hostnames and what to do about them', () => {
    const [warning] = mismatchWarnings(
      report({ requestUrl: 'https://baseclf.mydomain.com/api/auth/_diagnose' }),
    );

    expect(warning).toContain(CONFIGURED_URL);
    expect(warning).toContain('https://baseclf.mydomain.com');
    expect(warning).toContain('BETTER_AUTH_URL');
  });

  it('reports the serving origin so the two can be compared by eye', () => {
    const result = report({ requestUrl: 'https://baseclf.mydomain.com/api/auth/_diagnose' });

    expect(result.base_url_config).toBe(CONFIGURED_URL);
    expect(result.base_url_actual).toBe('https://baseclf.mydomain.com');
  });
});

describe('a request served from the configured hostname', () => {
  it('produces no mismatch warning', () => {
    const result = report();

    expect(mismatchWarnings(result)).toHaveLength(0);
    expect(result.base_url_matches).toBe(true);
  });

  it('still matches when the configured value has a trailing slash or a default port', () => {
    // Cosmetic differences in how somebody typed the variable are not a
    // mismatch, and reporting them as one would train people to ignore the
    // warning that matters.
    const result = report({
      baseUrlConfig: `${CONFIGURED_URL}/`,
      requestUrl: `${CONFIGURED_URL}:443/api/auth/_diagnose`,
    });

    expect(mismatchWarnings(result)).toHaveLength(0);
    expect(result.base_url_matches).toBe(true);
  });

  it('says so with no warnings at all when everything else is set up', () => {
    const result = report({ trustedOrigins: ['https://app.example.com'] });

    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('a deployment with no signing secret', () => {
  it('is told that this is why everything answers 500', () => {
    // Without this the diagnostic is silent about the one setting that stops
    // every other route working, and whoever is debugging goes looking at OAuth
    // instead.
    const result = report({ secretConfigured: false });

    expect(result.secret_configured).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('BETTER_AUTH_SECRET'))).toBe(true);
  });

  it('is reported by presence, never by value or validity', () => {
    // The same rule the providers follow. "Set" and "not set" is what an
    // operator can act on; anything more is for somebody else.
    const serialised = JSON.stringify(report({ secretConfigured: true }));

    expect(serialised).toContain('"secret_configured":true');
    expect(serialised).not.toMatch(/secret_(valid|length|prefix)/);
  });
});

describe('what the public body may contain', () => {
  it('never contains a credential value', () => {
    // The most important assertion in this file. This endpoint is reachable by
    // anyone, before any administrative credential exists, by design.
    const serialised = JSON.stringify(
      report({ requestUrl: 'https://baseclf.mydomain.com/api/auth/_diagnose' }),
    );

    expect(serialised).not.toContain(CANARY);
    for (const value of Object.values(CREDENTIALS)) {
      expect(serialised).not.toContain(value);
      // Not even a fragment. A masked or truncated secret is still a secret
      // with fewer characters left to guess.
      expect(serialised).not.toContain(value.slice(0, 12));
    }
  });

  it('does not echo the configured base URL verbatim, only its origin', () => {
    // The configured value is the one field that is tempting to report exactly
    // as typed, and it is the one field where doing so can disclose something:
    // a URL is allowed to carry credentials in front of the host, and this body
    // is public. Reducing it to an origin drops them.
    const result = report({ baseUrlConfig: `https://operator:${CANARY}@baseclf.mydomain.com` });
    const serialised = JSON.stringify(result);

    expect(result.base_url_config).toBe('https://baseclf.mydomain.com');
    expect(serialised).not.toContain(CANARY);
    expect(serialised).not.toContain('operator:');
  });

  it('says when the configured base URL carries more than an origin', () => {
    // Dropping the extra quietly would leave somebody staring at a value they
    // set and a deployment that ignores it.
    const result = report({ baseUrlConfig: `${CONFIGURED_URL}/auth` });

    expect(result.warnings.some((warning) => warning.includes('more than an origin'))).toBe(true);
  });

  it('does not reflect the request path or query string', () => {
    // A caller who pastes a token into the query string of a diagnostic URL
    // must not get it echoed back into a public response body. Only the origin
    // of the request is ever used.
    const result = report({
      requestUrl: `${CONFIGURED_URL}/api/auth/_diagnose?access_token=${CANARY}&next=/admin`,
    });

    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(result.base_url_actual).toBe(CONFIGURED_URL);
  });

  it('does not reflect an Origin header that is not a well-formed origin', () => {
    const result = report({ requestOrigin: `<script>${CANARY}</script>` });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it('reports a provider by presence and absence only, never by validity', () => {
    // "not set" is what the operator needs. "wrong" is what an attacker needs.
    expect(Object.keys(report().providers.google ?? {})).toEqual([
      'configured',
      'missing',
      'redirect_uri',
    ]);
  });

  it('says nothing about the database', () => {
    const serialised = JSON.stringify(
      report({ requestUrl: 'https://elsewhere.test/' }),
    ).toLowerCase();

    for (const term of ['select ', 'sqlite', 'd1_', '_policies', 'table', 'column']) {
      expect(serialised).not.toContain(term);
    }
  });
});

describe('the redirect URI an operator has to paste', () => {
  it('is reported for every provider, configured or not', () => {
    const result = diagnose({
      requestUrl: `${CONFIGURED_URL}/api/auth/_diagnose`,
      requestOrigin: null,
      baseUrlConfig: CONFIGURED_URL,
      trustedOrigins: [],
      providers: providerStatuses(
        { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' },
        CONFIGURED_URL,
      ),
      secretConfigured: true,
      cors: NO_ORIGIN_ALLOWED,
    });

    expect(result.providers.google?.redirect_uri).toBe(
      `${CONFIGURED_URL}/api/auth/callback/google`,
    );
    expect(result.providers.github?.redirect_uri).toBe(
      `${CONFIGURED_URL}/api/auth/callback/github`,
    );
    expect(result.providers.github?.configured).toBe(false);
  });
});

describe('a provider that is half configured', () => {
  it('is warned about by name, naming only the variable', () => {
    const result = report({
      providers: providerStatuses({ ...CREDENTIALS, GITHUB_CLIENT_SECRET: '' }, CONFIGURED_URL),
    });

    const warning = result.warnings.find((entry) => entry.includes('GITHUB_CLIENT_SECRET'));
    expect(warning).toBeDefined();
    expect(warning).toContain('GitHub');
    expect(warning).toContain('GITHUB_CLIENT_ID');
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it('is not confused with a provider nobody set up', () => {
    // Absent is a deployment that does not offer GitHub. Half configured is
    // somebody who thinks it does.
    const absent = report({ providers: providerStatuses({ ...CREDENTIALS }, CONFIGURED_URL) });
    expect(absent.warnings.some((entry) => entry.includes('GITHUB_CLIENT_SECRET'))).toBe(false);
  });
});

describe('a deployment where nobody can sign in', () => {
  it('says so rather than leaving an empty provider list to be noticed', () => {
    const result = report({ providers: providerStatuses({}, CONFIGURED_URL) });

    const warning = result.warnings.find((entry) => entry.includes('No social provider'));
    expect(warning).toBeDefined();
    expect(warning).toContain('GOOGLE_CLIENT_ID');
    expect(warning).toContain('GITHUB_CLIENT_ID');
  });
});

describe('cross-origin callers', () => {
  it('are warned about when the trusted origin list is empty', () => {
    const result = report({ trustedOrigins: [] });

    expect(
      result.warnings.some((entry) => entry.includes('BETTER_AUTH_TRUSTED_ORIGINS is empty')),
    ).toBe(true);
  });

  it('are warned about by name when they are not on the list', () => {
    const result = report({ requestOrigin: 'https://app.other.test' });

    const warning = result.warnings.find((entry) => entry.includes('https://app.other.test'));
    expect(warning).toBeDefined();
    expect(warning).toContain('BETTER_AUTH_TRUSTED_ORIGINS');
  });

  it('are left alone when the CORS layer allowed them', () => {
    // The allowed origin is stated rather than inferred from `trustedOrigins`,
    // and that is the contract now: this function reports the decision the
    // request path made instead of forming its own. Inferring it here is exactly
    // the duplication that made the two disagree over a trailing slash.
    const result = report({
      requestOrigin: 'https://app.example.com',
      cors: { ...NO_ORIGIN_ALLOWED, allowedOriginForCaller: 'https://app.example.com' },
    });

    expect(result.warnings).toEqual([]);
    expect(result.cors.allowed_origin_for_caller).toBe('https://app.example.com');
  });

  it('are warned about when the list holds them in a form that matches nothing', () => {
    // A path, not an origin. `URL.origin` on the request path reduces the caller
    // to a scheme and a host, so this entry can never equal one. The operator
    // listed their frontend, the list is not empty, and every call from it still
    // fails a preflight with nothing said anywhere.
    const result = report({ trustedOrigins: ['https://app.example.com/callback'] });

    const warning = result.warnings.find((entry) => entry.includes('matches nothing'));
    expect(warning).toBeDefined();
    expect(warning).toContain('https://app.example.com/callback');
  });

  it('says nothing about a trailing slash, because a trailing slash works', () => {
    // The opposite failure, and the one worth guarding: warning about a value
    // that is fine sends somebody to change a setting that was already correct.
    // `URL.origin` drops the slash on both sides, so this entry does match.
    const result = report({ trustedOrigins: ['https://app.example.com/'] });

    expect(result.warnings.filter((entry) => entry.includes('matches nothing'))).toEqual([]);
  });

  it('are left alone when the caller is the deployment itself', () => {
    const result = report({ requestOrigin: CONFIGURED_URL });
    expect(result.warnings).toEqual([]);
  });
});

describe('a base URL that cannot work', () => {
  it('is warned about when it is not an absolute URL', () => {
    const result = report({ baseUrlConfig: 'baseclf-abc123.example.workers.dev' });

    expect(result.warnings.some((entry) => entry.includes('not an absolute URL'))).toBe(true);
    expect(result.base_url_matches).toBe(false);
    expect(result.base_url_actual).toBe(CONFIGURED_URL);
  });

  it('is warned about when it is http on a public host', () => {
    // Google and GitHub refuse a redirect URI that is not https, so this is a
    // sign-in that cannot be made to work by pasting more carefully.
    const result = report({
      baseUrlConfig: 'http://baseclf.mydomain.com',
      requestUrl: 'http://baseclf.mydomain.com/api/auth/_diagnose',
    });

    expect(result.warnings.some((entry) => entry.includes('uses http on a public host'))).toBe(
      true,
    );
  });

  it('is left alone when it is http on localhost', () => {
    const result = report({
      baseUrlConfig: 'http://localhost:8787',
      requestUrl: 'http://localhost:8787/api/auth/_diagnose',
      trustedOrigins: ['http://localhost:3000'],
    });

    expect(result.warnings).toEqual([]);
    expect(result.providers.google?.redirect_uri).toBe(
      'http://localhost:8787/api/auth/callback/google',
    );
  });

  it('is left alone when it is http on a loopback address', () => {
    const result = report({
      baseUrlConfig: 'http://[::1]:8787',
      requestUrl: 'http://[::1]:8787/api/auth/_diagnose',
      trustedOrigins: ['http://127.0.0.1:3000'],
    });

    expect(result.warnings).toEqual([]);
  });
});
