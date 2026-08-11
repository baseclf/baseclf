import { describe, expect, it } from 'vitest';

import { CREATE_CRONS, CREATE_PLAN, SIGNING_SECRET_NAME } from './create.js';
import { findVoiceViolations, PLAIN } from './output.js';
import { CREATE_FIXED_TEXT, type CreateHost, runCreate } from './run-create.js';

const TOKEN_CANARY = 'oauth-token-never-printed';
const ACCOUNT = 'acct_9f21c4';
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
  readonly authFileText?: string | undefined;
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
        JSON.stringify({ success: false, errors: [{ code: 10001, message: 'nope' }] }),
        {
          status: 500,
        },
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

  const host: CreateHost = {
    fetcher: fetcher as CreateHost['fetcher'],
    readWorkerBundle: async () => 'export default { fetch() {} }',
    refreshLogin: async () => (options.whoami === undefined ? WHOAMI : options.whoami),
    readAuthFile: () =>
      options.authFileText === undefined && !('authFileText' in options)
        ? authFile()
        : options.authFileText,
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

  return { host, sent, lines, write, text: () => lines.join('\n') };
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
  it('refuses when there is no login, and names wrangler rather than permissions', async () => {
    const h = harness({ authFileText: undefined });
    const outcome = await runCreate([], h.write, PLAIN, h.host);

    expect(outcome).toBe('failed');
    expect(h.text()).toMatch(/wrangler login/);
    expect(h.text()).not.toMatch(/permission/i);
  });

  it('refuses when wrangler cannot be run at all', async () => {
    const h = harness({ whoami: null });
    const outcome = await runCreate([], h.write, PLAIN, h.host);

    expect(outcome).toBe('failed');
    expect(h.text()).toContain('wrangler login');
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
