/**
 * The comparing that `check-staged.mjs` does, with the file system left out.
 *
 * What that check is for is the state, not the step: either the staged packages carry
 * the current version and the bytes that were just built, or it refuses. The two
 * comparisons that decide it are here, taking plain values, so a break in either one
 * is a red test rather than a release that reported clean.
 *
 * ⚠️ Nothing in this file may import from `node:`. The suite runs inside workerd
 * (`vitest.config.ts`), and `node:fs` is not there, so an import of it would take
 * these behaviours back out of the runner. That is the same reason `cli/` keeps its
 * core free of them, stated in `tsconfig.json`.
 *
 * Reading and hashing stay in the script. A digest is only an input to the comparison
 * below, which is the part with a way of being wrong quietly.
 */

/**
 * The version a staged manifest carries, against the version this repository is at.
 *
 * The staged number is written by the staging script from the root manifest, so on
 * its own it says nothing about the code beside it. Disagreement is still decisive:
 * it means the directory was staged from a different release.
 */
export function versionProblems(name, stagedVersion, rootVersion) {
  if (stagedVersion === rootVersion) return [];

  return [
    `${name} is staged at ${stagedVersion} while this repository is at ` +
      `${rootVersion}, so a publish now would ship an older release under a newer label`,
  ];
}

/**
 * A staged mirror of a built directory, compared with the build, both ways.
 *
 * Both directions, because they catch different things. A file the build has and the
 * staged copy does not is a package missing something it claims; the reverse is a
 * leftover from an older release, which a one-way comparison reads as agreement.
 *
 * `built` and `staged` are maps of a path relative to the directory, to a digest of
 * its bytes.
 */
export function mirrorProblems(name, mirrors, built, staged) {
  const problems = [];

  for (const [file, digest] of built) {
    if (!staged.has(file)) {
      problems.push(`${name} is missing ${mirrors}/${file}, which the build has`);
    } else if (staged.get(file) !== digest) {
      problems.push(
        `${name} carries a different ${mirrors}/${file} than the build, so it was ` +
          'staged from an earlier one',
      );
    }
  }

  for (const file of staged.keys()) {
    if (!built.has(file)) {
      problems.push(`${name} carries ${mirrors}/${file}, which this build does not produce`);
    }
  }

  return problems;
}
