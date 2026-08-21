/**
 * Setting a secret, and everything that must not happen while it is set.
 *
 * Most of this file is about disclosure rather than about behaviour, because the
 * behaviour is one PUT and the disclosure is where the damage would be. Three
 * properties are asserted on every path rather than on the paths where they seemed
 * likely:
 *
 *   1. **The value never reaches the output.** Not on success, not in a refusal, not
 *      when Cloudflare echoes it back in an error message, and not as a length. The
 *      reasoning is the one `cli/token.ts` records: a length narrows a guess, and a
 *      terminal ends up in a screenshot.
 *   2. **The value never reaches a URL.** A body can be forgotten. A URL is written
 *      into logs at both ends and into every proxy in between.
 *   3. **A value on the command line is refused rather than used.** By the time the
 *      command runs it is already in `ps` and in a history file, so the only useful
 *      thing left to say is to rotate it, and the test checks that it is said.
 *
 * ⚠️ Every value below is obviously fake and short. A convincing fake in a public
 * repository trips secret scanners and teaches readers nothing, and this project's
 * own commit guard has blocked that mistake once already.
 */

import { describe, expect, it } from 'vitest';

import type { Fetcher } from './cloudflare.js';
import { findVoiceViolations, PLAIN } from './output.js';
import {
  credentialStatus,
  type Host,
  parseEnvFile,
  parseSecretSet,
  runSecretSet,
  type SecretOutcome,
  withoutValue,
} from './secret.js';

/** A value the code has no reason to say on its own, so its absence means something. */
const VALUE = 'canary-value-never-printed';
const TOKEN = 'cfut_EXAMPLE_ENVVAR';
const FILE_TOKEN = 'cfut_EXAMPLE_FILE';
const ACCOUNT = 'acct_7f3c91';

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly authorization: string;
}

interface Api {
  readonly fetcher: Fetcher;
  readonly sent: Recorded[];
}

function ok(result: unknown = {}): Response {
  return new Response(JSON.stringify({ success: true, result }), { status: 200 });
}

/** A refusal shaped the way Cloudflare sends one: sometimes 200, always `success`. */
function refuse(code: number, message: string, status = 200): Response {
  return new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), { status });
}

function api(answer: (recorded: Recorded) => Response = () => ok()): Api {
  const sent: Recorded[] = [];

  const fetcher: Fetcher = (url, init) => {
    const recorded: Recorded = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
      authorization: new Headers(init?.headers).get('authorization') ?? '',
    };
    sent.push(recorded);
    return Promise.resolve(answer(recorded));
  };

  return { fetcher, sent };
}

interface RunResult {
  readonly outcome: SecretOutcome;
  readonly out: string;
  readonly sent: readonly Recorded[];
  readonly reads: number;
  readonly copied: readonly string[];
}

async function run(
  argv: readonly string[],
  options: {
    readonly value?: string;
    /** Per-call answers for `readSecret`, for the type-and-confirm paths. */
    readonly values?: readonly string[];
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly envFile?: string;
    readonly interactive?: boolean;
    readonly answer?: (recorded: Recorded) => Response;
    /** The create-grade resolution, injected. Null means it refused. */
    readonly credentials?: { accountId: string; token: string } | null;
    readonly clipboardWorks?: boolean;
  } = {},
): Promise<RunResult> {
  const written: string[] = [];
  const { fetcher, sent } = api(options.answer);
  let reads = 0;
  const copied: string[] = [];

  const host: Host = {
    env: options.env ?? { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    envFile: options.envFile,
    interactive: options.interactive ?? false,
    readSecret: () => {
      const answer = options.values?.[reads] ?? options.value ?? VALUE;
      reads++;
      return Promise.resolve(answer);
    },
    fetcher,
    ...(() => {
      const injected = options.credentials;
      if (injected === undefined) return {};
      return {
        credentials: () =>
          Promise.resolve(injected === null ? null : { credentials: injected, warnings: [] }),
      };
    })(),
    ...(options.clipboardWorks !== undefined
      ? {
          copyToClipboard: (text: string) => {
            copied.push(text);
            return Promise.resolve(options.clipboardWorks === true);
          },
        }
      : {}),
  };

  const outcome = await runSecretSet(argv, (text) => written.push(text), PLAIN, host);
  return { outcome, out: written.join('\n'), sent, reads, copied };
}

describe('⭐ a value on the command line', () => {
  it('is refused rather than used, and says to rotate it', async () => {
    // By the time this prints, the value is already in ps and in a history file. The
    // only useful thing left is the rotate sentence, so it has to be there.
    const { outcome, out, sent } = await run(['BETTER_AUTH_SECRET', 'a-pasted-value']);

    expect(outcome).toBe('usage');
    expect(out).toContain('does not take the value on the command line');
    expect(out).toContain('rotate it');
    expect(sent).toEqual([]);
  });

  it('says why a command line is not private, rather than only that it is refused', async () => {
    const { out } = await run(['KEY', 'a-pasted-value']);

    expect(out).toContain('ps');
    expect(out).toContain('history');
  });

  it('refuses every option somebody would reach for to pass it', async () => {
    for (const attempt of [
      ['KEY', '--value', 'x'],
      ['KEY', '--value=x'],
      ['KEY', '--text', 'x'],
      ['KEY', '--secret', 'x'],
      ['KEY', '--token', 'x'],
      ['KEY', '--password=x'],
    ]) {
      const { outcome, out, sent } = await run(attempt);

      expect(outcome, attempt.join(' ')).toBe('usage');
      expect(out, attempt.join(' ')).toContain('rotate it');
      expect(sent).toEqual([]);
    }
  });

  it('does not echo back what was passed, which would put it on screen twice', async () => {
    const { out } = await run(['KEY', VALUE]);

    expect(out).not.toContain(VALUE);
  });
});

describe('reading the arguments', () => {
  it('takes the script as a separate argument or after an equals sign', () => {
    for (const argv of [
      ['KEY', '--script', 'baseclf'],
      ['KEY', '--script=baseclf'],
    ]) {
      const parsed = parseSecretSet(argv);

      expect(parsed.ok, argv.join(' ')).toBe(true);
      if (parsed.ok) expect(parsed.request.script).toBe('baseclf');
    }
  });

  it('needs a script, because a wrong guess writes to a deployment you did not mean', () => {
    const parsed = parseSecretSet(['BETTER_AUTH_SECRET']);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.lines.join('\n')).toContain('which Worker');
  });

  it('needs the name of the secret', () => {
    const parsed = parseSecretSet(['--script', 'baseclf']);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.lines.join('\n')).toContain('needs the name');
  });

  it('refuses a name a Worker could not bind', () => {
    for (const key of ['9LIVES', 'has-a-dash', 'has space', '']) {
      expect(parseSecretSet([key, '--script', 'baseclf']).ok, key).toBe(false);
    }
  });

  it('accepts the names a Worker can bind', () => {
    for (const key of ['BETTER_AUTH_SECRET', '_private', 'a1']) {
      expect(parseSecretSet([key, '--script', 'baseclf']).ok, key).toBe(true);
    }
  });

  it('names the option it does not have, rather than only printing usage', () => {
    const parsed = parseSecretSet(['KEY', '--script', 'baseclf', '--force']);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.lines.join('\n')).toContain('there is no --force option');
  });

  it('does not read the next option as the value of the one before it', () => {
    // `--script --account x` would otherwise set the script to "--account" and then
    // provision against a Worker with a name nobody typed.
    const parsed = parseSecretSet(['KEY', '--script', '--account', 'acct']);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.lines.join('\n')).toContain('--script needs a value');
  });
});

describe('⭐ what is sent', () => {
  it('puts the value in the body and never in the URL', async () => {
    const { sent } = await run(['BETTER_AUTH_SECRET', '--script', 'baseclf']);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).not.toContain(VALUE);
    expect(sent[0]?.body).toContain(VALUE);
  });

  it('sends it to the secrets endpoint of the named script', async () => {
    const { sent } = await run(['BETTER_AUTH_SECRET', '--script', 'baseclf']);

    expect(sent[0]?.method).toBe('PUT');
    expect(sent[0]?.url).toContain(`/accounts/${ACCOUNT}/workers/scripts/baseclf/secrets`);
  });

  it('declares the binding type Cloudflare hides the value under', async () => {
    // `plain_text` would store the same string and then hand it back as a variable.
    const { sent } = await run(['BETTER_AUTH_SECRET', '--script', 'baseclf']);

    expect(JSON.parse(sent[0]?.body ?? '{}')).toEqual({
      name: 'BETTER_AUTH_SECRET',
      text: VALUE,
      type: 'secret_text',
    });
  });

  it('carries the token as a bearer credential', async () => {
    const { sent } = await run(['KEY', '--script', 'baseclf']);

    expect(sent[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('escapes a script name rather than pasting it into the path', async () => {
    const { sent } = await run(['KEY', '--script', 'a b/c']);

    expect(sent[0]?.url).toContain('/workers/scripts/a%20b%2Fc/secrets');
  });
});

describe('⚠️ what is never printed', () => {
  it('keeps the value out of a successful run', async () => {
    const { outcome, out } = await run(['BETTER_AUTH_SECRET', '--script', 'baseclf']);

    expect(outcome).toBe('ok');
    expect(out).not.toContain(VALUE);
    expect(out).toContain('BETTER_AUTH_SECRET is set');
  });

  it('keeps it out of an error message Cloudflare echoed it into', async () => {
    // The path nobody chooses. An API that quotes a rejected value back would put it
    // on screen through this code without this code ever deciding to print it.
    const { outcome, out } = await run(['KEY', '--script', 'baseclf'], {
      answer: () => refuse(10021, `the value "${VALUE}" is not acceptable`),
    });

    expect(outcome).toBe('failed');
    expect(out).not.toContain(VALUE);
    expect(out).toContain('[value hidden]');
  });

  it('keeps it out of a body that was not JSON at all', async () => {
    // An HTML error page from a proxy, with the request quoted in it.
    const { out } = await run(['KEY', '--script', 'baseclf'], {
      answer: () => new Response(`<html>rejected ${VALUE}</html>`, { status: 502 }),
    });

    expect(out).not.toContain(VALUE);
  });

  it('prints no length, and no fragment of the value', async () => {
    const outputs = await Promise.all([
      run(['BETTER_AUTH_SECRET', '--script', 'baseclf']),
      run(['KEY', '--script', 'baseclf'], { answer: () => refuse(10000, 'Authentication error') }),
      run(['KEY', '--script', 'baseclf'], { interactive: true }),
    ]);

    for (const { out } of outputs) {
      expect(out).not.toContain(VALUE);
      expect(out).not.toContain(VALUE.slice(0, 8));
      expect(out).not.toMatch(/\b\d{2,} characters\b/);
    }
  });

  it('keeps the token out of everything too', async () => {
    const { out } = await run(['KEY', '--script', 'baseclf'], {
      answer: () => refuse(10000, 'Authentication error', 403),
    });

    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(TOKEN.slice(5));
  });
});

describe('reading the value', () => {
  it('trims what a pipe adds, because a trailing newline fails every check silently', async () => {
    const { sent } = await run(['KEY', '--script', 'baseclf'], { value: `${VALUE}\n` });

    expect(JSON.parse(sent[0]?.body ?? '{}').text).toBe(VALUE);
  });

  it('sends nothing when nothing was read', async () => {
    const { outcome, out, sent } = await run(['KEY', '--script', 'baseclf'], { value: '   ' });

    expect(outcome).toBe('usage');
    expect(sent).toEqual([]);
    expect(out).toContain('was not changed');
  });

  it('prompts when a person is typing, and stays quiet when it is a pipe', async () => {
    const typed = await run(['BETTER_AUTH_SECRET', '--script', 'baseclf'], { interactive: true });
    const piped = await run(['BETTER_AUTH_SECRET', '--script', 'baseclf']);

    expect(typed.out).toContain('Type the value for BETTER_AUTH_SECRET');
    expect(piped.out).not.toContain('Type the value');
  });

  it('⭐ does not ask for a value it has nowhere to send', async () => {
    // Somebody typing a secret and then being told there was no token has already
    // put it in their scrollback for nothing.
    const { outcome, reads } = await run(['KEY', '--script', 'baseclf'], { env: {} });

    expect(outcome).toBe('usage');
    expect(reads).toBe(0);
  });

  it('reads once from a pipe, which scripts depend on', async () => {
    const { reads } = await run(['KEY', '--script', 'baseclf']);

    expect(reads).toBe(1);
  });
});

describe('⭐ typing the value twice', () => {
  it('asks for a confirmation, and sends only when the two entries match', async () => {
    const { outcome, out, sent, reads } = await run(['KEY', '--script', 'baseclf'], {
      interactive: true,
      values: [VALUE, VALUE],
    });

    expect(outcome).toBe('ok');
    expect(out).toContain('Type it again to confirm');
    expect(reads).toBe(2);
    expect(JSON.parse(sent[0]?.body ?? '{}').text).toBe(VALUE);
  });

  it('says to pick something memorable before the first prompt', async () => {
    const { out } = await run(['KEY', '--script', 'baseclf'], {
      interactive: true,
      values: [VALUE, VALUE],
    });

    expect(out).toContain('Pick something you will remember');
  });

  it('tells the MCP_TOKEN reader what this value is, since the Studio asks for it', async () => {
    const { out } = await run(['MCP_TOKEN', '--script', 'baseclf'], {
      interactive: true,
      values: [VALUE, VALUE],
    });

    expect(out).toContain('admin token');
  });

  it('sends nothing on a mismatch, says so, and lets the person start over', async () => {
    const { outcome, out, sent } = await run(['KEY', '--script', 'baseclf'], {
      interactive: true,
      values: ['first-try', 'first-typo', VALUE, VALUE],
    });

    expect(outcome).toBe('ok');
    expect(out).toContain('The two entries differ');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? '{}').text).toBe(VALUE);
  });

  it('gives up after three mismatched rounds without sending anything', async () => {
    const { outcome, sent } = await run(['KEY', '--script', 'baseclf'], {
      interactive: true,
      values: ['a', 'b', 'c', 'd', 'e', 'f'],
    });

    expect(outcome).toBe('usage');
    expect(sent).toEqual([]);
  });

  it('never confirms a pipe, whose second read has nothing to answer', async () => {
    const { out, reads } = await run(['KEY', '--script', 'baseclf'], { value: VALUE });

    expect(reads).toBe(1);
    expect(out).not.toContain('Type it again');
  });

  it('keeps the mismatched entries out of the output too', async () => {
    const { out } = await run(['KEY', '--script', 'baseclf'], {
      interactive: true,
      values: ['secret-attempt-one', 'secret-attempt-two', VALUE, VALUE],
    });

    expect(out).not.toContain('secret-attempt-one');
    expect(out).not.toContain('secret-attempt-two');
  });
});

describe('⭐ the clipboard', () => {
  it('receives the confirmed value, and the output says to paste it', async () => {
    const { out, copied } = await run(['MCP_TOKEN', '--script', 'baseclf'], {
      interactive: true,
      values: [VALUE, VALUE],
      clipboardWorks: true,
    });

    expect(copied).toEqual([VALUE]);
    expect(out).toContain('in your clipboard');
    expect(out).toContain('Admin token field');
    expect(out).not.toContain(VALUE);
  });

  it('says when the clipboard was not reachable, without printing the value', async () => {
    const { out } = await run(['MCP_TOKEN', '--script', 'baseclf'], {
      interactive: true,
      values: [VALUE, VALUE],
      clipboardWorks: false,
    });

    expect(out).toContain('clipboard was not reachable');
    expect(out).not.toContain(VALUE);
  });

  it('is left alone by a pipe, whose caller did not ask to lose what they had on it', async () => {
    const { copied, outcome } = await run(['MCP_TOKEN', '--script', 'baseclf'], {
      value: VALUE,
      clipboardWorks: true,
    });

    expect(outcome).toBe('ok');
    expect(copied).toEqual([]);
  });
});

describe('⭐ the machine whose only credential is the wrangler login', () => {
  it('falls through to the create-grade resolution instead of refusing', async () => {
    const { outcome, sent } = await run(['KEY', '--script', 'baseclf'], {
      env: {},
      credentials: { accountId: 'acct_oauth', token: 'oauth-token-under-test' },
    });

    expect(outcome).toBe('ok');
    expect(sent[0]?.url).toContain('/accounts/acct_oauth/');
    expect(sent[0]?.authorization).toBe('Bearer oauth-token-under-test');
  });

  it('lets an explicit --account override the resolved one', async () => {
    const { sent } = await run(['KEY', '--script', 'baseclf', '--account', 'acct_mine'], {
      env: {},
      credentials: { accountId: 'acct_oauth', token: 'oauth-token-under-test' },
    });

    expect(sent[0]?.url).toContain('/accounts/acct_mine/');
  });

  it('stops without reading a value when the resolution refused', async () => {
    const { outcome, reads, sent } = await run(['KEY', '--script', 'baseclf'], {
      env: {},
      credentials: null,
    });

    expect(outcome).toBe('failed');
    expect(reads).toBe(0);
    expect(sent).toEqual([]);
  });

  it('still prefers the environment token when both are present', async () => {
    const { sent } = await run(['KEY', '--script', 'baseclf'], {
      credentials: { accountId: 'acct_oauth', token: 'oauth-token-under-test' },
    });

    expect(sent[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent[0]?.url).toContain(`/accounts/${ACCOUNT}/`);
  });
});

describe('which credentials it uses', () => {
  it('takes the account from the environment when no option gives one', async () => {
    const { sent } = await run(['KEY', '--script', 'baseclf']);

    expect(sent[0]?.url).toContain(`/accounts/${ACCOUNT}/`);
  });

  it('prefers the option over the environment', async () => {
    const { sent } = await run(['KEY', '--script', 'baseclf', '--account', 'acct_other']);

    expect(sent[0]?.url).toContain('/accounts/acct_other/');
  });

  it('says where to find the account id rather than only that it is missing', async () => {
    const { outcome, out } = await run(['KEY', '--script', 'baseclf'], {
      env: { CLOUDFLARE_API_TOKEN: TOKEN },
    });

    expect(outcome).toBe('usage');
    expect(out).toContain('wrangler whoami');
  });

  it('reads both names out of a .env when the environment has neither', async () => {
    const { sent } = await run(['KEY', '--script', 'baseclf'], {
      env: {},
      envFile: `CLOUDFLARE_API_TOKEN=${FILE_TOKEN}\nCLOUDFLARE_ACCOUNT_ID=acct_from_file\n`,
    });

    expect(sent[0]?.url).toContain('/accounts/acct_from_file/');
    expect(sent[0]?.authorization).toBe(`Bearer ${FILE_TOKEN}`);
  });

  it('⭐ warns when the environment holds a different token from the .env', async () => {
    // The day this project lost. A real environment variable always beats the file,
    // and nothing anywhere says so, which is why the command has to.
    const { out } = await run(['KEY', '--script', 'baseclf'], {
      env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
      envFile: `CLOUDFLARE_API_TOKEN=${FILE_TOKEN}`,
    });

    expect(out).toContain('always wins');
    expect(out).toContain('parent process');
  });

  it('says where to make a token when there is none', async () => {
    const { outcome, out } = await run(['KEY', '--script', 'baseclf'], {
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    });

    expect(outcome).toBe('usage');
    expect(out).toContain('My Profile');
  });
});

describe('⭐ explaining a refusal', () => {
  it('names where the token came from before it mentions permissions', async () => {
    // Cloudflare's own message says to check the permissions, and the permissions are
    // usually fine. Which credential is being held is the thing to check first.
    const { out } = await run(['KEY', '--script', 'baseclf'], {
      answer: () => refuse(10000, 'Authentication error', 403),
    });

    const source = out.indexOf('environment variable');
    const permissions = out.indexOf('Workers Scripts');

    expect(source).toBeGreaterThan(-1);
    expect(permissions).toBeGreaterThan(source);
  });

  it('lists the permissions, including the D1 one Cloudflare template leaves out', async () => {
    const { out } = await run(['KEY', '--script', 'baseclf'], {
      answer: () => refuse(9109, 'Invalid access token', 401),
    });

    expect(out).toContain('D1');
  });

  it('⭐ explains a refusal that arrived as 200 with success false', async () => {
    // Cloudflare sends some authentication failures this way. Reading the HTTP status
    // alone would decide nothing was wrong with the credential and stay silent at the
    // one moment the advice is worth the most.
    const { outcome, out } = await run(['KEY', '--script', 'baseclf'], {
      answer: () => refuse(10000, 'Authentication error'),
    });

    expect(outcome).toBe('failed');
    expect(out).toContain('first thing to check');
  });

  it('says nothing about credentials for a failure that is not about them', async () => {
    // Sending somebody to the permissions page for a 500 is the second wrong turn in
    // a row, and the first one was Cloudflare's.
    const { out } = await run(['KEY', '--script', 'baseclf'], {
      answer: () => refuse(7003, 'Could not route', 500),
    });

    expect(out).not.toContain('first thing to check');
    expect(out).toContain('The secret was not set');
  });

  it('maps only the codes this project has actually seen', () => {
    // From rules/02 §C1: 9109 from whoami, 10000 from d1 list. Widening this list on
    // a guess would explain a quota error as a credential problem.
    expect(credentialStatus(new Error('not a Cloudflare failure'))).toBe(0);
  });
});

describe('reading a .env', () => {
  it('takes a plain assignment', () => {
    expect(parseEnvFile('A=1\nB=two\n')).toEqual({ A: '1', B: 'two' });
  });

  it('ignores blanks, comments and anything with no equals sign', () => {
    expect(parseEnvFile('\n# a note\nnot an assignment\nA=1')).toEqual({ A: '1' });
  });

  it('strips one layer of matching quotes', () => {
    expect(parseEnvFile(`A="one"\nB='two'\nC="mis'matched"`)).toEqual({
      A: 'one',
      B: 'two',
      C: "mis'matched",
    });
  });

  it('drops a comment after an unquoted value, and keeps one inside quotes', () => {
    // A token with a note beside it is otherwise sent with the note attached, and the
    // refusal that comes back explains nothing.
    expect(parseEnvFile('A=value # a note\nB="value # kept"')).toEqual({
      A: 'value',
      B: 'value # kept',
    });
  });

  it('handles the export prefix people copy out of shell instructions', () => {
    expect(parseEnvFile('export A=1')).toEqual({ A: '1' });
  });

  it('is not confused by an equals sign inside the value', () => {
    expect(parseEnvFile('A=a=b=c')).toEqual({ A: 'a=b=c' });
  });
});

describe('redaction', () => {
  it('replaces every occurrence with a marker of fixed width', () => {
    // Stars whose count follows the value hand back the length, which is the thing
    // this project refuses to print for tokens for exactly the same reason.
    expect(withoutValue(`${VALUE} and ${VALUE}`, VALUE)).toBe('[value hidden] and [value hidden]');
  });

  it('leaves text alone when there is no value to hide', () => {
    expect(withoutValue('nothing to do', '')).toBe('nothing to do');
  });
});

describe('what a reader sees', () => {
  it('obeys every voice rule on every path', async () => {
    const outputs = await Promise.all([
      run(['BETTER_AUTH_SECRET', '--script', 'baseclf']),
      run(['BETTER_AUTH_SECRET', '--script', 'baseclf'], { interactive: true }),
      run(['KEY', 'a-value-on-argv']),
      run(['KEY']),
      run(['KEY', '--script', 'baseclf', '--force']),
      run(['KEY', '--script', 'baseclf'], { value: '' }),
      run(['KEY', '--script', 'baseclf'], { env: {} }),
      run(['KEY', '--script', 'baseclf'], { env: { CLOUDFLARE_API_TOKEN: TOKEN } }),
      run(['KEY', '--script', 'baseclf'], { answer: () => refuse(10000, 'Authentication error') }),
      run(['KEY', '--script', 'baseclf'], { answer: () => refuse(7003, 'Could not route', 500) }),
    ]);

    for (const { out } of outputs) {
      expect(findVoiceViolations(out), out).toEqual([]);
    }
  });

  it('ends with the next thing to do rather than with a mark', async () => {
    // A success line and nothing else leaves the reader to work out whether the
    // deployment picked it up, and the answer is not immediately.
    const { out } = await run(['BETTER_AUTH_SECRET', '--script', 'baseclf']);

    expect(out).toContain('Next:');
    expect(out).toContain('baseclf doctor');
  });

  it('says what a success mark does not mean', async () => {
    // Cloudflare does not hand a secret back, so nothing here can check the value.
    const { out } = await run(['BETTER_AUTH_SECRET', '--script', 'baseclf']);

    expect(out).toContain('does not hand a secret back');
  });
});
