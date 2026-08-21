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

import { execSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type { LoginHost } from './login.js';
import type { PolicyHost } from './policy.js';
import { type CreateHost, resolveAccountCredential } from './run-create.js';
import type { Host } from './secret.js';
import type { BridgeHandler, StudioHost } from './studio.js';
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
/**
 * 🔴 What one question read but did not consume, kept for the next question.
 *
 * A pipe delivers every answer in one chunk. The first version of the reader
 * sliced its line off that chunk and dropped the remainder, so the SECOND
 * prompt of a scripted run saw only end-of-file and silently took its
 * default. Measured against a real provisioning run on 2026-08-21: the
 * project name applied and the frontend origin did not, which is exactly the
 * kind of half-applied answer that looks like success.
 */
let pendingInput = '';

function readEchoedLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);

  return new Promise((resolve) => {
    process.stdin.setEncoding('utf8');

    const finish = (line: string): void => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
      resolve(line.replace(/\r$/, ''));
    };

    /** Take one full line from the shared buffer, leaving the rest behind. */
    const consumeBufferedLine = (): boolean => {
      const newline = pendingInput.indexOf('\n');
      if (newline === -1) return false;
      const line = pendingInput.slice(0, newline);
      pendingInput = pendingInput.slice(newline + 1);
      finish(line);
      return true;
    };

    const onData = (chunk: string): void => {
      pendingInput += chunk;
      consumeBufferedLine();
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
      const line = pendingInput;
      pendingInput = '';
      finish(line.replace(/\r?\n$/, ''));
    };

    // An earlier chunk may already hold this answer, and stdin may already be
    // closed, so the buffer is tried before any listener is attached.
    if (consumeBufferedLine()) return;

    // 'end' fires once. If it already fired while a previous question was
    // listening, waiting for it again would wait forever; whatever is left in
    // the buffer is the whole answer.
    if (process.stdin.readableEnded) {
      onEnd();
      return;
    }

    process.stdin.resume();
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

/**
 * Bind the studio bridge to the loopback interface, and only that interface.
 *
 * 127.0.0.1 in the `listen` call is the boundary that keeps the bridge off the
 * network: the process holds a Cloudflare credential, and a listener on
 * 0.0.0.0 would offer it to whatever the local network holds.
 */
function serveBridge(
  port: number,
  handler: BridgeHandler,
): Promise<{ untilClosed: Promise<void> } | { error: string }> {
  return new Promise((resolve) => {
    const server = createServer((incoming, outgoing) => {
      let bodyText = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => {
        bodyText += chunk;
      });
      incoming.on('end', () => {
        const requestUrl = new URL(incoming.url ?? '/', 'http://127.0.0.1');
        void handler({
          method: incoming.method ?? 'GET',
          path: requestUrl.pathname,
          search: requestUrl.search,
          header: (name: string) => {
            const value = incoming.headers[name.toLowerCase()];
            return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
          },
          bodyText,
        }).then((response) => {
          outgoing.writeHead(response.status, response.headers);
          outgoing.end(response.body);
        });
      });
    });

    server.on('error', (error) => {
      resolve({ error: error instanceof Error ? error.message : String(error) });
    });
    server.listen(port, '127.0.0.1', () => {
      resolve({
        untilClosed: new Promise<void>((done) => {
          server.on('close', () => done());
        }),
      });
    });
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Put text on the clipboard, with the tool this platform ships.
 *
 * Windows and macOS each have exactly one answer. Linux has two conventions and no
 * guarantee of either, so both are tried and a desktop with neither installed gets
 * `false` rather than an error: the caller has wording for that, and the person
 * still holds the value they typed.
 *
 * The value goes in on stdin, never as an argument, for the reason `cli/secret.ts`
 * refuses values on its own command line: argv is public to every process.
 */
function copyToClipboard(text: string): Promise<boolean> {
  const attempts: ReadonlyArray<readonly [string, readonly string[]]> =
    process.platform === 'win32'
      ? [['clip', []]]
      : process.platform === 'darwin'
        ? [['pbcopy', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
          ];

  const tryOne = ([command, args]: readonly [string, readonly string[]]): Promise<boolean> =>
    new Promise((resolve) => {
      const child = spawn(command, [...args], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      child.stdin.on('error', () => {});
      child.stdin.end(text);
    });

  return attempts.reduce<Promise<boolean>>(
    (previous, attempt) => previous.then((done) => (done ? true : tryOne(attempt))),
    Promise.resolve(false),
  );
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

const policyHost = {
  fetcher: fetch,
  readFile: readTextFile,
  // Names the holder of the write lock. Unique per run, across machines.
  newId: () => crypto.randomUUID(),
  // ⚠️ The same resolution `create` uses, called rather than reimplemented. It
  // decides which Cloudflare account the policies land on, and two implementations
  // of that decision is how they come to disagree.
  //
  // It writes its own refusals, which is why it takes the writer and the style.
  credentials: () =>
    resolveAccountCredential(
      {
        fetcher: fetch,
        refreshLogin,
        readAuthFile: readTextFile,
        paths,
        envFile: readEnvFile(),
        now: () => new Date(),
      },
      (text: string) => {
        process.stdout.write(`${text}\n`);
      },
      { colour },
    ),
} satisfies PolicyHost;

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
    // The same resolution `create` and `policy` use, so the machine whose only
    // credential is `wrangler login` can set a secret too. See the note on
    // `policyHost.credentials`.
    credentials: () =>
      resolveAccountCredential(
        {
          fetcher: fetch,
          refreshLogin,
          readAuthFile: readTextFile,
          paths,
          envFile: readEnvFile(),
          now: () => new Date(),
        },
        (text: string) => {
          process.stdout.write(`${text}\n`);
        },
        { colour },
      ),
    copyToClipboard,
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
  policyHost,
  // The same host as `policy` plus somewhere to bind a listener, spread rather
  // than rebuilt: a second copy of the credential resolution is how two commands
  // come to disagree about which account they act on.
  studioHost: { ...policyHost, serve: serveBridge } satisfies StudioHost,
};
