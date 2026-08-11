import { describe, expect, it } from 'vitest';

import { findVoiceViolations } from './output.js';
import {
  authProfileBaseName,
  chooseCredential,
  EXPIRY_MARGIN_MS,
  joinPath,
  type MachinePaths,
  parseAuthConfig,
  readOAuthCredential,
  readWhoami,
  wranglerAuthPath,
  wranglerConfigRoot,
  xdgConfigHome,
} from './wrangler-credential.js';

/**
 * A token that must never reach a message. Named so a leak is obvious in a diff
 * rather than plausible.
 */
const OAUTH_CANARY = 'oauth-canary-never-printed';

/**
 * ⚠️ Short on purpose. The first version spelled the word canary out after the prefix
 * and `scripts/guard-commit.mjs` refused the commit: to the guard, a user-token prefix
 * followed by twenty or more characters is a token, and it has no way to know better.
 * The guard was right and the fixture was wrong, which is the way round this always
 * goes. Same shape as the fixtures in `secret.test.ts`.
 *
 * ⚠️ And the second attempt was blocked too, because this note quoted the rejected
 * value while explaining it. A comment is file content. Describe the shape, do not
 * reproduce it.
 */
const API_CANARY = 'cfut_EXAMPLE_TOKEN';

const NOW = new Date('2026-08-12T00:00:00.000Z');

/**
 * The config file as wrangler 4.115.0 really writes it, measured on 2026-08-12.
 *
 * The token values are canaries and the rest is verbatim in shape: quoted strings, a
 * quoted ISO expiry, and a scope list on one line. A fixture invented from memory
 * would let a parser pass that the real file breaks.
 */
function configFile(expiry: string, token: string = OAUTH_CANARY): string {
  return [
    `oauth_token = "${token}"`,
    `expiration_time = "${expiry}"`,
    'refresh_token = "refresh-canary-never-printed"',
    'scopes = [ "account:read", "user:read", "workers:write", "d1:write", "offline_access" ]',
    '',
  ].join('\n');
}

function machine(overrides: Partial<MachinePaths> = {}): MachinePaths {
  return {
    platform: 'win32',
    home: 'C:\\Users\\Reader',
    env: {},
    isDirectory: () => false,
    ...overrides,
  };
}

describe('where wrangler keeps its credential', () => {
  it('prefers the legacy home directory when it exists, even though an XDG path also resolves', () => {
    // The measured trap. On the machine this was written on, both directories existed
    // and held different tokens, and the home one was the current one. An
    // implementation that derived the XDG path and stopped would have used a token
    // two weeks stale, and the failure names permissions.
    const paths = machine({
      env: { APPDATA: 'C:\\Users\\Reader\\AppData\\Roaming' },
      isDirectory: (path) => path === 'C:\\Users\\Reader\\.wrangler',
    });

    expect(wranglerConfigRoot(paths)).toBe('C:\\Users\\Reader\\.wrangler');
  });

  it('falls back to the XDG path when the legacy directory is absent', () => {
    const paths = machine({ env: { APPDATA: 'C:\\Users\\Reader\\AppData\\Roaming' } });

    expect(wranglerConfigRoot(paths)).toBe(
      'C:\\Users\\Reader\\AppData\\Roaming\\xdg.config\\.wrangler',
    );
  });

  it('puts the Windows config inside xdg.config rather than in APPDATA itself', () => {
    // Where the second, stale file was hiding. Somewhere nobody would look.
    expect(xdgConfigHome(machine({ env: { APPDATA: 'C:\\App Data' } }))).toBe(
      'C:\\App Data\\xdg.config',
    );
  });

  it('derives APPDATA from the home directory when the variable is missing', () => {
    expect(xdgConfigHome(machine())).toBe('C:\\Users\\Reader\\AppData\\Roaming\\xdg.config');
  });

  it('uses Library Preferences on macOS and .config elsewhere', () => {
    expect(xdgConfigHome(machine({ platform: 'darwin', home: '/Users/reader' }))).toBe(
      '/Users/reader/Library/Preferences',
    );
    expect(xdgConfigHome(machine({ platform: 'linux', home: '/home/reader' }))).toBe(
      '/home/reader/.config',
    );
  });

  it('lets XDG_CONFIG_HOME override the platform default', () => {
    const paths = machine({
      platform: 'linux',
      home: '/home/reader',
      env: { XDG_CONFIG_HOME: '/elsewhere' },
    });

    expect(xdgConfigHome(paths)).toBe('/elsewhere');
    expect(wranglerConfigRoot(paths)).toBe('/elsewhere/.wrangler');
  });

  it('reads the profile named by WRANGLER_API_ENVIRONMENT, and default means production', () => {
    // A reader pointed at staging keeps their token in staging.toml. Reading
    // default.toml would find nothing, or a different account.
    expect(authProfileBaseName({})).toBe('default');
    expect(authProfileBaseName({ WRANGLER_API_ENVIRONMENT: 'production' })).toBe('default');
    expect(authProfileBaseName({ WRANGLER_API_ENVIRONMENT: 'staging' })).toBe('staging');
  });

  it('builds the whole path the way wrangler does', () => {
    const paths = machine({
      platform: 'linux',
      home: '/home/reader',
      isDirectory: (path) => path === '/home/reader/.wrangler',
    });

    expect(wranglerAuthPath(paths)).toBe('/home/reader/.wrangler/config/default.toml');
  });

  it('joins without doubling or dropping separators', () => {
    expect(joinPath('linux', '/home/reader/', '/config/', 'x.toml')).toBe(
      '/home/reader/config/x.toml',
    );
    expect(joinPath('win32', 'C:\\Users\\Reader\\', 'config')).toBe('C:\\Users\\Reader\\config');
  });
});

describe('reading the config file', () => {
  it('reads the keys out of the shape wrangler really writes', () => {
    const parsed = parseAuthConfig(configFile('2026-08-12T01:00:00.000Z'));

    expect(parsed.oauthToken).toBe(OAUTH_CANARY);
    expect(parsed.expiresAt).toBe('2026-08-12T01:00:00.000Z');
    expect(parsed.scopes).toContain('d1:write');
    expect(parsed.scopes).toContain('offline_access');
  });

  it('stops at a table header rather than reading a same-named key out of one', () => {
    // A line-based reader that ignored sections would happily take a key out of a
    // table wrangler adds later, and pick the wrong credential without saying so.
    const text = ['oauth_token = "top-level"', '', '[other]', 'oauth_token = "in-a-table"'].join(
      '\n',
    );

    expect(parseAuthConfig(text).oauthToken).toBe('top-level');
  });

  it('does not invent a token from an empty or absent key', () => {
    expect(parseAuthConfig('').oauthToken).toBeUndefined();
    expect(parseAuthConfig('oauth_token = ""').oauthToken).toBeUndefined();
  });
});

describe('deciding whether the login is usable', () => {
  const PATH = '/home/reader/.wrangler/config/default.toml';

  it('accepts a login with time left on it', () => {
    const result = readOAuthCredential(configFile('2026-08-12T01:00:00.000Z'), NOW, PATH);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token).toBe(OAUTH_CANARY);
  });

  it('refuses an expired login and names wrangler rather than permissions', () => {
    // These last an hour, measured, so this is the ordinary case for anybody who
    // logged in earlier in the day. Cloudflare's own message for a refused
    // credential suggests checking permissions, and that is a day this project has
    // already spent.
    const result = readOAuthCredential(configFile('2026-08-11T23:00:00.000Z'), NOW, PATH);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired');
      expect(result.lines.join(' ')).toMatch(/wrangler/i);
      expect(result.lines.join(' ')).not.toMatch(/permission/i);
    }
  });

  it('refuses a login that expires during the run, not only one already expired', () => {
    // Provisioning is many calls. A token with thirty seconds left starts a run that
    // fails partway through, with resources already created.
    //
    // ⚠️ Thirty seconds is written out rather than derived from EXPIRY_MARGIN_MS, and
    // the first version of this test did derive it. That made the test move with the
    // constant: setting the margin to zero moved the fixture too, the token read as
    // already expired, and the assertion passed while the protection was gone. A
    // mutation caught it. Ledger entry D2, which is the same shape.
    const thirtySecondsLeft = new Date(NOW.getTime() + 30_000).toISOString();
    const result = readOAuthCredential(configFile(thirtySecondsLeft), NOW, PATH);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('keeps a margin bigger than the longest single call a run makes', () => {
    // The margin exists so a token cannot die between two steps. `uploadScript`
    // allows two minutes for one call, so anything at or under that is a margin that
    // does not cover the step it was written for.
    expect(EXPIRY_MARGIN_MS).toBeGreaterThanOrEqual(120_000);
  });

  it('refuses when there is no file, and says how to make one', () => {
    const result = readOAuthCredential(undefined, NOW, PATH);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no-file');
      expect(result.lines.join(' ')).toContain('wrangler login');
      expect(result.lines.join(' ')).toContain(PATH);
    }
  });

  it('refuses a file with no token in it, which is what keyring storage leaves', () => {
    const result = readOAuthCredential('expiration_time = "2026-08-12T01:00:00.000Z"', NOW, PATH);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-token');
  });

  it('refuses rather than guessing when the expiry is missing or unreadable', () => {
    // Using a token with no known expiry turns a clear refusal here into an opaque
    // 401 partway through provisioning.
    const noExpiry = readOAuthCredential(`oauth_token = "${OAUTH_CANARY}"`, NOW, PATH);
    const badExpiry = readOAuthCredential(configFile('not-a-date'), NOW, PATH);

    expect(noExpiry.ok).toBe(false);
    expect(badExpiry.ok).toBe(false);
    if (!noExpiry.ok) expect(noExpiry.reason).toBe('unreadable-expiry');
    if (!badExpiry.ok) expect(badExpiry.reason).toBe('unreadable-expiry');
  });
});

describe('what whoami is read for', () => {
  it('recognises an OAuth session, which is the line that distinguishes the sources', () => {
    // rules/02 section C7: the line naming where the token was read from says the
    // same thing for a real environment variable and for a .env, so it cannot tell
    // them apart. This one can.
    const text = [
      ' ⛅️ wrangler 4.115.0',
      'You are logged in with an OAuth Token, associated with the email reader@example.com.',
      'Credentials are stored in: C:\\Users\\Reader\\.wrangler\\config\\default.toml',
    ].join('\n');

    const facts = readWhoami(text);

    expect(facts.credentialKind).toBe('oauth');
    expect(facts.configPath).toBe('C:\\Users\\Reader\\.wrangler\\config\\default.toml');
  });

  it('recognises an API token session', () => {
    expect(readWhoami('You are logged in with an User API Token.').credentialKind).toBe(
      'api-token',
    );
  });

  it('says unknown rather than guessing when the wording changes', () => {
    // A reworded wrangler should not stop a deployment, and should not be reported
    // as a fact either.
    expect(readWhoami('some future wording entirely').credentialKind).toBe('unknown');
    expect(readWhoami('some future wording entirely').configPath).toBeUndefined();
  });
});

describe('which credential a run uses', () => {
  const liveOAuth = readOAuthCredential(configFile('2026-08-12T01:00:00.000Z'), NOW, '/x');

  it('lets an API token win, because wrangler does', () => {
    // Provisioning shells out to wrangler for the step REST has no equivalent for.
    // Using the login here while wrangler used a token would provision into one
    // account and configure another.
    const choice = chooseCredential({ fromEnvironment: API_CANARY }, liveOAuth);

    expect(choice.ok).toBe(true);
    if (choice.ok) {
      expect(choice.credential.kind).toBe('api-token');
      expect(choice.credential.token).toBe(API_CANARY);
    }
  });

  it('warns when a token silently beats a login the reader just made', () => {
    const choice = chooseCredential({ fromEnvironment: API_CANARY }, liveOAuth);

    expect(choice.ok).toBe(true);
    if (choice.ok) {
      expect(choice.credential.warnings.join(' ')).toContain('CLOUDFLARE_API_TOKEN');
    }
  });

  it('does not warn about a login that is not there to be shadowed', () => {
    const missing = readOAuthCredential(undefined, NOW, '/x');
    const choice = chooseCredential({ fromEnvironment: API_CANARY }, missing);

    expect(choice.ok).toBe(true);
    if (choice.ok) {
      expect(choice.credential.warnings.join(' ')).not.toContain('The token wins');
    }
  });

  it('uses the login when no token is set anywhere', () => {
    const choice = chooseCredential({}, liveOAuth);

    expect(choice.ok).toBe(true);
    if (choice.ok) expect(choice.credential.kind).toBe('oauth');
  });

  it('refuses with the login problem when there is neither', () => {
    const expired = readOAuthCredential(configFile('2026-08-11T23:00:00.000Z'), NOW, '/x');
    const choice = chooseCredential({}, expired);

    expect(choice.ok).toBe(false);
    if (!choice.ok) expect(choice.lines.join(' ')).toMatch(/expired/i);
  });
});

describe('what a reader is allowed to see', () => {
  /** Every reader-facing line this module can produce, in one place. */
  function everyMessage(): readonly string[] {
    const path = '/home/reader/.wrangler/config/default.toml';
    const cases = [
      readOAuthCredential(undefined, NOW, path),
      readOAuthCredential('expiration_time = "2026-08-12T01:00:00.000Z"', NOW, path),
      readOAuthCredential(configFile('2026-08-11T23:00:00.000Z'), NOW, path),
      readOAuthCredential(configFile('not-a-date'), NOW, path),
      readOAuthCredential(`oauth_token = "${OAUTH_CANARY}"`, NOW, path),
    ];

    const lines = cases.flatMap((result) => (result.ok ? [] : result.lines));

    const live = readOAuthCredential(configFile('2026-08-12T01:00:00.000Z'), NOW, path);
    const shadowed = chooseCredential(
      { fromEnvironment: API_CANARY, fromFile: 'cfut_other' },
      live,
    );
    if (shadowed.ok) lines.push(...shadowed.credential.warnings);

    return lines;
  }

  it('never prints a token, a prefix of one, or its length', () => {
    // Length is a disclosure: it narrows a guess, and a terminal ends up in a
    // screenshot. rules/02 section C1.
    for (const line of everyMessage()) {
      expect(line).not.toContain(OAUTH_CANARY);
      expect(line).not.toContain(API_CANARY);
      expect(line).not.toContain(OAUTH_CANARY.slice(0, 8));
      expect(line).not.toContain(String(OAUTH_CANARY.length));
      expect(line).not.toContain(String(API_CANARY.length));
    }
  });

  it('follows the voice rules everywhere it speaks', () => {
    for (const line of everyMessage()) {
      expect(findVoiceViolations(line)).toEqual([]);
    }
  });

  it('has something to say in every refusal', () => {
    expect(everyMessage().length).toBeGreaterThan(0);
    for (const line of everyMessage()) expect(line.trim()).not.toBe('');
  });
});
