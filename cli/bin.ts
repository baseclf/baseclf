#!/usr/bin/env node
/**
 * The `baseclf` binary.
 *
 * Every command, dispatched by `main`. The runtime it needs is in `node-host.ts`,
 * shared with the other binary, so this file has nothing in it worth testing.
 */

import process from 'node:process';

import { main } from './main.js';
import { runtime } from './node-host.js';

process.exitCode = await main(
  process.argv.slice(2),
  runtime.write,
  { colour: runtime.colour },
  runtime.host,
  runtime.createHost,
  runtime.loginHost,
  runtime.policyHost,
);
