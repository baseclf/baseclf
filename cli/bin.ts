#!/usr/bin/env node
/**
 * The only file in the CLI that knows it is running under Node.
 *
 * Everything it does is decide two things the runtime owns, hand them to `main`,
 * and turn the returned number into an exit code. Kept this short deliberately:
 * it is the one part of the CLI no test covers, so there should be nothing in it
 * worth testing.
 *
 * Colour is off unless stdout is a terminal, and off regardless if `NO_COLOR` is
 * set, which is the convention every well-behaved CLI follows. Without that check a
 * piped or redirected run fills a file with escape codes, and that is why the marks
 * in `output.ts` are not optional: with colour off they are the only signal left.
 */

import process from 'node:process';

import { main } from './main.js';

const colour = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

process.exitCode = await main(
  process.argv.slice(2),
  (text) => process.stdout.write(`${text}\n`),
  { colour },
);
