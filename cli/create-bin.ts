#!/usr/bin/env node
/**
 * The `create-baseclf` binary.
 *
 * `npx create-baseclf` resolves a **package** by that name, not a subcommand, which is
 * npm's `create-*` convention and the reason this exists as its own entry point rather
 * than as a flag. It is the same program with the command already chosen, so somebody
 * who types the one thing they were told to type does not then have to know a verb.
 *
 * Arguments still pass through, so `npx create-baseclf --help` reaches the same help
 * that `baseclf create --help` does.
 */

import process from 'node:process';

import { main } from './main.js';
import { runtime } from './node-host.js';

process.exitCode = await main(
  ['create', ...process.argv.slice(2)],
  runtime.write,
  { colour: runtime.colour },
  runtime.host,
  runtime.createHost,
  runtime.loginHost,
);
