/**
 * What would be published, held against what this repository holds.
 *
 * On 2026-08-22 the gate exited 0 while `dist-publish/baseclf` still held the previous
 * release. Reading that exit code and handing somebody a publish command would have
 * put old bytes on npm under a new label, and it was caught by grepping the staged
 * bundle by hand. The comparisons below are what replaced the hand.
 *
 * Both of them have a way of being wrong quietly. A version that agrees says nothing
 * about the code beside it, so the bytes are compared too; and a one-way byte
 * comparison reads a leftover from an older release as agreement, so it runs both
 * directions. Each of those is asserted here rather than assumed.
 */

import { describe, expect, it } from 'vitest';

import { mirrorProblems, versionProblems } from './staged.mjs';

/** A build of two files, and a staged copy that is the same build. */
const built = () =>
  new Map([
    ['baseclf.mjs', 'aaa'],
    ['baseclf.mjs.map', 'bbb'],
  ]);

describe('the version a staged package carries', () => {
  it('is silent when the staged package is at this version', () => {
    expect(versionProblems('baseclf', '0.4.16', '0.4.16')).toEqual([]);
  });

  it('refuses a staged package left at an older release', () => {
    expect(versionProblems('baseclf', '0.4.15', '0.4.16')).toEqual([
      'baseclf is staged at 0.4.15 while this repository is at 0.4.16, so a publish now ' +
        'would ship an older release under a newer label',
    ]);
  });
});

describe('the bytes a staged package carries', () => {
  it('is silent when the staged copy is this build', () => {
    expect(mirrorProblems('baseclf', 'dist-cli', built(), built())).toEqual([]);
  });

  it('names a file the build produced that the staged copy does not have', () => {
    const staged = new Map([['baseclf.mjs', 'aaa']]);

    expect(mirrorProblems('baseclf', 'dist-cli', built(), staged)).toEqual([
      'baseclf is missing dist-cli/baseclf.mjs.map, which the build has',
    ]);
  });

  it('names a file whose bytes are not the bytes that were just built', () => {
    // This is the case a version cannot catch. The staging script writes the version
    // from the root manifest, so a directory from an earlier release where the numbers
    // happen to line up agrees on every number and still holds the wrong code.
    const staged = new Map([
      ['baseclf.mjs', 'from-an-earlier-build'],
      ['baseclf.mjs.map', 'bbb'],
    ]);

    expect(mirrorProblems('baseclf', 'dist-cli', built(), staged)).toEqual([
      'baseclf carries a different dist-cli/baseclf.mjs than the build, so it was staged ' +
        'from an earlier one',
    ]);
  });

  it('names a file left over from an older release that this build does not produce', () => {
    // The direction a comparison written once tends to miss: every file the build has
    // is present and identical, so a one-way read reports agreement while the package
    // ships something nothing here produced.
    const staged = new Map([...built(), ['baseclf-legacy.mjs', 'ccc']]);

    expect(mirrorProblems('baseclf', 'dist-cli', built(), staged)).toEqual([
      'baseclf carries dist-cli/baseclf-legacy.mjs, which this build does not produce',
    ]);
  });

  it('reports every disagreement in one run rather than the first', () => {
    // The script collects problems and prints all of them, so somebody staging again
    // fixes one thing rather than discovering the next one each time they rerun.
    const staged = new Map([
      ['baseclf.mjs', 'from-an-earlier-build'],
      ['baseclf-legacy.mjs', 'ccc'],
    ]);

    expect(mirrorProblems('baseclf', 'dist-cli', built(), staged)).toHaveLength(3);
  });
});
