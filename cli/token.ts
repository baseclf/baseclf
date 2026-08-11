/**
 * Which token is about to be used, and whether something else will win.
 *
 * This file exists because of a day lost to the thing it checks. The record is in
 * `rules/02` §C1 and it is worth reading, because the way it went wrong is more
 * instructive than the fix.
 *
 * A stale `CLOUDFLARE_API_TOKEN` sat in the machine's user-scope environment. A real
 * environment variable always beats a `.env` file, so wrangler never saw any token
 * that was pasted into `.env`, and every attempt was testing a third token nobody
 * knew existed. The symptoms pointed elsewhere entirely: `whoami` said
 * `Invalid access token`, `d1 list` said `Authentication error` and suggested
 * checking permissions, and the permissions were perfect. The conclusion drawn at
 * the time, that wrangler would not accept this kind of token, was wrong.
 *
 * Worse, and this is the part a checker has to handle: **removing the variable from
 * user scope was not enough.** The parent process had started before the removal and
 * kept its own copy, and every child inherited it. It took restarting the terminal.
 *
 * So the rule this file encodes:
 *
 *   > When a tool and the raw API disagree, do not conclude anything about the tool
 *   > until you know which credential it is holding.
 *
 * ⚠️ Nothing here ever prints a token, or a prefix of one, or its length. Length is a
 * disclosure: it narrows a guess, and a terminal ends up in a screenshot. Comparison
 * happens on values the caller already has, and what comes out is a description.
 */

/** Where a token was found. Order matters: the first one wins at runtime. */
export type TokenSource = 'environment' | 'file' | 'argument' | 'none';

export interface TokenInputs {
  /** `CLOUDFLARE_API_TOKEN` as the process really has it, or undefined. */
  readonly fromEnvironment?: string | undefined;
  /** What a `.env` file holds, or undefined. */
  readonly fromFile?: string | undefined;
  /** What the caller passed on the command line, or undefined. */
  readonly fromArgument?: string | undefined;
}

export interface TokenDecision {
  /** Which one will actually be used. */
  readonly source: TokenSource;
  /** The token to use, or undefined when there is none. Never printed. */
  readonly token: string | undefined;
  /**
   * Things the reader has to know, in the order they matter. Empty when there is
   * nothing surprising.
   */
  readonly warnings: readonly string[];
}

/**
 * Cloudflare's two token prefixes.
 *
 * `cfut_` is a user token, made at My Profile, and wrangler accepts it. `cfat_` is an
 * account-owned token, made on the account's API Tokens page, and the documentation
 * says those are not supported yet.
 *
 * ⚠️ We have not verified that ourselves. The experiment that was supposed to test it
 * was the one the environment variable ruined, so this is Cloudflare's claim rather
 * than a measurement, and the warning below says so rather than stating it as fact.
 */
const USER_TOKEN_PREFIX = 'cfut_';
const ACCOUNT_TOKEN_PREFIX = 'cfat_';

/**
 * Decide which token wins, and say what a reader would not guess.
 *
 * An argument beats the environment beats a file, which is the order every CLI uses.
 * The warnings are the point: the decision itself is unsurprising, and what cost a
 * day was not knowing that a decision had been made at all.
 */
export function decideToken(inputs: TokenInputs): TokenDecision {
  const warnings: string[] = [];

  const environment = normalize(inputs.fromEnvironment);
  const file = normalize(inputs.fromFile);
  const argument = normalize(inputs.fromArgument);

  // The warning this file was written for. Reported when the environment holds one
  // and something else holds a different one, whichever ends up winning, because the
  // surprise is that two exist rather than which was chosen.
  if (environment !== undefined && file !== undefined && environment !== file) {
    warnings.push(
      'CLOUDFLARE_API_TOKEN is set in this environment and it is not the token in your .env ' +
        'file. A real environment variable always wins, so the .env value is being ignored. ' +
        'This is silent, and it has cost this project a day: the symptoms point at ' +
        'permissions, and the permissions are usually fine.',
    );
    warnings.push(
      'Removing it from user scope is not enough on its own. A parent process that started ' +
        'earlier keeps its own copy and every child inherits it, so the terminal has to be ' +
        'restarted. To clear it for this session only: Remove-Item Env:CLOUDFLARE_API_TOKEN',
    );
  }

  if (argument !== undefined && environment !== undefined && argument !== environment) {
    warnings.push(
      'A token was passed on the command line and a different one is in this environment. ' +
        'The one you passed is being used.',
    );
  }

  const source: TokenSource =
    argument !== undefined
      ? 'argument'
      : environment !== undefined
        ? 'environment'
        : file !== undefined
          ? 'file'
          : 'none';

  const token = argument ?? environment ?? file;

  if (token === undefined) {
    warnings.push(
      'No API token was found. Make one at My Profile, API Tokens, then put it in .env as ' +
        'CLOUDFLARE_API_TOKEN.',
    );
    return { source: 'none', token: undefined, warnings };
  }

  if (token.startsWith(ACCOUNT_TOKEN_PREFIX)) {
    warnings.push(
      'That token starts with cfat_, which is an account-owned token from the account API ' +
        'Tokens page. Cloudflare documents those as not yet supported by wrangler, and says ' +
        'user tokens from My Profile are what to use. We have not verified this ourselves, so ' +
        'if it works, it works.',
    );
  } else if (!token.startsWith(USER_TOKEN_PREFIX)) {
    warnings.push(
      'That token does not start with cfut_ or cfat_, so it may not be a Cloudflare API ' +
        'token. If it is an older one without a prefix, carry on.',
    );
  }

  return { source, token, warnings };
}

function normalize(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * What to say when the API refuses a token, given how it refused.
 *
 * Both messages Cloudflare sends point away from the real cause, and one of them
 * points at it by name. `Authentication error [code: 10000]` arrives with "please
 * ensure it has the correct permissions", which sends the reader to the permissions
 * page, and the permissions are usually right. So the diagnosis a reader needs first
 * is which token is being held, not which boxes are ticked.
 */
export function explainRefusal(status: number, decision: TokenDecision): readonly string[] {
  const lines: string[] = [];

  if (status === 401 || status === 403) {
    lines.push(
      `The token was refused. It came from ${describeSource(decision.source)}, and that is ` +
        'the first thing to check: a token from somewhere you did not expect is the most ' +
        'common cause, and its error message mentions permissions instead.',
    );

    if (decision.source === 'environment') {
      lines.push(
        'Because it came from the environment rather than from .env, check that the variable ' +
          'holds what you think. To clear it for this session: ' +
          'Remove-Item Env:CLOUDFLARE_API_TOKEN',
      );
    }

    lines.push('If the token is right, it needs all of these permissions:');
  }

  return lines;
}

function describeSource(source: TokenSource): string {
  if (source === 'environment') return 'the CLOUDFLARE_API_TOKEN environment variable';
  if (source === 'file') return 'your .env file';
  if (source === 'argument') return 'the command line';
  return 'nowhere';
}
