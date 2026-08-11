import { describe, expect, it } from 'vitest';

import {
  ID_PREVIEW_LENGTH,
  LOGIN_FIXED_TEXT,
  type LoginHost,
  previewId,
  runLogin,
  shadowWarning,
} from './login.js';
import { findVoiceViolations, PLAIN } from './output.js';

const TOKEN_CANARY = 'oauth-token-never-printed';

/**
 * ⚠️ Made up, and the eight leading zeros are the convention rather than decoration.
 *
 * The first version of this file pasted a real account id in, because one was to
 * hand. A real id is on the never-commit list in `rules/05` section B and this is a
 * public repository. It was caught by reading the file, and the commit guard let it
 * past, so the guard now flags any id-shaped value and treats eight leading zeros as
 * the mark of a fixture. Same shape as the placeholder in `wrangler.jsonc`.
 *
 * Still thirty two characters, so the preview below has something real to truncate.
 */
const ACCOUNT_ID = '00000000e5f60718293a4b5c6d7e8f90';
const NOW = new Date('2026-08-12T00:00:00.000Z');

const WHOAMI = [
  'You are logged in with an OAuth Token, associated with the email reader@example.com.',
  'Credentials are stored in: /home/reader/.wrangler/config/default.toml',
].join('\n');

function authFile(expiry = '2026-08-12T01:00:00.000Z'): string {
  return [`oauth_token = "${TOKEN_CANARY}"`, `expiration_time = "${expiry}"`].join('\n');
}

interface Options {
  readonly env?: Record<string, string | undefined>;
  readonly envFile?: string | undefined;
  readonly loginWorks?: boolean;
  readonly whoami?: string | null;
  readonly authFileText?: string | undefined;
  readonly accounts?: readonly { id: string; name: string }[];
}

interface Harness {
  readonly host: LoginHost;
  readonly lines: string[];
  readonly write: (text: string) => void;
  readonly text: () => string;
  readonly loginAttempts: () => number;
}

function harness(options: Options = {}): Harness {
  const lines: string[] = [];
  let attempts = 0;

  const accounts = options.accounts ?? [{ id: ACCOUNT_ID, name: 'Blank Account' }];

  const host: LoginHost = {
    fetcher: (async (url: string) => {
      if (url.endsWith('/accounts')) {
        return new Response(JSON.stringify({ success: true, result: accounts }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
    }) as LoginHost['fetcher'],
    runWranglerLogin: async () => {
      attempts += 1;
      return options.loginWorks ?? true;
    },
    refreshLogin: async () => (options.whoami === undefined ? WHOAMI : options.whoami),
    readAuthFile: () => ('authFileText' in options ? options.authFileText : authFile()),
    paths: {
      platform: 'linux',
      home: '/home/reader',
      env: options.env ?? {},
      isDirectory: () => true,
    },
    envFile: options.envFile,
    now: () => NOW,
  };

  return {
    host,
    lines,
    write: (text) => {
      lines.push(text);
    },
    text: () => lines.join('\n'),
    loginAttempts: () => attempts,
  };
}

describe('refusing to log in when the login would be ignored', () => {
  it('does not start the browser flow while a token is in the environment', async () => {
    // 🔴 The reason this command exists. A token always wins, so the flow would
    // succeed completely and change nothing, and the reader would then debug a
    // credential they did not know they were using.
    const h = harness({ env: { CLOUDFLARE_API_TOKEN: 'cfut_EXAMPLE_ENV' } });
    const outcome = await runLogin([], h.write, PLAIN, h.host);

    expect(outcome).toBe('failed');
    expect(h.loginAttempts()).toBe(0);
  });

  it('does not start the browser flow while a token is in a .env', async () => {
    const h = harness({ envFile: 'CLOUDFLARE_API_TOKEN=cfut_EXAMPLE_FILE\n' });

    expect(await runLogin([], h.write, PLAIN, h.host)).toBe('failed');
    expect(h.loginAttempts()).toBe(0);
  });

  it('ignores a .env whose token line is empty', async () => {
    // A commented-out or emptied line is somebody who has already done the thing
    // this would ask them to do.
    const h = harness({ envFile: 'CLOUDFLARE_API_TOKEN=\n# CLOUDFLARE_API_TOKEN=cfut_OLD\n' });

    expect(await runLogin([], h.write, PLAIN, h.host)).toBe('ok');
    expect(h.loginAttempts()).toBe(1);
  });

  it('gives the fix for both shells, one command per line', async () => {
    // rules/02 section C8: this machine's default terminal is cmd.exe, where a `;`
    // is pushed through as an argument rather than run as a separator. A copied line
    // that silently becomes an argument list is a second failure on top of the first.
    const warning = shadowWarning({ CLOUDFLARE_API_TOKEN: 'cfut_EXAMPLE_ENV' }, undefined).join(
      '\n',
    );

    expect(warning).toContain('Remove-Item Env:CLOUDFLARE_API_TOKEN');
    expect(warning).toContain('set CLOUDFLARE_API_TOKEN=');
    expect(warning).not.toMatch(/&&|;\s*\w/);
  });

  it('says that clearing it at user scope is not enough on its own', async () => {
    // The half that cost this project the day. A parent process that started earlier
    // keeps its own copy, and every child inherits it.
    const warning = shadowWarning({ CLOUDFLARE_API_TOKEN: 'cfut_EXAMPLE_ENV' }, undefined).join(
      '\n',
    );

    expect(warning).toMatch(/parent process/i);
    expect(warning).toMatch(/restarted/i);
  });

  it('says nothing when nothing is shadowing', () => {
    expect(shadowWarning({}, undefined)).toEqual([]);
    expect(shadowWarning({ CLOUDFLARE_API_TOKEN: '' }, 'OTHER=1\n')).toEqual([]);
  });
});

describe('after the browser flow', () => {
  it('reports which account the login landed on', async () => {
    // What `wrangler login` does not tell you, and the reason for the second half of
    // this command. Somebody with two accounts has no way to know which one they got.
    const h = harness();
    const outcome = await runLogin([], h.write, PLAIN, h.host);

    expect(outcome).toBe('ok');
    expect(h.text()).toContain('Blank Account');
  });

  it('prints only enough of the account id to recognise it', async () => {
    // Terminals end up in screenshots. Eight characters distinguishes any two
    // accounts a person actually has.
    const h = harness();
    await runLogin([], h.write, PLAIN, h.host);

    expect(h.text()).toContain(ACCOUNT_ID.slice(0, ID_PREVIEW_LENGTH));
    expect(h.text()).not.toContain(ACCOUNT_ID);
  });

  it('lists every account and says to pick one when there are several', async () => {
    const h = harness({
      accounts: [
        { id: 'aaaaaaaa1111', name: 'Personal' },
        { id: 'bbbbbbbb2222', name: 'Work' },
      ],
    });

    expect(await runLogin([], h.write, PLAIN, h.host)).toBe('ok');
    expect(h.text()).toContain('Personal');
    expect(h.text()).toContain('Work');
    expect(h.text()).toContain('CLOUDFLARE_ACCOUNT_ID');
  });

  it('fails when the browser flow did not finish', async () => {
    const h = harness({ loginWorks: false });

    expect(await runLogin([], h.write, PLAIN, h.host)).toBe('failed');
    expect(h.text()).toMatch(/Nothing changed/i);
  });

  it('fails when the flow finished but left nothing usable', async () => {
    const h = harness({ authFileText: undefined });

    expect(await runLogin([], h.write, PLAIN, h.host)).toBe('failed');
  });

  it('fails when the credential it wrote has already expired', async () => {
    // These last an hour, so a stale file after a login means something else wrote it.
    const h = harness({ authFileText: authFile('2026-08-11T23:00:00.000Z') });

    expect(await runLogin([], h.write, PLAIN, h.host)).toBe('failed');
    expect(h.text()).toMatch(/expired/i);
  });

  it('fails when the login has no account at all', async () => {
    const h = harness({ accounts: [] });

    expect(await runLogin([], h.write, PLAIN, h.host)).toBe('failed');
  });
});

describe('what a reader is allowed to see', () => {
  it('never prints the token, a prefix of it, or its length', async () => {
    const h = harness();
    await runLogin([], h.write, PLAIN, h.host);

    for (const line of h.lines) {
      expect(line).not.toContain(TOKEN_CANARY);
      expect(line).not.toContain(TOKEN_CANARY.slice(0, 8));
      expect(line).not.toContain(String(TOKEN_CANARY.length));
    }
  });

  it('never prints a shadowing token even while refusing because of it', async () => {
    const h = harness({
      env: { CLOUDFLARE_API_TOKEN: 'cfut_EXAMPLE_ENV' },
      envFile: 'CLOUDFLARE_API_TOKEN=cfut_EXAMPLE_FILE\n',
    });
    await runLogin([], h.write, PLAIN, h.host);

    for (const line of h.lines) {
      expect(line).not.toContain('cfut_EXAMPLE_ENV');
      expect(line).not.toContain('cfut_EXAMPLE_FILE');
    }
  });

  it('follows the voice rules in everything it can print', async () => {
    const h = harness({ env: { CLOUDFLARE_API_TOKEN: 'cfut_EXAMPLE_ENV' } });
    await runLogin([], h.write, PLAIN, h.host);

    const clean = harness();
    await runLogin([], clean.write, PLAIN, clean.host);

    for (const line of [...h.lines, ...clean.lines, ...LOGIN_FIXED_TEXT]) {
      expect(findVoiceViolations(line)).toEqual([]);
    }
  });

  it('answers --help without running anything', async () => {
    const h = harness();

    expect(await runLogin(['--help'], h.write, PLAIN, h.host)).toBe('ok');
    expect(h.loginAttempts()).toBe(0);
  });

  it('refuses an option it does not have rather than ignoring it', async () => {
    const h = harness();

    expect(await runLogin(['--account', 'x'], h.write, PLAIN, h.host)).toBe('usage');
    expect(h.loginAttempts()).toBe(0);
  });

  it('truncates an id shorter than the preview length without inventing characters', () => {
    expect(previewId('abc')).toBe('abc...');
  });
});
