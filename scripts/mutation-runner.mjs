/**
 * Break code on purpose, and report which tests noticed.
 *
 * A green suite says nothing on its own. It says something once every way of
 * getting the code wrong has been shown to turn it red. This project has been
 * caught three times by tests that passed for the wrong reason, so the evidence
 * has to be reproducible rather than a note in a commit message.
 *
 * Two traps this guards against, both of which read as good news:
 *
 *   1. A mutation that applies to nothing looks exactly like a mutation the tests
 *      survived. Every pattern therefore has to match exactly once, across all
 *      the files a mutation touches, or the run aborts.
 *   2. A mutation that survives is usually a weak mutation rather than a gap in
 *      the tests, and telling those apart takes measurement. Record the ones that
 *      survive for a known reason, and this reports it when one of them stops
 *      surviving, because that means the recorded reason has gone stale.
 *
 *   3. 🔴 A mutation that makes the code loop forever is a BROKEN mutation, not a
 *      surviving one, and this runner cannot tell the difference: both look like a
 *      suite that never returns. Worse, the restore below lives in a `finally`, so
 *      killing the run leaves the source file on disk in its mutated state, and an
 *      untracked file cannot be recovered with git. Happened on 2026-08-11 with an
 *      unbounded poll loop, whose `knownSurvivor` note had already said it would
 *      hang; the note was the warning. **Do not write a mutation that removes a
 *      loop bound.** Cover the bound from the other side, by counting iterations
 *      against a known budget.
 *
 * Callers pass their own mutation list. See `mutate-jwks-source.mjs` for the shape.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

const REPORT_FILE = '.mutation.json';

function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Run one or more suites. Returns the titles of the tests that failed. */
function runSuites(suites) {
  try {
    execFileSync(
      'npx',
      ['vitest', 'run', ...suites, '--reporter=json', `--outputFile=${REPORT_FILE}`],
      {
        stdio: 'pipe',
        shell: true,
      },
    );
  } catch {
    // A failing suite exits non-zero, which is the normal outcome here.
  }

  const report = JSON.parse(readFileSync(REPORT_FILE, 'utf8'));
  return report.testResults
    .flatMap((file) => file.assertionResults ?? [])
    .filter((test) => test.status === 'failed')
    .map((test) => test.title);
}

/**
 * Apply one mutation's edits to a snapshot of every target file.
 *
 * Some mistakes are not one edit. Opening a gap between two adjacent lines needs
 * both the gap and the `async` that permits it, and a mutation that applied only
 * half of that would be a weak model of the bug wearing the name of a strong one.
 */
function mutate(mutation, originals) {
  const edits = mutation.edits ?? [
    { file: mutation.file, find: mutation.find, replace: mutation.replace },
  ];
  const mutated = new Map(originals);

  for (const edit of edits) {
    const file = edit.file ?? mutation.file;
    const before = mutated.get(file);
    if (before === undefined) {
      throw new Error(`Mutation "${mutation.name}" edits ${file}, which is not in its file list.`);
    }

    const matches = before.match(new RegExp(edit.find.source, `${edit.find.flags}g`));
    if (matches === null || matches.length !== 1) {
      throw new Error(
        `Mutation "${mutation.name}" matched ${matches?.length ?? 0} times in ${file}, expected ` +
          'exactly 1. A mutation that does not apply reads as a surviving mutant. Fix the pattern.',
      );
    }

    mutated.set(file, before.replace(edit.find, edit.replace));
  }

  return mutated;
}

/**
 * Run every mutation, restore, and exit non-zero on anything unexpected.
 *
 * `files` are every file any mutation touches. `suites` are the test files to
 * run. Each mutation needs `name`, `expect`, and either `find`/`replace` with a
 * `file`, or an `edits` array. `knownSurvivor` records why one is expected to
 * survive.
 */
export async function runMutations({ files, suites, mutations }) {
  const originals = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
  const originalHashes = new Map([...originals].map(([file, text]) => [file, hash(text)]));

  for (const [file, digest] of originalHashes) {
    console.log(`Baseline: ${file} @ ${digest.slice(0, 12)}`);
  }
  console.log('');

  const results = [];

  try {
    for (const mutation of mutations) {
      const mutated = mutate(mutation, originals);
      for (const [file, text] of mutated) writeFileSync(file, text);

      const failed = runSuites(suites);

      for (const [file, text] of originals) writeFileSync(file, text);

      results.push({ ...mutation, failed });

      const verdict = failed.length > 0 ? `KILLED by ${failed.length}` : 'SURVIVED';
      console.log(`${verdict.padEnd(14)} ${mutation.name}`);
      for (const title of failed) console.log(`               - ${title}`);
      console.log('');
    }
  } finally {
    for (const [file, text] of originals) writeFileSync(file, text);
    rmSync(REPORT_FILE, { force: true });
  }

  for (const [file, digest] of originalHashes) {
    if (hash(readFileSync(file, 'utf8')) !== digest) {
      console.error(`RESTORE FAILED: ${file} does not match the original. Check git diff.`);
      process.exit(1);
    }
  }

  const survived = results.filter((result) => result.failed.length === 0);
  const unexpected = survived.filter((result) => result.knownSurvivor === undefined);
  const nowKilled = results.filter(
    (result) => result.knownSurvivor !== undefined && result.failed.length > 0,
  );

  console.log(
    `Restored, hashes match. ${results.length - survived.length}/${results.length} killed.`,
  );

  for (const result of survived) {
    const note =
      result.knownSurvivor === undefined
        ? `expected to be caught by: ${result.expect}`
        : `KNOWN, and why: ${result.knownSurvivor}`;
    console.log(`\nSURVIVED: ${result.name}\n  ${note}`);
  }

  for (const result of nowKilled) {
    console.log(
      `\nNO LONGER SURVIVES: ${result.name}\n` +
        `  it was recorded as surviving because ${result.knownSurvivor}.\n` +
        '  Something changed. Re-read that note before trusting it.',
    );
  }

  process.exit(unexpected.length === 0 && nowKilled.length === 0 ? 0 : 1);
}
