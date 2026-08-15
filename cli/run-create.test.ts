import { describe, expect, it } from 'vitest';

import { CREATE_CRONS, CREATE_PLAN, SIGNING_SECRET_NAME } from './create.js';
import { findVoiceViolations, PLAIN } from './output.js';
import { CREATE_FIXED_TEXT, type CreateHost, runCreate } from './run-create.js';

const TOKEN_CANARY = 'oauth-token-never-printed';
/**
 * Shaped like a real one, which is 32 lowercase hex characters, and made up.
 *
 * The eight leading zeros are what the commit guard reads as "this is a fixture". A
 * real account id going into a test file is the mistake that rule exists for, and it
 * had already happened once by the time it was written.
 */
const ACCOUNT = '00000000b4a5968778695a4b3c2d1e0f';
const NOW = new Date('2026-08-12T00:00:00.000Z');

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

interface Harness {
  readonly host: CreateHost;
  readonly sent: Recorded[];
  readonly lines: string[];
  readonly write: (text: string) => void;
  readonly text: () => string;
  /** How many times wrangler was reached for. Zero is the interesting number. */
  readonly refreshAttempts: () => number;
}

/** The wrangler config file, in the shape measured on 2026-08-12. */
function authFile(expiry = '2026-08-12T01:00:00.000Z'): string {
  return [
    `oauth_token = "${TOKEN_CANARY}"`,
    `expiration_time = "${expiry}"`,
    'scopes = [ "account:read", "workers:write", "d1:write" ]',
  ].join('\n');
}

const WHOAMI = [
  'You are logged in with an OAuth Token, associated with the email reader@example.com.',
  'Credentials are stored in: /home/reader/.wrangler/config/default.toml',
].join('\n');

interface HarnessOptions {
  /**
   * The secrets the script already has, or null when there is no script.
   *
   * The whole point of the harness. Null is a first run, a list without the signing
   * secret is a run that was interrupted, and a list with it is a redeploy.
   */
  readonly existingSecrets?: readonly string[] | null;
  readonly accounts?: readonly { id: string; name: string }[];
  readonly answers?: readonly string[];
  readonly healthStatus?: number;
  readonly failOn?: string;
  /** Cloudflare's own code on the injected failure. Some of them are actionable. */
  readonly failCode?: number;
  readonly authFileText?: string | undefined;
  /** What the file holds after a refresh, when the refresh is meant to have worked. */
  readonly refreshTo?: string;
  readonly whoami?: string | null;
  readonly env?: Record<string, string | undefined>;
}

function harness(options: HarnessOptions = {}): Harness {
  const sent: Recorded[] = [];
  const lines: string[] = [];
  const answers = [...(options.answers ?? ['demo', 'http://localhost:5173'])];
  const existingSecrets = options.existingSecrets === undefined ? null : options.existingSecrets;

  const ok = (result: unknown): Response =>
    new Response(JSON.stringify({ success: true, result }), { status: 200 });

  /**
   * The request body as text, including the multipart one.
   *
   * ⚠️ The multipart branch is here because leaving it out did not fail loudly. The
   * upload sends `FormData` full of `Blob`s, an earlier version of this harness
   * recorded that as an empty string, and the test asserting a first run does NOT
   * inherit passed against it: nothing contains "inherit". It proved nothing, and it
   * would have kept proving nothing. Its sibling assertion is what exposed it.
   */
  const bodyText = async (body: BodyInit | null | undefined): Promise<string> => {
    if (typeof body === 'string') return body;
    if (body instanceof FormData) {
      const parts: string[] = [];
      for (const [key, value] of body.entries()) {
        parts.push(`${key}: ${typeof value === 'string' ? value : await value.text()}`);
      }
      return parts.join('\n');
    }
    return '';
  };

  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const path = url.replace('https://api.cloudflare.com/client/v4', '');
    const body = await bodyText(init?.body);

    // `/health` on the deployment, not the API.
    if (!url.startsWith('https://api.cloudflare.com')) {
      sent.push({ method, path: url, body });
      return new Response('{}', { status: options.healthStatus ?? 200 });
    }

    sent.push({ method, path, body });

    if (options.failOn !== undefined && path.includes(options.failOn)) {
      return new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: options.failCode ?? 10001, message: 'nope' }],
        }),
        { status: 500 },
      );
    }

    if (path === '/accounts') {
      return ok(options.accounts ?? [{ id: ACCOUNT, name: 'Reader Account' }]);
    }
    if (path.includes('/secrets') && method === 'GET') {
      if (existingSecrets === null) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 10007 }] }), {
          status: 404,
        });
      }
      return ok(existingSecrets.map((name) => ({ name })));
    }
    if (path.includes('/d1/database') && method === 'GET') return ok([]);
    if (path.includes('/d1/database')) return ok({ uuid: 'db-uuid', name: 'demo' });
    if (path.includes('/r2/buckets')) return ok({ name: 'demo-objects' });
    if (path.includes('/workers/subdomain')) return ok({ subdomain: 'quiet-frog-1a2b' });

    return ok({});
  };

  const write = (text: string): void => {
    lines.push(text);
  };

  let refreshed = 0;

  const host: CreateHost = {
    fetcher: fetcher as CreateHost['fetcher'],
    readWorkerBundle: async () => 'export default { fetch() {} }',
    refreshLogin: async () => {
      refreshed += 1;
      return options.whoami === undefined ? WHOAMI : options.whoami;
    },
    // A refresh rewrites the file, so what a later read sees is different. Modelling
    // that is the only way a test can tell a refresh that worked from one that ran.
    readAuthFile: () => {
      if (refreshed > 0 && options.refreshTo !== undefined) return options.refreshTo;
      return options.authFileText === undefined && !('authFileText' in options)
        ? authFile()
        : options.authFileText;
    },
    paths: {
      platform: 'linux',
      home: '/home/reader',
      env: options.env ?? {},
      isDirectory: () => true,
    },
    now: () => NOW,
    ask: async () => answers.shift() ?? '',
    sleep: async () => {},
  };

  return {
    host,
    sent,
    lines,
    write,
    text: () => lines.join('\n'),
    refreshAttempts: () => refreshed,
  };
}

function callsTo(sent: readonly Recorded[], fragment: string, method?: string): Recorded[] {
  return sent.filter(
    (r) => r.path.includes(fragment) && (method === undefined || r.method === method),
  );
}

describe('running the plan', () => {
  it('provisions everything and reports the address', async () => {
    const h = harness();
    const outcome = await runCreate([], h.write, PLAIN, h.host);

    expect(outcome).toBe('ok');
    expect(h.text()).toContain('demo.quiet-frog-1a2b.workers.dev');
  });

  it('prints a redirect URI for every provider the step offers', async () => {
    // Found by somebody running the published package on their own account,
    // 2026-08-15, and by nothing before that. The closing step said "Google or
    // GitHub" and printed one address, so whoever picked GitHub registered a
    // Google callback and met `redirect_uri_mismatch` at the provider, which is
    // the drop-off the auth skill calls the biggest one in onboarding.
    //
    // The two differ only in the last segment, which is why reading the output
    // does not catch it and walking it does.
    const h = harness();
    await runCreate([], h.write, PLAIN, h.host);
    const text = h.text();

    const offered = [...text.matchAll(/Create an OAuth app with ([^.]+)\./g)]
      .flatMap((m) => (m[1] ?? '').split(/\s+or\s+|,\s*/))
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0);

    // The step has to offer something, or this test would pass by checking nothing.
    expect(offered.length).toBeGreaterThan(1);

    for (const provider of offered) {
      expect(text).toContain(`/api/auth/callback/${provider}`);
    }
  });

  it('runs every step the plan lists, in the plan order', async () => {
    // The plan is the document a reader argues with. Two copies of an ordering is how
    // an ordering drifts, and three of these orderings are load-bearing.
    const h = harness();
    await runCreate([], h.write, PLAIN, h.host);

    const reported = CREATE_PLAN.map((step) => step.title).filter((title) =>
      h.text().includes(title),
    );

    expect(reported).toEqual(CREATE_PLAN.map((step) => step.title));
  });

  it('sets the cron triggers, which nothing else would notice were missing', async () => {
    // A deployment without them answers every request correctly and never sweeps.
    const h = harness();
    await runCreate([], h.write, PLAIN, h.host);

    const schedules = callsTo(h.sent, '/schedules', 'PUT');
    expect(schedules).toHaveLength(1);
    expect(JSON.parse(schedules[0]?.body ?? '[]')).toEqual(CREATE_CRONS.map((cron) => ({ cron })));
  });

  it('claims the subdomain before the upload, because the upload carries the URL', async () => {
    const h = harness();
    await runCreate([], h.write, PLAIN, h.host);

    const subdomain = h.sent.findIndex((r) => r.path.includes('/workers/subdomain'));
    const upload = h.sent.findIndex(
      (r) => r.method === 'PUT' && r.path.includes('/workers/scripts/'),
    );

    expect(subdomain).toBeGreaterThanOrEqual(0);
    expect(upload).toBeGreaterThan(subdomain);
  });
});

describe('running it a second time', () => {
  it('keeps the signing secret instead of issuing a new one', async () => {
    // 🔴 The failure this test exists for does not look like a failure. A new signing
    // secret invalidates every session and every token already issued, so the run
    // reports success and every user of that deployment is signed out.
    const h = harness({ existingSecrets: [SIGNING_SECRET_NAME] });
    const outcome = await runCreate([], h.write, PLAIN, h.host);

    expect(outcome).toBe('ok');
    expect(callsTo(h.sent, '/secrets', 'PUT')).toHaveLength(0);
  });

  it('inherits the secret in the upload when the script already has it', async () => {
    const h = harness({ existingSecrets: [SIGNING_SECRET_NAME] });
    await runCreate([], h.write, PLAIN, h.host);

    const upload = callsTo(h.sent, '/workers/scripts/', 'PUT')[0];
    expect(upload?.body).toContain('inherit');
  });

  it('does not inherit on a first run, which would fail against bindings_inherit=strict', async () => {
    // An unconditional inherit broke every first deployment once already. Strict mode
    // turns an inherit that resolves to nothing into an error, which is the behaviour
    // we want and the reason this has to be conditional.
    const h = harness({ existingSecrets: null });
    await runCreate([], h.write, PLAIN, h.host);

    const upload = callsTo(h.sent, '/workers/scripts/', 'PUT')[0];
    expect(upload?.body).not.toContain('inherit');
    expect(callsTo(h.sent, '/secrets', 'PUT')).toHaveLength(1);
  });

  it('treats a script with no signing secret as a run that was interrupted', async () => {
    // The state a run leaves behind when it dies between the upload and the secret.
    // Inheriting here fails, and skipping the secret leaves a deployment that refuses
    // every request.
    const h = harness({ existingSecrets: ['SOMETHING_ELSE'] });
    await runCreate([], h.write, PLAIN, h.host);

    const upload = callsTo(h.sent, '/workers/scripts/', 'PUT')[0];
    expect(upload?.body).not.toContain('inherit');
    expect(callsTo(h.sent, '/secrets', 'PUT')).toHaveLength(1);
  });
});

describe('when it cannot start', () => {
  it('refuses when there is no login, and names the login command rather than permissions', async () => {
    // The "rather than permissions" half is the point and predates the other. Rule 02
    // section C1 is a day lost to a credential problem whose every symptom pointed at
    // permissions that were already correct, so this refusal must not send anybody
    // there.
    const h = harness({ authFileText: undefined });
    const outcome = await runCreate([], h.write, PLAIN, h.host);

    expect(outcome).toBe('failed');
    expect(h.text()).toMatch(/baseclf login/);
    expect(h.text()).not.toMatch(/permission/i);
  });

  it('does not run wrangler at all when the credential is still good', async () => {
    // 🔴 Measured on 2026-08-12: `npx wrangler` in a directory with no local copy goes
    // to install the newest one, and that install was broken at the time. Refreshing
    // unconditionally made a perfectly good credential depend on it, and the reader
    // was told to log in when they already had.
    const h = harness({ whoami: null });

    expect(await runCreate([], h.write, PLAIN, h.host)).toBe('ok');
    expect(h.refreshAttempts()).toBe(0);
  });

  it('refuses when the credential is stale and wrangler cannot be run to refresh it', async () => {
    const h = harness({ authFileText: authFile('2026-08-11T23:00:00.000Z'), whoami: null });
    const outcome = await runCreate([], h.write, PLAIN, h.host);

    expect(outcome).toBe('failed');
    expect(h.refreshAttempts()).toBe(1);
    expect(h.text()).toContain('wrangler login');
  });

  it('refreshes and carries on when the credential has aged out', async () => {
    // The case the refresh was written for. These last an hour, so anybody who logged
    // in earlier in the day lands here.
    const h = harness({
      authFileText: authFile('2026-08-11T23:00:00.000Z'),
      refreshTo: authFile(),
    });

    expect(await runCreate([], h.write, PLAIN, h.host)).toBe('ok');
    expect(h.refreshAttempts()).toBe(1);
  });

  it('refuses to choose between two accounts', async () => {
    // Picking would put somebody's database on their employer's bill, and Cloudflare
    // does not promise an order.
    const h = harness({
      accounts: [
        { id: 'a1', name: 'Personal' },
        { id: 'a2', name: 'Work' },
      ],
    });
    const outcome = await runCreate([], h.write, PLAIN, h.host);

    expect(outcome).toBe('failed');
    expect(h.text()).toContain('Personal');
    expect(h.text()).toContain('Work');
    expect(callsTo(h.sent, '/workers/scripts/', 'PUT')).toHaveLength(0);
  });

  it('refuses when the login has no account on it', async () => {
    const h = harness({ accounts: [] });
    expect(await runCreate([], h.write, PLAIN, h.host)).toBe('failed');
  });

  it('takes the defaults when the reader just presses enter', async () => {
    // ⚠️ This test used to assert the opposite, on the assumption that no answers
    // meant no input. It does not: an empty line is how every prompt here says "use
    // the default", so a reader pressing enter twice is a reader accepting both.
    const h = harness({ answers: [] });

    expect(await runCreate([], h.write, PLAIN, h.host)).toBe('ok');
    expect(h.text()).toContain('baseclf.');
  });

  it('stops rather than looping when the answers never become usable', async () => {
    // The way this is reached is not three typos. It is a script running the command
    // with something on stdin that is not a person, and without a bound that is a
    // command which never returns and never says why.
    const h = harness({ answers: ['!!', '!!', '!!'] });
    const outcome = await runCreate([], h.write, PLAIN, h.host);

    expect(outcome).toBe('usage');
    expect(callsTo(h.sent, '/d1/database', 'POST')).toHaveLength(0);
  });
});

describe('when a step fails', () => {
  it('says what breaks without it, and that rerunning is safe', async () => {
    const h = harness({ failOn: '/r2/buckets' });
    const outcome = await runCreate([], h.write, PLAIN, h.host);

    expect(outcome).toBe('failed');
    expect(h.text()).toContain('uploads have nowhere to go');
    expect(h.text()).toMatch(/running it again/i);
  });

  it('does not carry on to later steps', async () => {
    const h = harness({ failOn: '/r2/buckets' });
    await runCreate([], h.write, PLAIN, h.host);

    expect(callsTo(h.sent, '/workers/scripts/', 'PUT')).toHaveLength(0);
    expect(callsTo(h.sent, '/schedules')).toHaveLength(0);
  });

  it('tells the reader to switch R2 on rather than repeating Cloudflare at them', async () => {
    // 🔴 Found by the first run against a genuinely blank account, and it only shows
    // there: R2 is off until somebody switches it on, and the API refuses every call
    // including the read. Every account this project had used already had it on.
    const h = harness({ failOn: '/r2/buckets', failCode: 10042 });
    const outcome = await runCreate([], h.write, PLAIN, h.host);

    expect(outcome).toBe('failed');
    expect(h.text()).toContain('R2 Object Storage');
    expect(h.text()).toMatch(/run this again/i);
  });

  it('does not attach the R2 advice to failures that are not about R2', async () => {
    // A generic paragraph on every failure teaches people to stop reading the ones
    // that matter.
    const h = harness({ failOn: '/r2/buckets', failCode: 10001 });
    await runCreate([], h.write, PLAIN, h.host);

    expect(h.text()).not.toContain('R2 Object Storage');
    expect(h.text()).toMatch(/Fix the cause and rerun/i);
  });

  it('keeps the account id out of the message when a call fails', async () => {
    // Every path carries one and every failure prints its path. That id is what
    // somebody needs to act on the account, and a terminal ends up in the screenshot
    // attached to the bug report.
    const h = harness({ failOn: '/d1/database' });
    await runCreate([], h.write, PLAIN, h.host);

    expect(h.text()).toContain('/accounts/...');
    expect(h.text()).not.toContain(ACCOUNT);
  });

  it('calls a slow address a success, because everything is deployed', async () => {
    // A new address answers 404, then 500, then 200, over about thirty seconds.
    // Everything is provisioned by then, and `doctor` has more to say than another
    // poll here would.
    const h = harness({ healthStatus: 404 });
    const outcome = await runCreate([], h.write, PLAIN, h.host);

    expect(outcome).toBe('ok');
    expect(h.text()).toContain('baseclf doctor');
  });

  it('calls a 403 a failure, because waiting will not fix somebody else server', async () => {
    const h = harness({ healthStatus: 403 });
    expect(await runCreate([], h.write, PLAIN, h.host)).toBe('failed');
  });
});

describe('what a reader is allowed to see', () => {
  it('never prints the token, a prefix of it, or its length', async () => {
    const h = harness({ env: { CLOUDFLARE_API_TOKEN: 'cfut_EXAMPLE_ENV' } });
    await runCreate([], h.write, PLAIN, h.host);

    for (const line of h.lines) {
      expect(line).not.toContain(TOKEN_CANARY);
      expect(line).not.toContain(TOKEN_CANARY.slice(0, 8));
      expect(line).not.toContain('cfut_EXAMPLE_ENV');
      expect(line).not.toContain(String(TOKEN_CANARY.length));
    }
  });

  it('never prints the generated signing secret', async () => {
    // It is generated here and sent straight to one request body. Nothing on the way
    // in or out of that call has any reason to hold it.
    const h = harness({ existingSecrets: null });
    await runCreate([], h.write, PLAIN, h.host);

    const put = callsTo(h.sent, '/secrets', 'PUT')[0];
    const secret = JSON.parse(put?.body ?? '{}').text as string;

    expect(secret).toBeTruthy();
    for (const line of h.lines) expect(line).not.toContain(secret);
  });

  it('warns when an API token is quietly beating the login', async () => {
    const h = harness({ env: { CLOUDFLARE_API_TOKEN: 'cfut_EXAMPLE_ENV' } });
    await runCreate([], h.write, PLAIN, h.host);

    expect(h.text()).toContain('CLOUDFLARE_API_TOKEN');
  });

  it('prints the redirect URI unindented so it can be double-clicked', async () => {
    // A redirect URI with two spaces in front of it does not select cleanly, and the
    // person who mis-pastes it gets redirect_uri_mismatch with nothing to explain it.
    const h = harness();
    await runCreate([], h.write, PLAIN, h.host);

    const uri = h
      .text()
      .split('\n')
      .find((line) => line.includes('/api/auth/callback/'));

    expect(uri).toBeDefined();
    expect(uri).toBe(uri?.trim());
  });

  it('follows the voice rules in everything it can print', async () => {
    const h = harness();
    await runCreate([], h.write, PLAIN, h.host);

    for (const line of [...h.lines, ...CREATE_FIXED_TEXT]) {
      expect(findVoiceViolations(line)).toEqual([]);
    }
  });

  it('answers --help without touching the network', async () => {
    const h = harness();
    expect(await runCreate(['--help'], h.write, PLAIN, h.host)).toBe('ok');
    expect(h.sent).toHaveLength(0);
  });

  it('refuses an option it does not have rather than ignoring it', async () => {
    const h = harness();
    expect(await runCreate(['--force'], h.write, PLAIN, h.host)).toBe('usage');
    expect(h.sent).toHaveLength(0);
  });
});
