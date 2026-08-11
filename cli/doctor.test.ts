/**
 * `baseclf doctor`, against a real deployment and against the failures it exists for.
 *
 * The healthy path runs against the actual worker, because a doctor tested only
 * against a description of a deployment tells you the description is consistent.
 *
 * The failures are driven by a stand-in, and the reason is worth stating: the one
 * that matters most is the auth migration not having run, and reproducing that for
 * real would mean dropping the `jwks` table out from under every other test file
 * sharing this database. So the shape of that failure is asserted here and the fact
 * that it is the shape a real deployment produces is recorded in HANDOFF learned
 * item 50, where it was found.
 */

import { env } from 'cloudflare:workers';
import { getMigrations } from 'better-auth/db/migration';
import { bearer, jwt } from 'better-auth/plugins';
import { beforeAll, describe, expect, it } from 'vitest';

import worker, { type Env } from '../src/index.js';
import { POLICY_SCHEMA } from '../src/policy/schema.js';
import { type Fetcher, runDoctor } from './doctor.js';
import { findVoiceViolations, PLAIN } from './output.js';
import { renderReport } from './report.js';

const BASE_URL = 'https://baseclf.test';
const SECRET = 'test-secret-not-used-to-sign-anything-real';

const healthy: Env = {
  ...env,
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: BASE_URL,
  BETTER_AUTH_TRUSTED_ORIGINS: 'https://app.example.test',
};

/** Routes every request into the worker, so doctor is asking a real deployment. */
function against(deployment: Env): Fetcher {
  return (url, init) =>
    worker.fetch(new Request(url, { ...init, headers: { 'CF-Connecting-IP': '198.51.100.20' } }), deployment);
}

/** Answers whatever the test says, for failures a real database cannot be put into. */
function standIn(answers: Readonly<Record<string, { status: number; body: string }>>): Fetcher {
  return (url) => {
    const path = new URL(url).pathname;
    const answer = answers[path] ?? { status: 200, body: '{}' };
    return Promise.resolve(new Response(answer.body, { status: answer.status }));
  };
}

beforeAll(async () => {
  const authOptions = {
    database: env.DB,
    secret: SECRET,
    baseURL: BASE_URL,
    plugins: [bearer(), jwt({ jwks: { keyPairConfig: { alg: 'ES256' as const } } })],
  };
  await (await getMigrations(authOptions)).runMigrations();

  for (const statement of POLICY_SCHEMA) {
    await env.DB.prepare(statement).run();
  }
}, 60_000);

describe('a deployment that works', () => {
  it('is asked about itself, and answers on every endpoint doctor checks', async () => {
    const report = await runDoctor(BASE_URL, against(healthy));
    const named = new Map(report.checks.map((check) => [check.name, check]));

    expect(named.get('reachable')?.verdict).toBe('allow');
    expect(named.get('schema')?.verdict).toBe('allow');
    expect(named.get('keys')?.verdict).toBe('allow');
  });

  it('reads the algorithm from the key set rather than from configuration', async () => {
    // Trap 4 in the auth skill: a configuration that mentions ES256 is not evidence
    // that ES256 is what gets used. EdDSA would report kty OKP.
    const report = await runDoctor(BASE_URL, against(healthy));
    const keys = report.checks.find((check) => check.name === 'keys');

    expect(keys?.detail).toContain('ES256');
    expect(keys?.detail).toContain('P-256');
  });
});

describe('⭐ a deployment whose auth migration never ran', () => {
  // The failure this command exists for. Health, schema and diagnose all report a
  // working deployment; only the key set fails, and every token silently fails to
  // verify. Nothing else anywhere shows it.
  const migrationMissing = standIn({
    '/health': { status: 200, body: '{"status":"ok"}' },
    '/_schema': { status: 200, body: '{"tables":[]}' },
    '/api/auth/jwks': { status: 500, body: '' },
    '/api/auth/_diagnose': { status: 200, body: '{"ok":true,"secret_configured":true}' },
  });

  it('is caught, by the one endpoint that shows it', async () => {
    const report = await runDoctor(BASE_URL, migrationMissing);

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'keys')?.verdict).toBe('deny');
  });

  it('says that everything else looking healthy is what this failure looks like', async () => {
    // Without that sentence the reader sees three green lines and one red one and
    // concludes the red one is unrelated to their tokens not working.
    const keys = (await runDoctor(BASE_URL, migrationMissing)).checks.find(
      (check) => check.name === 'keys',
    );

    expect(keys?.detail).toContain('migration');
    expect(keys?.detail).toContain('no token can be verified');
    expect(keys?.action).toContain('Apply the auth migrations');
  });

  it('is not hidden by the other three checks passing', async () => {
    const report = await runDoctor(BASE_URL, migrationMissing);
    const allowed = report.checks.filter((check) => check.verdict === 'allow');

    expect(allowed.length).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
  });
});

describe('a deployment that is not finished', () => {
  it('reports a missing signing secret as the thing that stops everything', async () => {
    const report = await runDoctor(
      BASE_URL,
      standIn({
        '/api/auth/jwks': { status: 200, body: '{"keys":[{"kty":"EC","alg":"ES256"}]}' },
        '/api/auth/_diagnose': {
          status: 200,
          body: '{"secret_configured":false,"warnings":["BETTER_AUTH_SECRET is not set"]}',
        },
      }),
    );

    const secret = report.checks.find((check) => check.name === 'secret');
    expect(secret?.verdict).toBe('deny');
    expect(secret?.action).toContain('wrangler secret put');
  });

  it('reports missing engine tables, and what they break', async () => {
    const report = await runDoctor(
      BASE_URL,
      standIn({ '/_schema': { status: 500, body: '{"error":"Internal error."}' } }),
    );

    const schema = report.checks.find((check) => check.name === 'schema');
    expect(schema?.verdict).toBe('deny');
    expect(schema?.detail).toContain('/rest/v1');
  });

  it('hands back the redirect URI to copy when a provider is not configured', async () => {
    // The value people mis-paste, and the step they give up at. Reported whether or
    // not anything else is wrong.
    const uri = 'https://baseclf.test/api/auth/callback/google';
    const report = await runDoctor(
      BASE_URL,
      standIn({
        '/api/auth/_diagnose': {
          status: 200,
          body: JSON.stringify({
            secret_configured: true,
            warnings: [],
            providers: { google: { configured: false, redirect_uri: uri } },
          }),
        },
      }),
    );

    const provider = report.checks.find((check) => check.name === 'provider google');
    expect(provider?.verdict).toBe('attention');
    expect(provider?.copy).toBe(uri);
  });

  it('counts attention as not ok, so a script can trust the exit code', async () => {
    // A deployment nobody can sign in to is not a working deployment.
    const report = await runDoctor(
      BASE_URL,
      standIn({
        '/api/auth/jwks': { status: 200, body: '{"keys":[{"kty":"EC","alg":"ES256"}]}' },
        '/api/auth/_diagnose': {
          status: 200,
          body: '{"secret_configured":true,"warnings":["No social provider is configured"]}',
        },
      }),
    );

    expect(report.checks.some((check) => check.verdict === 'deny')).toBe(false);
    expect(report.ok).toBe(false);
  });
});

describe('a deployment that has only just been created', () => {
  it('is not reported as broken, because for half a minute it answers 404', async () => {
    // Measured 2026-08-11, rules/02 §C2: a new workers.dev URL answered 404 with
    // "error code: 1042", then 500, then 200 after roughly thirty seconds. Calling
    // that broken would be wrong at exactly the moment somebody is deciding whether
    // this product works.
    for (const status of [404, 500, 503]) {
      const report = await runDoctor(BASE_URL, standIn({ '/health': { status, body: '' } }));
      const reachable = report.checks.find((check) => check.name === 'reachable');

      expect(reachable?.verdict, `status ${status}`).toBe('attention');
      expect(reachable?.action).toContain('Wait');
    }
  });

  it('says that 1042 does not mean what it usually means', async () => {
    // Otherwise the reader searches the error code and is told it is about a Worker
    // fetching a Worker in the same zone, and goes to look at their fetch calls.
    const report = await runDoctor(BASE_URL, standIn({ '/health': { status: 404, body: '' } }));

    expect(report.checks.find((check) => check.name === 'reachable')?.detail).toContain('1042');
  });
});

describe('input and infrastructure that is simply absent', () => {
  it('refuses a URL that is not one, without asking anything', async () => {
    let asked = 0;
    const report = await runDoctor('baseclf.example.workers.dev', () => {
      asked += 1;
      return Promise.resolve(new Response('{}'));
    });

    expect(asked).toBe(0);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.action).toContain('https://');
  });

  it('reports an unreachable host rather than throwing, and does not call it broken', async () => {
    // ⚠️ This used to assert every check was `deny`, and a real run showed why that is
    // wrong. Measured on 2026-08-12 against the first workers.dev subdomain claimed on
    // an account: the first twenty five seconds are a TLS handshake failure, not a 404
    // then a 500, because the certificate does not exist yet. That is below HTTP,
    // where there is no status to read, so a request that fails outright is what a
    // perfectly good deployment looks like when it is twenty seconds old.
    //
    // Still not `ok`, because something is genuinely unanswered. But `attention`
    // rather than `deny`, because waiting may be the whole fix.
    const report = await runDoctor(BASE_URL, () =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND')),
    );

    expect(report.ok).toBe(false);

    const reachable = report.checks.find((check) => check.name === 'reachable');
    expect(reachable?.verdict).toBe('attention');
    expect(reachable?.action).toMatch(/wait/i);

    // Everything downstream still fails hard: those endpoints really did not answer,
    // and reporting them as merely young would hide a deployment that is broken.
    expect(
      report.checks.filter((check) => check.name !== 'reachable').every((c) => c.verdict === 'deny'),
    ).toBe(true);
  });

  it('runs every check even when the first one fails', async () => {
    // A doctor that reports the first problem and stops makes somebody run it five
    // times, which is the opposite of cutting support questions.
    const report = await runDoctor(BASE_URL, () => Promise.reject(new Error('down')));

    expect(report.checks.length).toBeGreaterThanOrEqual(4);
  });
});

describe('what the reader actually sees', () => {
  it('obeys every voice rule that can be checked', async () => {
    // The design system applied to this command's output, by machine. A healthy
    // report and a broken one, because the tempting places to write an exclamation
    // mark or an em-dash are the success line and the summary.
    const reports = await Promise.all([
      runDoctor(BASE_URL, against(healthy)),
      runDoctor(BASE_URL, () => Promise.reject(new Error('down'))),
      runDoctor(
        BASE_URL,
        standIn({
          '/api/auth/_diagnose': {
            status: 200,
            body: JSON.stringify({
              secret_configured: false,
              warnings: ['BETTER_AUTH_SECRET is not set'],
              providers: {
                google: { configured: false, redirect_uri: `${BASE_URL}/api/auth/callback/google` },
              },
            }),
          },
        }),
      ),
    ]);

    for (const report of reports) {
      expect(findVoiceViolations(renderReport(report, PLAIN))).toEqual([]);
    }
  });

  it('never claims safety, and names the caveat instead', async () => {
    // Rule 00 forbids "your data is safe". The honest form says what is enforced and
    // what is not, and the biggest thing not enforced is that `wrangler d1 execute`
    // bypasses the engine entirely.
    //
    // A stand-in rather than the real worker, because the real one reports warnings
    // in this environment (no provider is configured), so the closing line would be
    // the not-ok one and this would be asserting nothing.
    const allWell = standIn({
      '/api/auth/jwks': { status: 200, body: '{"keys":[{"kty":"EC","alg":"ES256","crv":"P-256"}]}' },
      '/api/auth/_diagnose': { status: 200, body: '{"secret_configured":true,"warnings":[]}' },
    });
    const report = await runDoctor(BASE_URL, allWell);
    expect(report.ok).toBe(true);

    const rendered = renderReport(report, PLAIN);

    expect(rendered).toContain('enforces policies');
    expect(rendered).toContain('wrangler d1 execute');
  });

  it('puts a copyable value at column zero and nothing else there', async () => {
    const uri = `${BASE_URL}/api/auth/callback/google`;
    const report = await runDoctor(
      BASE_URL,
      standIn({
        '/api/auth/_diagnose': {
          status: 200,
          body: JSON.stringify({
            secret_configured: true,
            warnings: [],
            providers: { google: { configured: false, redirect_uri: uri } },
          }),
        },
      }),
    );

    const lines = renderReport(report, PLAIN).split('\n');
    const unindented = lines.filter((line) => line.length > 0 && !line.startsWith(' '));

    // Every unindented line is either a result line, which starts with a mark, or the
    // value. Anything else at column zero competes with the value for a double-click.
    for (const line of unindented) {
      const isResult = line.startsWith('✓') || line.startsWith('✗') || line.startsWith('▲');
      expect(isResult || line === uri, `unexpected line at column zero: ${line}`).toBe(true);
    }
    expect(unindented).toContain(uri);
  });

  it('ends with the command that rechecks, not with a count', async () => {
    const rendered = renderReport(
      await runDoctor(BASE_URL, () => Promise.reject(new Error('down'))),
      PLAIN,
    );

    expect(rendered.trimEnd().endsWith('baseclf doctor <url>')).toBe(true);
  });
});
