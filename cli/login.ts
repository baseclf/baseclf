/**
 * Log in to Cloudflare, and prove which account the login actually landed on.
 *
 * `wrangler login` already exists and this is not a wrapper around it for the sake of
 * one. It is here because running it can succeed completely and change nothing:
 *
 *   🔴 **An API token in the environment beats the login, silently.** If
 *   `CLOUDFLARE_API_TOKEN` is set in the shell or sitting in a `.env`, that is the
 *   credential every later command uses, and the browser flow that just finished is
 *   ignored. Nothing says so. `rules/02` section C1 is a day lost to exactly this,
 *   and the symptom pointed at permissions the whole time.
 *
 * So this refuses to start the browser flow while something would shadow it. Running
 * a login whose result cannot be used is not a warning, it is a lie with a progress
 * bar, and the reader ends up debugging the wrong credential.
 *
 * The second half is the part `wrangler login` does not do: **it says which account
 * you got.** Somebody with a personal account and a work account has no way to tell
 * from the browser flow which one the token now speaks for, and finding out later
 * costs them resources on the wrong bill.
 *
 * ⚠️ Nothing here prints a token, a prefix of one, or a length. Account ids are
 * printed truncated for the same reason: enough to recognise, not enough to be worth
 * a screenshot.
 */

import { type Fetcher, listAccounts } from './cloudflare.js';
import { note, type Style, styledResultLine } from './output.js';
import {
  type MachinePaths,
  readOAuthCredential,
  readWhoami,
  wranglerAuthPath,
} from './wrangler-credential.js';

type Write = (text: string) => void;

export type LoginOutcome = 'ok' | 'usage' | 'failed';

export interface LoginHost {
  readonly fetcher: Fetcher;
  /** Run `npx wrangler login`. Opens a browser and blocks until it is answered. */
  readonly runWranglerLogin: () => Promise<boolean>;
  /** Run `npx wrangler whoami`, which also refreshes the token it just wrote. */
  readonly refreshLogin: () => Promise<string | null>;
  readonly readAuthFile: (path: string) => string | undefined;
  readonly paths: MachinePaths;
  /** A `.env` in the working directory, when there is one. */
  readonly envFile?: string | undefined;
  readonly now: () => Date;
}

export const LOGIN_USAGE = [
  'baseclf login',
  '',
  'Logs in to Cloudflare through wrangler, then says which account you landed on.',
  'The credential stays on this machine. Nothing is sent anywhere.',
  '',
  'It refuses to start while CLOUDFLARE_API_TOKEN is set, because a token always',
  'wins over a login and the login would have no effect.',
].join('\n');

/** How much of an account id is enough to tell two apart. */
export const ID_PREVIEW_LENGTH = 8;

/**
 * Enough of an id to recognise, and no more.
 *
 * The whole value is what somebody needs to act on an account, and this is printed
 * into a terminal that may end up in a screenshot. Eight characters distinguishes any
 * two accounts a person actually has.
 */
export function previewId(id: string): string {
  return `${id.slice(0, ID_PREVIEW_LENGTH)}...`;
}

/**
 * `CLOUDFLARE_API_TOKEN` out of a `.env`, if it is in there.
 *
 * Only whether it is set matters here, never the value.
 */
function envFileHasToken(text: string | undefined): boolean {
  if (text === undefined) return false;
  const line = text.split(/\r?\n/).find((each) => /^\s*CLOUDFLARE_API_TOKEN\s*=/.test(each));
  if (line === undefined) return false;
  return line.slice(line.indexOf('=') + 1).trim() !== '';
}

/**
 * Say what is shadowing the login, and how to clear it, or nothing when nothing is.
 *
 * Both shells, one command per line. `rules/02` section C8: this machine's default
 * terminal is cmd.exe, where `;` is pushed through as an argument rather than run as
 * a separator, and a copied line that silently becomes an argument list is a second
 * failure on top of the one being fixed.
 */
export function shadowWarning(
  env: Readonly<Record<string, string | undefined>>,
  envFile: string | undefined,
): readonly string[] {
  const inEnvironment = (env.CLOUDFLARE_API_TOKEN ?? '').trim() !== '';
  const inFile = envFileHasToken(envFile);

  if (!inEnvironment && !inFile) return [];

  const lines: string[] = [];

  if (inEnvironment) {
    lines.push(
      'CLOUDFLARE_API_TOKEN is set in this environment. A token always wins over a login,',
      'for wrangler as well as for this, so logging in would change nothing.',
      '',
      'Clear it for this session:',
      '',
      'PowerShell:',
      '  Remove-Item Env:CLOUDFLARE_API_TOKEN',
      'cmd.exe:',
      '  set CLOUDFLARE_API_TOKEN=',
      '',
      'Removing it at user scope is not enough on its own. A parent process that started',
      'earlier keeps its own copy and every child inherits it, so the terminal has to be',
      'restarted.',
    );
  }

  if (inFile) {
    lines.push(
      'There is a CLOUDFLARE_API_TOKEN in the .env file in this directory. wrangler reads',
      'it when the environment has none, so it would win over the login too. Comment it',
      'out, or run this from a directory without that file.',
    );
  }

  return lines;
}

/**
 * The command.
 *
 * Refuses, logs in, then reports. The report is the half that justifies the command
 * existing: a browser flow that finished tells you nothing about which account you are
 * now holding.
 */
export async function runLogin(
  argv: readonly string[],
  write: Write,
  style: Style,
  host: LoginHost,
): Promise<LoginOutcome> {
  if (argv.includes('--help') || argv.includes('-h')) {
    write(LOGIN_USAGE);
    return 'ok';
  }

  const unknown = argv.find((argument) => argument.startsWith('-'));
  if (unknown !== undefined) {
    write(`baseclf login: there is no "${unknown}" option.\n\n${LOGIN_USAGE}`);
    return 'usage';
  }

  const shadow = shadowWarning(host.paths.env, host.envFile);
  if (shadow.length > 0) {
    write(styledResultLine('deny', 'Something would override the login.', style));
    for (const line of shadow) write(line === '' ? '' : note(line));
    return 'failed';
  }

  write(styledResultLine('attention', 'Opening a browser to log in to Cloudflare.', style));
  write(note('Sign in with the account you want this deployment to live on.'));

  if (!(await host.runWranglerLogin())) {
    write(styledResultLine('deny', 'The login did not finish.', style));
    write(note('Nothing changed. Run it again, or run: npx wrangler login'));
    return 'failed';
  }

  // The same refresh-then-read order `create` uses, and for the same measured reason:
  // an access token lasts an hour and a wrangler command is what rewrites the file.
  const whoami = await host.refreshLogin();
  if (whoami === null) {
    write(styledResultLine('deny', 'Logged in, but wrangler could not be asked about it.', style));
    return 'failed';
  }

  const facts = readWhoami(whoami);
  const path = facts.configPath ?? wranglerAuthPath(host.paths);
  const credential = readOAuthCredential(host.readAuthFile(path), host.now(), path);

  if (!credential.ok) {
    write(styledResultLine('deny', 'The login finished but left no usable credential.', style));
    for (const line of credential.lines) write(note(line));
    return 'failed';
  }

  const accounts = await listAccounts(host.fetcher, credential.token);

  if (accounts.length === 0) {
    write(styledResultLine('deny', 'That login has no Cloudflare account on it.', style));
    return 'failed';
  }

  write(styledResultLine('allow', 'Logged in.', style));

  for (const account of accounts) {
    write(note(`${account.name}  ${previewId(account.id)}`));
  }

  if (accounts.length > 1) {
    // Not a failure here, because logging in worked. It becomes one at `create`, which
    // refuses to pick rather than put a database on the wrong bill.
    write(note('More than one account. Set CLOUDFLARE_ACCOUNT_ID before running create, so it'));
    write(note('does not have to choose.'));
  }

  return 'ok';
}

/** Every fixed string this command can print, for the voice rules to check. */
export const LOGIN_FIXED_TEXT: readonly string[] = Object.freeze([LOGIN_USAGE]);
