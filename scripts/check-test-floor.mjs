#!/usr/bin/env node
/**
 * Run the engine suite and refuse a shrunken one.
 *
 * On 2026-08-19 `npm test` printed "65 passed (65)" while two files never ran:
 * two workers died on ECONNRESET and vitest summarised the files that were left
 * as all green. The denominator followed the numerator, so nothing in that line
 * looked wrong, and the only thing that caught it was a person comparing against
 * a number written down elsewhere. This script is that person.
 *
 * It matters more since vitest.config.ts grew an `exclude` list (the site is its
 * own workspace with its own runner): an exclusion accidentally widened swallows
 * real suites and shrinks the denominator the same silent way.
 *
 *   node scripts/check-test-floor.mjs
 *
 * The floor is files rather than tests, because files are what vanished. Moving
 * or deleting suites on purpose means updating TEST_FILE_FLOOR here, which is
 * the point: a shrinking suite becomes a diff somebody wrote instead of a
 * summary nobody read.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Raised from 70 on 2026-08-24, with the two suites under `scripts/lib/` added. They
// are collected by vitest's default `include` rather than by anything naming them, so
// nothing but this number would notice them silently ceasing to be collected, and a
// floor eight below the real count has that much room to hide it.
const TEST_FILE_FLOOR = 78;
const REPORT = join('.vitest', 'floor-report.json');

const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');

mkdirSync('.vitest', { recursive: true });
// A stale report from an earlier run must not vouch for one that crashed before
// writing anything.
rmSync(REPORT, { force: true });

const run = spawnSync(
  process.execPath,
  [vitest, 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${REPORT}`],
  { stdio: 'inherit' },
);

if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

if (!existsSync(REPORT)) {
  console.error('floor: vitest exited 0 and wrote no report, which this refuses to read as green.');
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(REPORT, 'utf8'));
} catch {
  console.error('floor: the vitest report is not JSON. Refusing to read that as green.');
  process.exit(1);
}

const files = Array.isArray(report.testResults) ? report.testResults.length : 0;
const tests = typeof report.numTotalTests === 'number' ? report.numTotalTests : 0;
const passed = typeof report.numPassedTests === 'number' ? report.numPassedTests : 0;

if (files < TEST_FILE_FLOOR) {
  console.error(
    `floor: ${files} test file(s) ran and the floor is ${TEST_FILE_FLOOR}. A shrunken run ` +
      'reports green for files that never executed. If suites moved on purpose, update ' +
      'TEST_FILE_FLOOR in scripts/check-test-floor.mjs as part of the same change.',
  );
  process.exit(1);
}

if (tests === 0 || passed !== tests) {
  console.error(`floor: ${passed} of ${tests} tests passed. The exit code should have said so.`);
  process.exit(1);
}

console.log(`floor: ${files} test files (floor ${TEST_FILE_FLOOR}), ${tests} tests, all ran.`);
