#!/usr/bin/env node
/**
 * The only file in the CLI that knows it is running under Node.
 *
 * Everything it does is decide what the runtime owns, hand it to `main`, and turn the
 * returned number into an exit code. Kept short deliberately: it is the one part of
 * the CLI no test covers, so there should be as little in it as possible worth
 * testing. The rule it follows is that nothing here decides anything a reader would
 * argue about. Reading a value is here; what to do with the value is not.
 *
 * Colour is off unless stdout is a terminal, and off regardless if `NO_COLOR` is
 * set, which is the convention every well-behaved CLI follows. Without that check a
 * piped or redirected run fills a file with escape codes, and that is why the marks
 * in `output.ts` are not optional: with colour off they are the only signal left.
 *
 * ⚠️ Three things here handle a secret, and all three are here because they need
 * `node:` and for no other reason:
 *
 *   1. Reading a typed line with the echo off, so a pasted value does not stay in the
 *      scrollback of a terminal that ends up in a screenshot.
 *   2. Reading stdin to the end when it is a pipe, so `... | baseclf secret set` works
 *      without a prompt nobody is there to answer.
 *   3. Reading `.env`, so `decideToken` has a file to compare the environment against.
 *      That comparison is the one that cost this project a day (`rules/02` §C1), and
 *      it cannot happen without somebody opening the file.
 *
 * None of the three writes anything anywhere. The value goes to `main`, and from
 * there into a request body.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

import { main } from './main.js';

const colour = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const interactive = process.stdin.isTTY === true;

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

process.exitCode = await main(
  process.argv.slice(2),
  (text) => process.stdout.write(`${text}\n`),
  { colour },
  {
    env: process.env,
    envFile: readEnvFile(),
    interactive,
    readSecret: interactive ? readTypedLine : readPipedInput,
  },
);
