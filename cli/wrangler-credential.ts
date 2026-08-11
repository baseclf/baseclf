/**
 * The credential `create` provisions with, taken from the one wrangler already has.
 *
 * Onboarding asks nobody for a token. `wrangler login` runs Cloudflare's own OAuth
 * flow, the credential stays on the reader's machine, and this file is how the rest
 * of the CLI reaches it. That is `FOUNDATION.md` section 6 as a mechanism rather than
 * as a promise, and `rules/02` section C3 is the measurement that made it possible:
 * the granted scopes cover Workers, D1, KV and R2.
 *
 * Everything below was measured against wrangler 4.115.0 on 2026-08-12 rather than
 * inferred, because the whole file is a replication of another tool's private
 * behaviour and every branch that is guessed wrong picks a credential silently.
 *
 * ## What was measured, and why each one is here
 *
 *   1. 🔴 **There were two config files on the machine this was written on**, and they
 *      held different tokens: `~/.wrangler/config/default.toml` written the day of the
 *      login, and `%APPDATA%/xdg.config/.wrangler/config/default.toml` two weeks
 *      stale. The obvious implementations, "read whichever exists" and "prefer the XDG
 *      path", both pick the stale one. Wrangler's own rule is that the legacy home
 *      directory wins whenever it exists, and `wranglerConfigRoot` copies it exactly.
 *   2. ⭐ **The access token lasts one hour.** Measured: written at 15:48Z, expiring at
 *      16:48Z. So an expired token is the ordinary case rather than the edge case, and
 *      anything that only reads the file is broken for every reader who logged in
 *      earlier in the day.
 *   3. ⭐ **`wrangler whoami` refreshes it and rewrites the file.** Measured across one
 *      call: expiry moved from 16:48Z to 18:51Z. So the refresh is not reimplemented
 *      here. Wrangler owns its own OAuth dance, including the client id and the token
 *      endpoint, and reimplementing that would be a second copy of something that
 *      changes without notice.
 *   4. **An API token in the environment beats the OAuth session, silently.** That is
 *      `rules/02` section C1, and it cost this project a day. This file matches
 *      wrangler's precedence rather than fighting it, so that both halves of a run
 *      that shells out to wrangler are talking to the same account.
 *
 * ⚠️ No `node:` imports. Reading a file and running a process happen at the edge and
 * are passed in, so the decisions live where the tests can reach them. Same seam as
 * `cli/token.ts` and for the same reason.
 *
 * ⚠️ Nothing here prints a token, a prefix of one, or its length. Length is a
 * disclosure: it narrows a guess, and terminals end up in screenshots.
 */

import { decideToken, type TokenDecision, type TokenInputs } from './token.js';

export type Platform = 'win32' | 'darwin' | 'linux';

/** What the machine looks like. Injected, so the resolution below can be tested. */
export interface MachinePaths {
  readonly platform: Platform;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether a path is a directory. The legacy rule turns on this and nothing else. */
  readonly isDirectory: (path: string) => boolean;
}

function separator(platform: Platform): string {
  return platform === 'win32' ? '\\' : '/';
}

/**
 * Join path segments the way the platform writes them.
 *
 * Small enough to own. `node:path` is not importable here, and a dependency in a
 * credential path is attack surface for a function that joins strings.
 */
export function joinPath(platform: Platform, ...parts: readonly string[]): string {
  const sep = separator(platform);
  return parts
    .filter((part) => part !== '')
    .map((part, index) =>
      index === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, ''),
    )
    .join(sep);
}

/**
 * Where XDG-style config lives, per platform.
 *
 * Copied from wrangler's `xdgConfig()`. The Windows answer is the surprising one: not
 * `%APPDATA%` itself but an `xdg.config` directory inside it, which is why the second
 * config file on the measurement machine was somewhere nobody would look.
 */
export function xdgConfigHome(paths: MachinePaths): string {
  const override = paths.env.XDG_CONFIG_HOME;
  if (override !== undefined && override !== '') return override;

  if (paths.platform === 'darwin') {
    return joinPath(paths.platform, paths.home, 'Library', 'Preferences');
  }
  if (paths.platform === 'win32') {
    const appData =
      paths.env.APPDATA !== undefined && paths.env.APPDATA !== ''
        ? paths.env.APPDATA
        : joinPath(paths.platform, paths.home, 'AppData', 'Roaming');
    return joinPath(paths.platform, appData, 'xdg.config');
  }
  return joinPath(paths.platform, paths.home, '.config');
}

/**
 * The directory wrangler keeps its global state in.
 *
 * 🔴 The legacy home directory wins whenever it exists, and that is the whole point of
 * this function. On the machine this was measured on, both directories were present
 * and held different tokens; the home one was current and the XDG one was two weeks
 * old. Deriving the XDG path and stopping there would have provisioned against a stale
 * credential, which fails with a message about permissions.
 */
export function wranglerConfigRoot(paths: MachinePaths): string {
  const legacy = joinPath(paths.platform, paths.home, '.wrangler');
  if (paths.isDirectory(legacy)) return legacy;
  return joinPath(paths.platform, xdgConfigHome(paths), '.wrangler');
}

/**
 * Which profile file to read.
 *
 * `WRANGLER_API_ENVIRONMENT` selects it, defaults to `production`, and `production`
 * maps to the file named `default`. Anything else names its own file, so a reader
 * pointed at staging has their token in `staging.toml` and reading `default.toml`
 * would find either nothing or a different account.
 */
export function authProfileBaseName(env: Readonly<Record<string, string | undefined>>): string {
  const environment = env.WRANGLER_API_ENVIRONMENT;
  if (environment === undefined || environment === '' || environment === 'production') {
    return 'default';
  }
  return environment;
}

/** The full path to the file holding the OAuth credential. */
export function wranglerAuthPath(paths: MachinePaths): string {
  return joinPath(
    paths.platform,
    wranglerConfigRoot(paths),
    'config',
    `${authProfileBaseName(paths.env)}.toml`,
  );
}

export interface AuthConfig {
  /** Never logged, never included in a message. */
  readonly oauthToken: string | undefined;
  /** Raw, as written. Parsed by the caller so a malformed value can be reported. */
  readonly expiresAt: string | undefined;
  readonly scopes: readonly string[];
}

/**
 * Read the four keys this needs out of the config file.
 *
 * ⚠️ Deliberately not a TOML parser, and not backed by one. A general parser here
 * would be a dependency on the credential path, which `rules/03` section G says to
 * ask about rather than add, for a file whose entire relevant surface is four
 * top-level keys.
 *
 * ⚠️ It stops at the first table header. Every key that matters is at the top level
 * today, and a line-based reader that ignored `[sections]` would happily pick a
 * same-named key out of a table wrangler adds later. Stopping is the failure that
 * announces itself; reading on is the one that does not.
 */
export function parseAuthConfig(text: string): AuthConfig {
  let oauthToken: string | undefined;
  let expiresAt: string | undefined;
  let scopes: readonly string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) break;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match === null) continue;

    const [, key, value] = match;
    if (key === 'oauth_token') oauthToken = unquote(value ?? '');
    else if (key === 'expiration_time') expiresAt = unquote(value ?? '');
    else if (key === 'scopes') scopes = parseScopeList(value ?? '');
  }

  return {
    oauthToken: emptyToUndefined(oauthToken),
    expiresAt: emptyToUndefined(expiresAt),
    scopes,
  };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^"(.*)"$/) ?? trimmed.match(/^'(.*)'$/);
  return (quoted?.[1] ?? trimmed).trim();
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The scope list, for reporting only.
 *
 * ⚠️ Read but never acted on, and that is deliberate. `rules/02` section C10 records
 * the project reading 83 scope strings out of wrangler's bundle, finding nothing for
 * R2, and concluding R2 was out of reach of OAuth. Every step of that was right and
 * the conclusion was wrong: R2 bucket creation works under `workers:write`. A scope
 * list is not a description of what a token can do, so nothing here refuses on one.
 */
function parseScopeList(value: string): readonly string[] {
  const inside = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  return inside
    .split(',')
    .map((entry) => unquote(entry))
    .filter((entry) => entry !== '');
}

/**
 * How much life a token needs left to be worth starting a run with.
 *
 * A judgment rather than a measurement: how long provisioning takes end to end has not
 * been timed. It is larger than any single call's timeout, including the two minutes
 * `uploadScript` allows, so a token that passes this is not one that expires between
 * two steps. The real protection is refreshing immediately before starting, which is
 * what `whoami` does.
 */
export const EXPIRY_MARGIN_MS = 120_000;

export type OAuthCredential =
  | {
      readonly ok: true;
      readonly token: string;
      readonly expiresAt: Date | undefined;
      readonly scopes: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: 'no-file' | 'no-token' | 'expired' | 'unreadable-expiry';
      readonly lines: readonly string[];
    };

/**
 * Turn the file into a usable credential, or into a reason a reader can act on.
 *
 * Every refusal names `wrangler login` rather than permissions. Cloudflare's own
 * message for a refused credential suggests checking permissions, and `rules/02`
 * section C1 is a day spent on permissions that were already correct.
 */
export function readOAuthCredential(
  text: string | undefined,
  now: Date,
  path: string,
): OAuthCredential {
  if (text === undefined) {
    return {
      ok: false,
      reason: 'no-file',
      lines: [
        'There is no Cloudflare login on this machine yet.',
        `Nothing was found at ${path}`,
        'Run: npx wrangler login',
      ],
    };
  }

  const config = parseAuthConfig(text);

  if (config.oauthToken === undefined) {
    return {
      ok: false,
      reason: 'no-token',
      lines: [
        'That Cloudflare config file has no OAuth token in it.',
        // Wrangler can keep the credential in the OS keyring or in an encrypted file
        // instead, and then the plain file is present but empty of what we need.
        // Logging in again writes the plain one, which is the shortest way out.
        'If you logged in with the keyring option, run "npx wrangler login" again without it.',
      ],
    };
  }

  // Absent and unreadable are one branch, and they were two until a mutation showed
  // why they should not be. An expiry that is missing fails the parse below anyway, so
  // the separate check could be deleted without any test noticing: the second layer
  // was covering for the first rather than adding to it, which is the shape recorded
  // as D3 in the error ledger. One outcome and one instruction means one branch.
  //
  // Refusing here rather than trying the token is the point. No expiry means no way to
  // tell a live credential from a dead one, and using it anyway turns a clear refusal
  // into an opaque 401 partway through provisioning, after resources exist.
  const expiresAt = config.expiresAt === undefined ? undefined : new Date(config.expiresAt);
  if (expiresAt === undefined || Number.isNaN(expiresAt.getTime())) {
    return {
      ok: false,
      reason: 'unreadable-expiry',
      lines: [
        'There is no readable expiry on that Cloudflare login, so there is no way to tell ' +
          'whether it is still good.',
        'Run: npx wrangler login',
      ],
    };
  }

  if (expiresAt.getTime() - now.getTime() <= EXPIRY_MARGIN_MS) {
    return {
      ok: false,
      reason: 'expired',
      lines: [
        'That Cloudflare login has expired. These last an hour.',
        'Running any wrangler command refreshes it, and "npx wrangler whoami" is the cheapest.',
      ],
    };
  }

  return { ok: true, token: config.oauthToken, expiresAt, scopes: config.scopes };
}

/**
 * The two facts worth taking from `wrangler whoami`.
 *
 * ⚠️ Parsing another tool's output is fragile and this reads as little of it as it
 * can get away with. It is here because `rules/02` section C7 measured that the line
 * naming where the token was read from says the same thing whether it came from the
 * environment or from a `.env`, so it cannot be used to tell them apart. The line that
 * does tell them apart is the one naming the credential kind.
 *
 * A shape that is not recognised comes back `unknown` rather than guessing. The caller
 * treats that as "carry on but say so": a wrangler that reworded its output should not
 * stop a deployment, and it should not be reported as a fact either.
 */
export interface WhoamiFacts {
  readonly credentialKind: 'oauth' | 'api-token' | 'unknown';
  /** The path wrangler itself names, when it names one. */
  readonly configPath: string | undefined;
}

export function readWhoami(text: string): WhoamiFacts {
  const oauth = /logged in with an OAuth Token/i.test(text);
  const apiToken = /logged in with an [A-Za-z]* ?API Token/i.test(text);

  const pathLine = text.match(/Credentials are stored in:\s*(.+)/i);

  return {
    credentialKind: oauth ? 'oauth' : apiToken ? 'api-token' : 'unknown',
    configPath: pathLine?.[1]?.trim(),
  };
}

export type CredentialKind = 'api-token' | 'oauth';

export interface ChosenCredential {
  readonly kind: CredentialKind;
  /** Never printed. */
  readonly token: string;
  /** Things a reader would not otherwise guess, in the order they matter. */
  readonly warnings: readonly string[];
}

export type CredentialChoice =
  | { readonly ok: true; readonly credential: ChosenCredential }
  | { readonly ok: false; readonly lines: readonly string[] };

/**
 * Which credential a run uses, matching wrangler's own precedence.
 *
 * 🔴 An API token in the environment wins, and this copies that rather than
 * overriding it. The reason is a failure mode rather than deference: provisioning
 * shells out to wrangler for the step the REST API has no equivalent for, so a run
 * that used the OAuth session for its own calls while wrangler used an environment
 * token would provision into one account and configure another. That is `rules/02`
 * section C1 wearing different clothes, and the symptom would again be a message
 * about permissions.
 *
 * The warning matters more than the choice. Somebody who just ran `wrangler login`
 * reasonably assumes the login is what is being used, and nothing on any surface says
 * otherwise.
 */
export function chooseCredential(
  tokenInputs: TokenInputs,
  oauth: OAuthCredential,
): CredentialChoice {
  const decision: TokenDecision = decideToken(tokenInputs);

  if (decision.token !== undefined) {
    const warnings = [...decision.warnings.filter((line) => !line.startsWith('No API token'))];

    if (oauth.ok) {
      warnings.unshift(
        'You are logged in with wrangler, and an API token is also set. The token wins, for ' +
          'wrangler as well as here, so this run uses the token and not the login. Clear ' +
          'CLOUDFLARE_API_TOKEN to use the login instead.',
      );
    }

    return { ok: true, credential: { kind: 'api-token', token: decision.token, warnings } };
  }

  if (!oauth.ok) return { ok: false, lines: oauth.lines };

  return { ok: true, credential: { kind: 'oauth', token: oauth.token, warnings: [] } };
}
