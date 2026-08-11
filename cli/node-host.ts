/**
 * Everything the CLI needs from Node, in one place for both entry points.
 *
 * Two binaries are published, `create-baseclf` and `baseclf`, and they need the
 * identical runtime. Building it in each would be two copies of a set of decisions
 * about echo, colour and where files live, and two copies of one judgment is the shape
 * that produced debts 31 and 35 in this project. So the entry points are a few lines
 * each and everything they hand to `main` is here.
 *
 * Nothing here decides anything a reader would argue about. Reading a value is here;
 * what to do with the value is not. That is why this file has no test and every module
 * it feeds has one.
 *
 * Colour is off unless stdout is a terminal, and off regardless if `NO_COLOR` is set,
 * which is the convention every well-behaved CLI follows. Without that check a piped
 * or redirected run fills a file with escape codes, and that is why the marks in
 * `output.ts` are not optional: with colour off they are the only signal left.
 *
 * ⚠️ Four things here handle a credential, and all four are here because they need
 * `node:` and for no other reason:
 *
 *   1. Reading a typed line with the echo off, so a pasted value does not stay in the
 *      scrollback of a terminal that ends up in a screenshot.
 *   2. Reading stdin to the end when it is a pipe, so `... | baseclf secret set` works
 *      without a prompt nobody is there to answer.
 *   3. Reading `.env`, so the token decision has a file to compare the environment
 *      against. That comparison is the one that cost this project a day
 *      (`rules/02` section C1), and it cannot happen without somebody opening the file.
 *   4. Reading wrangler's own credential file, after running a wrangler command so what
 *      is in it is fresh (`rules/02` section C4).
 *
 * None of the four writes anything anywhere.
 */

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type { LoginHost } from './login.js';
import type { CreateHost } from './run-create.js';
import type { Host } from './secret.js';
import type { Platform } from './wrangler-credential.js';

const colour = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const interactive = process.stdin.isTTY === true;

/**
 * The two wrangler commands, as whole strings rather than a file plus arguments.
 *
 * ⚠️ Not a style choice. `npx` on Windows is a `.cmd`, which Node will not start
 * without a shell, and an argument array combined with `shell: true` is what Node
 * deprecated in DEP0190: with a shell the arguments are concatenated rather than
 * escaped, so the form reads as safe and is not. Measured on 2026-08-12: it also
 * prints a deprecation warning into the terminal of every Windows reader, in the
 * middle of onboarding.
 *
 * Both strings are fixed and nothing from outside is interpolated into either.
 */
const WRANGLER_WHOAMI = 'npx wrangler whoami';
const WRANGLER_LOGIN = 'npx wrangler login';

/** Everything on stdin, for `... | baseclf secret set KEY`. */
async function readPipedInput(): Promise<string> {
  process.stdin.setEncoding('utf8');

  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/**
 * One line typed by a person, with nothing echoed.
 *
 * Raw mode rather than `readline`, because suppressing the echo through `readline`
 * means overwriting a method whose name starts with an underscore, and a private
 * method changes between Node releases without a note. Raw mode is documented, and
 * what it costs is recognising four keys by hand.
 *
 * Ctrl+C has to be one of them. In raw mode the terminal stops turning it into a
 * signal, so without this a reader who changes their mind at the prompt cannot leave.
 *
 * The control characters are built rather than written as escapes, so that nothing in
 * this file is a byte a reader cannot see.
 */
function readTypedLine(): Promise<string> {
  const END_OF_TRANSMISSION = String.fromCharCode(4);
  const INTERRUPT = String.fromCharCode(3);
  const DELETE = String.fromCharCode(127);

  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    const finish = (error?: Error): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      // The newline the terminal would have echoed, so what comes next does not start
      // beside the prompt.
      stdout.write('\n');

      if (error === undefined) resolve(value);
      else reject(error);
    };

    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n' || character === END_OF_TRANSMISSION) {
          finish();
          return;
        }
        if (character === INTERRUPT) {
          finish(new Error('cancelled at the prompt'));
          return;
        }
        if (character === DELETE || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };

    stdin.on('data', onData);
  });
}

/**
 * One line typed by a person, echoed.
 *
 * Separate from `readTypedLine` and the difference is the echo. A project name is not
 * a secret and hiding it as it is typed makes the prompt look broken. Reusing the
 * silent reader for both would be one function and the wrong behaviour for one of
 * them, which is the kind of tidiness that costs a reader their confidence at the
 * first prompt of the product.
 */
function readEchoedLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);

  return new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.resume();

    let value = '';

    const finish = (line: string): void => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
      resolve(line);
    };

    const onData = (chunk: string): void => {
      value += chunk;
      const newline = value.indexOf('\n');
      if (newline === -1) return;
      finish(value.slice(0, newline).replace(/\r$/, ''));
    };

    // 🔴 End of file has to resolve, and the first version of this had no handler for
    // it. A pipe that is empty or already spent never sends a newline, so the promise
    // never settled and the command hung with a prompt on the screen and no way out.
    //
    // The bound in `collectAnswers` is written for exactly this case and could not
    // help: it counts answers, and an answer that never arrives is not a count. A
    // guard one layer above a seam cannot protect against the seam not returning.
    //
    // Resolving empty is the right answer rather than a convenience. Empty means "use
    // the default" at every prompt here, so `create-baseclf < /dev/null` takes the
    // defaults, which is what somebody scripting it means. Anything unusable still
    // runs out of attempts and stops.
    const onEnd = (): void => {
      finish(value.replace(/\r?\n$/, ''));
    };

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
  });
}

/** The `.env` in the working directory, or nothing when there is none to read. */
function readEnvFile(): string | undefined {
  try {
    return readFileSync('.env', 'utf8');
  } catch {
    // Absent, unreadable, or a directory. All of them mean the same thing here, which
    // is that there is no file to compare the environment against.
    return undefined;
  }
}

/**
 * The Worker bundle, from beside this file.
 *
 * `scripts/build-cli.mjs` puts it there and refuses to finish without it, so a package
 * that installed at all has one. Read lazily rather than at startup, which keeps
 * `baseclf doctor` from paying for two megabytes it never looks at.
 */
async function readWorkerBundle(): Promise<string> {
  // `fileURLToPath` on the string rather than through a `URL` object: this project has
  // workerd's DOM lib in scope everywhere, and its `URL` is not structurally the same
  // type as Node's, so building one here is a type error for a reason that has nothing
  // to do with what the code does.
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'worker.js'), 'utf8');
}

/**
 * Run `wrangler whoami`, which refreshes the OAuth token as a side effect.
 *
 * Through `npx` rather than as a dependency: wrangler is tens of megabytes, and
 * anybody with a Cloudflare login already has it, because logging in is how they got
 * one. Returns null when it cannot be run at all, which the caller turns into the
 * instruction to log in.
 */
async function refreshLogin(): Promise<string | null> {
  try {
    return execSync(WRANGLER_WHOAMI, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
  } catch {
    return null;
  }
}

/**
 * Run `npx wrangler login`, inheriting the terminal.
 *
 * Inherited rather than piped, and that is the whole difference from every other call
 * here: the flow prints a URL, waits for a browser, and asks a question. A piped one
 * of those is a command that looks like it has hung.
 */
function runWranglerLogin(): boolean {
  const result = spawnSync(WRANGLER_LOGIN, {
    stdio: 'inherit',
    shell: true,
    timeout: 300_000,
  });

  return result.status === 0;
}

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// `process.platform` is wider than the three this cares about. Anything else gets the
// POSIX answer, which is what every other platform Node runs on uses.
const platform: Platform =
  process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';

const paths = {
  platform,
  home: homedir(),
  env: process.env,
  isDirectory,
};

/** What the runtime owns, for every command. */
export const runtime = {
  colour,
  write: (text: string): void => {
    process.stdout.write(`${text}\n`);
  },
  host: {
    env: process.env,
    envFile: readEnvFile(),
    interactive,
    readSecret: interactive ? readTypedLine : readPipedInput,
  } satisfies Host,
  createHost: {
    fetcher: fetch,
    readWorkerBundle,
    refreshLogin,
    readAuthFile: readTextFile,
    paths,
    envFile: readEnvFile(),
    now: () => new Date(),
    ask: readEchoedLine,
  } satisfies CreateHost,
  loginHost: {
    fetcher: fetch,
    runWranglerLogin: async () => runWranglerLogin(),
    refreshLogin,
    readAuthFile: readTextFile,
    paths,
    envFile: readEnvFile(),
    now: () => new Date(),
  } satisfies LoginHost,
};
