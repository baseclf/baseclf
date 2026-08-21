/**
 * `baseclf secret set <KEY>`: one secret, onto one deployed Worker.
 *
 * Two decisions here are about disclosure rather than about ergonomics, and both
 * cost something in convenience.
 *
 * **The value never arrives in argv.** A command line is not private: every process
 * on the machine can read it through `ps`, the shell writes it into a history file
 * that survives the session, and CI keeps it in a log that outlives the job. So there
 * is no option that takes the value, and passing one anyway is refused with the
 * sentence that actually matters, which is to rotate it. The value comes from stdin
 * instead, which is a pipe when there is one and a prompt with the echo off when a
 * person is typing.
 *
 * **Nothing prints the value, a prefix of it, or its length.** `cli/token.ts` set
 * that precedent for tokens and gives the reason: a length narrows a guess, and a
 * terminal ends up in a screenshot. One thing is different here. Cloudflare's own
 * error messages are shown to the reader, and an API that echoes a rejected value
 * back would put it on the screen through a path nobody chose, so every message that
 * came from outside goes through `withoutValue` before it is written. Fixed prose
 * this file owns does not, because a string that was going to be printed regardless
 * discloses nothing by containing a short value by coincidence.
 *
 * A refusal is explained through `explainRefusal`, which names where the token came
 * from before it mentions permissions. Cloudflare's message does the opposite, and
 * the record of what that cost is in `rules/02` §C1.
 *
 * No `node:` imports. Reading stdin needs them, so that one function is handed in
 * from `cli/bin.ts` and everything that decides anything stays here, where the tests
 * can reach it.
 */

import {
  CloudflareError,
  type Credentials,
  type Fetcher,
  putSecret,
  REQUIRED_TOKEN_PERMISSIONS,
} from './cloudflare.js';
import { generateSecret } from './create.js';
import { copyable, nextAction, note, type Style, styledResultLine } from './output.js';
import { decideToken, explainRefusal, type TokenDecision } from './token.js';

type Write = (text: string) => void;

/**
 * What the command did.
 *
 * A name rather than a number, because the numbers live in `main.ts` and `main.ts`
 * imports this file. Returning the meaning and letting the caller map it keeps the
 * two modules pointing one way.
 */
export type SecretOutcome = 'ok' | 'usage' | 'failed';

/** What the runtime provides that this file cannot reach for itself. */
export interface Host {
  /** Environment variables as the process really has them. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The text of a `.env` in the working directory, when there is one to read. */
  readonly envFile?: string | undefined;
  /**
   * One value, from a pipe or from somebody typing.
   *
   * Never given the value in an argument. Whatever it returns is used and never
   * written anywhere but the request body. An interactive run calls it again to
   * confirm what was typed, because a typo in a value nobody can see fails later
   * with nothing pointing back here. A pipe is read once and believed.
   */
  readonly readSecret: () => Promise<string>;
  /** True when a person is at the keyboard, so a prompt is worth printing. */
  readonly interactive: boolean;
  /** Injected so a test never reaches the network. */
  readonly fetcher?: Fetcher | undefined;
  /**
   * The same account-and-token resolution `create` uses, for the machine whose
   * only credential is `wrangler login`. It writes its own refusals. Absent, the
   * environment is the only source, which is what scripts and the tests want.
   */
  readonly credentials?: () => Promise<{
    readonly credentials: Credentials;
    readonly warnings: readonly string[];
  } | null>;
  /** Put text on the machine's clipboard. Resolves true when it landed. */
  readonly copyToClipboard?: (text: string) => Promise<boolean>;
}

/** A host that can do nothing, so the command fails the way a real one would. */
export const NO_HOST: Host = Object.freeze({
  env: Object.freeze({}),
  interactive: false,
  readSecret: () => Promise.resolve(''),
});

export const SECRET_USAGE = [
  'baseclf secret set <KEY> --script <name>',
  '',
  'Sets one secret on a deployed Worker. The value is read from stdin: type it at',
  'the prompt, or pipe it in. No option takes the value, and that is deliberate.',
  '',
  'At the prompt, pressing Enter generates a strong value; a typed value is asked',
  'for twice and has to match. Either way the result is placed on your clipboard',
  'for the paste that comes next.',
  '',
  'Options:',
  '  --script <name>   The Worker to set it on. The "name" field in wrangler.jsonc',
  '  --account <id>    Cloudflare account id. Defaults to CLOUDFLARE_ACCOUNT_ID',
  '',
  'The API token comes from CLOUDFLARE_API_TOKEN, or from .env when the environment',
  'has none. A variable that is already set wins, and this says so when it happens.',
  'With neither set, the Cloudflare login on this machine is used, the same way',
  'create uses it.',
].join('\n');

/** Names a Worker accepts for a binding, which is what a secret becomes. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * How many times the type-and-confirm pair may disagree before this gives up.
 *
 * Bounded for the same reason `create` bounds its questions: attached to a pipe that
 * keeps answering, an unbounded loop asks forever.
 */
const CONFIRM_ATTEMPTS = 3;

/**
 * Options somebody would reach for to pass the value, so the refusal can name it.
 *
 * Listed rather than caught by the unknown-option path, because the two need
 * different words. An unrecognised option is a typo. One of these was an attempt to
 * put a secret in argv, and the reader needs to know to rotate it.
 */
const VALUE_BEARING = Object.freeze([
  '--value',
  '--text',
  '--secret',
  '--token',
  '--from',
  '--password',
]);

export interface SecretSetRequest {
  readonly key: string;
  readonly script: string;
  /** Left undefined when it has to come from the environment instead. */
  readonly account: string | undefined;
}

export type ParsedSecretSet =
  | { readonly ok: true; readonly request: SecretSetRequest }
  | { readonly ok: false; readonly lines: readonly string[] };

/**
 * What to say when a value reached the command line.
 *
 * The rotate sentence comes before the correct usage, because by the time this
 * prints, the damage is already done and the next command does not undo it.
 */
function valueOnCommandLine(): readonly string[] {
  return [
    'baseclf secret set does not take the value on the command line.',
    '',
    'A command line is not private. Every process on this machine can read it through',
    'ps, your shell writes it into a history file, and CI keeps it in a log that',
    'outlives the job. If what you passed was a real secret, rotate it before you do',
    'anything else.',
    '',
    'The value is read from stdin instead:',
    copyable('baseclf secret set BETTER_AUTH_SECRET --script baseclf'),
    'Paste it at the prompt, or pipe it in.',
  ];
}

function refuse(...lines: readonly string[]): ParsedSecretSet {
  return { ok: false, lines: [...lines, '', SECRET_USAGE] };
}

/**
 * Read the arguments of `secret set`, and refuse anything that looks like a value.
 *
 * Separate from the command so the refusals can be asserted without a host, a
 * fetcher, or a token. Every path out of here is a mistake the caller made, and the
 * command turns all of them into the same exit code: retrying the identical
 * invocation will not help.
 */
export function parseSecretSet(argv: readonly string[]): ParsedSecretSet {
  let key: string | undefined;
  let script: string | undefined;
  let account: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;

    if (argument.startsWith('--')) {
      const equals = argument.indexOf('=');
      const flag = equals === -1 ? argument : argument.slice(0, equals);
      const inline = equals === -1 ? undefined : argument.slice(equals + 1);

      if (VALUE_BEARING.includes(flag)) return { ok: false, lines: valueOnCommandLine() };

      if (flag !== '--script' && flag !== '--account') {
        return refuse(`baseclf secret set: there is no ${flag} option.`);
      }

      const value = inline ?? argv[index + 1];
      if (inline === undefined) index++;

      if (value === undefined || value.startsWith('--') || value.trim() === '') {
        return refuse(`baseclf secret set: ${flag} needs a value after it.`);
      }

      if (flag === '--script') script = value.trim();
      else account = value.trim();
      continue;
    }

    if (key === undefined) {
      key = argument;
      continue;
    }

    // A second bare argument. The likely thing somebody just typed is the value, and
    // guessing wrong costs them one clear paragraph, while guessing that it was
    // harmless costs them a leaked secret they never hear about.
    return { ok: false, lines: valueOnCommandLine() };
  }

  if (key === undefined) {
    return refuse('baseclf secret set needs the name of the secret to set.');
  }

  if (!KEY_PATTERN.test(key)) {
    return refuse(
      `baseclf secret set: "${key}" is not a name a Worker can bind. Use letters, digits`,
      'and underscores, starting with a letter or an underscore.',
    );
  }

  if (script === undefined) {
    return refuse(
      'baseclf secret set needs to know which Worker to set it on, and there is no',
      'default worth guessing: a wrong guess puts your secret on a deployment that is',
      'not yours to configure.',
    );
  }

  return { ok: true, request: { key, script, account } };
}

/**
 * The values in a `.env`, enough of it to find two names.
 *
 * Deliberately small. This is not a dotenv implementation and it does not want to be
 * one: it reads `NAME=value`, strips one layer of matching quotes, drops a comment
 * after an unquoted value, and ignores everything it does not understand. It exists
 * so `decideToken` has a file to compare the environment against, which is the whole
 * point of that file and has been dormant for want of a caller.
 *
 * Multi-line values are not supported and are not silently half-read: a line with no
 * `=` is skipped, so the continuation of a quoted value simply does not become a
 * variable.
 */
export function parseEnvFile(text: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const equals = line.indexOf('=');
    if (equals <= 0) continue;

    const name = line
      .slice(0, equals)
      .trim()
      .replace(/^export\s+/, '');
    if (!KEY_PATTERN.test(name)) continue;

    const rest = line.slice(equals + 1).trim();
    const quote = rest.startsWith('"') ? '"' : rest.startsWith("'") ? "'" : undefined;

    if (quote !== undefined && rest.length >= 2 && rest.endsWith(quote)) {
      values[name] = rest.slice(1, -1);
      continue;
    }

    // An unquoted value ends at a comment, which is what every dotenv reader does. A
    // token followed by a note about the token is otherwise sent to Cloudflare with
    // the note attached, and the refusal that comes back explains nothing.
    const comment = rest.indexOf(' #');
    values[name] = (comment === -1 ? rest : rest.slice(0, comment)).trim();
  }

  return values;
}

/**
 * The same text with the value taken out of it.
 *
 * A fixed marker rather than a run of stars, because a marker whose width follows the
 * value hands back the length, and the length is the thing `cli/token.ts` refuses to
 * print for the same reason.
 */
export function withoutValue(text: string, value: string): string {
  if (value === '') return text;
  return text.split(value).join('[value hidden]');
}

/**
 * Codes Cloudflare sends for a credential problem, from this project's own record.
 *
 * `rules/02` §C1: `whoami` answered `Invalid access token [code: 9109]` and `d1 list`
 * answered `Authentication error [code: 10000]`. Both arrived on responses whose HTTP
 * status said nothing useful, which is why the status alone is not the test.
 */
const CREDENTIAL_CODES: readonly number[] = Object.freeze([9109, 10000]);

/**
 * Which status to explain a refusal as.
 *
 * Some authentication failures arrive as 200 with `success: false`, so reading the
 * HTTP status alone would decide that nothing was wrong with the credential and
 * `explainRefusal` would stay quiet at the one moment its advice is worth the most.
 */
export function credentialStatus(cause: unknown): number {
  if (!(cause instanceof CloudflareError)) return 0;
  if (cause.status === 401 || cause.status === 403) return cause.status;
  return cause.codes.some((code) => CREDENTIAL_CODES.includes(code)) ? 403 : cause.status;
}

function describeFailure(
  cause: unknown,
  decision: TokenDecision,
  value: string,
  style: Style,
): readonly string[] {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const lines: string[] = [
    styledResultLine('deny', `The secret was not set: ${withoutValue(raw, value)}`, style),
  ];

  const status = credentialStatus(cause);
  for (const explanation of explainRefusal(status, decision)) lines.push(note(explanation));

  if (status === 401 || status === 403) {
    for (const permission of REQUIRED_TOKEN_PERMISSIONS) lines.push(note(`  ${permission}`));
  }

  return lines;
}

/**
 * Set one secret, and report what a reader has to know.
 *
 * The credential is resolved before the value is read, so nobody types a secret only
 * to be told afterwards that there was no token to send it with.
 */
export async function runSecretSet(
  argv: readonly string[],
  write: Write,
  style: Style,
  host: Host,
): Promise<SecretOutcome> {
  const parsed = parseSecretSet(argv);
  if (!parsed.ok) {
    write(parsed.lines.join('\n'));
    return 'usage';
  }

  const { key, script } = parsed.request;
  const fromFile = parseEnvFile(host.envFile ?? '');

  const explicitAccount = (
    parsed.request.account ??
    host.env.CLOUDFLARE_ACCOUNT_ID ??
    fromFile.CLOUDFLARE_ACCOUNT_ID ??
    ''
  ).trim();

  const decision = decideToken({
    fromEnvironment: host.env.CLOUDFLARE_API_TOKEN,
    fromFile: fromFile.CLOUDFLARE_API_TOKEN,
  });

  // Which credential and account this run uses, in one place. An explicit account
  // plus a token from the environment is the scripted path and stays exactly as it
  // was. Anything missing falls through to the same resolution `create` uses, so the
  // machine whose only credential is `wrangler login` is not turned away here, one
  // step from the end of onboarding.
  let credentials: Credentials;

  if (explicitAccount !== '' && decision.token !== undefined) {
    // Printed before anything is attempted. A token warning read after a refusal is
    // a warning that arrives once the reader has started looking somewhere else.
    for (const warning of decision.warnings) {
      write(styledResultLine('attention', warning, style));
    }
    credentials = { accountId: explicitAccount, token: decision.token };
  } else if (host.credentials !== undefined) {
    const resolved = await host.credentials();
    if (resolved === null) return 'failed';
    for (const warning of resolved.warnings) {
      write(styledResultLine('attention', warning, style));
    }
    credentials = {
      accountId: explicitAccount !== '' ? explicitAccount : resolved.credentials.accountId,
      token: resolved.credentials.token,
    };
  } else {
    for (const warning of decision.warnings) {
      write(styledResultLine('attention', warning, style));
    }

    if (explicitAccount === '') {
      write(
        [
          'baseclf secret set needs the account the Worker lives in.',
          '',
          'Pass --account, or set CLOUDFLARE_ACCOUNT_ID. It is on the right of any page',
          'in the Cloudflare dashboard, and `wrangler whoami` prints it.',
        ].join('\n'),
      );
      return 'usage';
    }

    if (decision.token === undefined) return 'usage';
    credentials = { accountId: explicitAccount, token: decision.token };
  }

  // Trimmed, and the reason is not tidiness. A pipe adds a newline, a paste often
  // carries a trailing space, and a secret with invisible whitespace on the end is
  // accepted by Cloudflare, stored, and then fails every signature check with nothing
  // in any log that mentions whitespace.
  let value = '';
  let generated = false;

  if (host.interactive) {
    write(`Press Enter to generate a strong value for ${key}, or type your own.`);
    write(note('Nothing you type is echoed, written to disk, or printed back.'));
    write(note('A typed value is asked for twice; a generated one cannot be mistyped.'));
    if (key === 'MCP_TOKEN') {
      write(note('This value is the admin token. The Studio asks for it, and anyone'));
      write(note('holding it can do everything the engine allows.'));
    }

    for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt++) {
      const first = (await host.readSecret()).trim();

      // The empty answer is the recommended one: a machine-made value, never
      // seen, never typed, so there is nothing to confirm. The project already
      // records why this is the default worth having: a person prompted for a
      // secret types something memorable, and a memorable admin token is the
      // whole problem.
      if (first === '') {
        value = generateSecret();
        generated = true;
        write(styledResultLine('allow', 'Generated a strong value.', style));
        break;
      }

      write('Type it again to confirm.');
      const second = (await host.readSecret()).trim();

      if (first === second) {
        value = first;
        break;
      }

      write(
        styledResultLine(
          'attention',
          attempt < CONFIRM_ATTEMPTS
            ? 'The two entries differ. Nothing was sent. Start over.'
            : `The two entries differ. Nothing was sent, and ${key} was not changed.`,
          style,
        ),
      );
      if (attempt === CONFIRM_ATTEMPTS) return 'usage';
    }
  } else {
    value = (await host.readSecret()).trim();
  }

  if (value === '') {
    write(
      [
        `baseclf secret set: nothing was read, so ${key} was not changed.`,
        '',
        'Pipe the value in, or run this in a terminal and type it at the prompt.',
      ].join('\n'),
    );
    return 'usage';
  }

  try {
    await putSecret(host.fetcher ?? fetch, credentials, script, key, value);
  } catch (cause) {
    for (const line of describeFailure(cause, decision, value, style)) write(line);
    return 'failed';
  }

  write(styledResultLine('allow', `${key} is set on the Worker "${script}".`, style));

  // The clipboard, so the value does not have to be typed a third time into
  // whatever asked for it. Only for a person at a keyboard: a script piping a
  // value in did not ask to have its clipboard replaced.
  if (host.interactive) {
    const copied = host.copyToClipboard !== undefined && (await host.copyToClipboard(value));

    if (copied) {
      write(
        note(
          key === 'MCP_TOKEN'
            ? 'The value is in your clipboard: paste it into the Admin token field on the'
            : 'The value is in your clipboard, ready to paste where it is needed.',
        ),
      );
      if (key === 'MCP_TOKEN') write(note('Studio connect screen.'));
    } else if (generated) {
      // The one place the value is ever printed, and it is not optional: a
      // generated value that reaches neither the clipboard nor the person is a
      // credential nobody holds, on a deployment that now requires it. Said
      // once, marked, so it can be copied and the terminal closed.
      write(note('The clipboard was not reachable here, and this value exists nowhere'));
      write(note('else, so it is printed this once. Copy it, then clear your terminal:'));
      write('');
      write(copyable(value));
      write('');
    } else if (host.copyToClipboard !== undefined) {
      write(note('The clipboard was not reachable here. Use the value you just typed.'));
    }
  }

  write(note('Cloudflare does not hand a secret back, so this reports that the request was'));
  write(note('accepted rather than that the value is the one you meant.'));
  write(
    nextAction({
      goal: 'confirm the deployment is running with it',
      steps: [
        'Give it a few seconds. A check run immediately can still report the state before this.',
        'Ask the deployment, using the URL it is served from.',
      ],
      verify: 'baseclf doctor <url>',
    }),
  );

  return 'ok';
}

/**
 * Fixed strings this command can print, for the voice rules to run over.
 *
 * Listed here and pulled into `main.ts` so that adding a block of text means adding
 * it to one place and the check keeps covering everything. A checker that only covers
 * what somebody remembered to list is a checker that drifts.
 */
export const SECRET_FIXED_TEXT: readonly string[] = Object.freeze([
  SECRET_USAGE,
  valueOnCommandLine().join('\n'),
]);
