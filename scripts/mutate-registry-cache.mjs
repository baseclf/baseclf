/**
 * Break the isolate memo, and check the tests notice.
 *
 * One line in `utils/memo.ts` carries both halves of the F4 fix: a failed load must be
 * dropped from the memo, and a load nobody is waiting for must not be able to drop
 * anything. The first two mutations remove one half each.
 *
 * The other three matter because F4 was reported against one file and was in three.
 * A shared helper only helps while the call sites use it, and a call site quietly
 * hand-rolling `cached ??= load(...)` again is exactly how this spread the first time.
 * So each one is reverted in turn, and each has to be caught by a test in its own file
 * rather than by the helper's.
 *
 * All of it is fail-closed, which is why it needs mutations: a bug here is invisible
 * from outside until somebody is waiting for a fix that never lands.
 *
 * Usage: node scripts/mutate-registry-cache.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const MEMO = 'src/utils/memo.ts';
const POLICY = 'src/policy/registry.ts';
const CATALOGUE = 'src/db/introspect.ts';
const STORAGE = 'src/storage/registry.ts';

const MUTATIONS = [
  {
    // 🔴 F4 itself. Without the clear, the memo holds a rejected promise, which is not
    // null, so nothing ever replaces it. The isolate fails for as long as it lives and
    // repairing the cause does not help.
    name: 'a failed load left in the memo',
    file: MEMO,
    expect: 'the retries-instead-of-replaying test, and every call site test',
    find: / {8}if \(cached === attempt\) cached = null;\n/,
    replace: '',
  },
  {
    // The other half, and the one that reads as harmless. Clearing unconditionally
    // lets a load abandoned by `reset` reach back and discard the load that replaced
    // it, which by then may already have succeeded.
    name: 'a failed load clearing the memo even after something replaced it',
    file: MEMO,
    expect: 'the does-not-discard-the-load-that-replaced-it test',
    find: / {8}if \(cached === attempt\) cached = null;/,
    replace: '        cached = null;',
  },
  {
    name: 'the policy registry hand-rolling the memo again',
    expect: 'the registry-cache F4 test',
    // Three edits rather than one: the fallback has to be declared and reset as well
    // as read, or the mutated file does not compile and the run reports a build
    // failure where it means to report a surviving mutation.
    edits: [
      {
        file: POLICY,
        find: /const memo = isolateMemo<Registry>\(\);/,
        replace:
          'const memo = isolateMemo<Registry>();\nlet policyFallback: Promise<Registry> | null = null;',
      },
      {
        file: POLICY,
        find: / {2}return memo\.get\(\(\) => loadRegistry\(executor\)\);/,
        replace: '  policyFallback ??= loadRegistry(executor);\n  return policyFallback;',
      },
      {
        file: POLICY,
        find: / {2}memo\.reset\(\);/,
        replace: '  memo.reset();\n  policyFallback = null;',
      },
    ],
  },
  {
    name: 'the catalogue hand-rolling the memo again',
    expect: 'the retries-after-a-failed-read test in introspect.test.ts',
    edits: [
      {
        file: CATALOGUE,
        find: /const memo = isolateMemo<Catalogue>\(\);/,
        replace:
          'const memo = isolateMemo<Catalogue>();\nlet catalogueFallback: Promise<Catalogue> | null = null;',
      },
      {
        file: CATALOGUE,
        find: / {2}return memo\.get\(\(\) => introspect\(executor\)\);/,
        replace: '  catalogueFallback ??= introspect(executor);\n  return catalogueFallback;',
      },
      {
        file: CATALOGUE,
        find: / {2}memo\.reset\(\);/,
        replace: '  memo.reset();\n  catalogueFallback = null;',
      },
    ],
  },
  {
    name: 'the storage registry hand-rolling the memo again',
    expect: 'the recovers-once-a-bad-row-is-repaired test in storage/registry.test.ts',
    edits: [
      {
        file: STORAGE,
        find: /const memo = isolateMemo<StorageRegistry>\(\);/,
        replace:
          'const memo = isolateMemo<StorageRegistry>();\nlet storageFallback: Promise<StorageRegistry> | null = null;',
      },
      {
        file: STORAGE,
        find: / {2}return memo\.get\(\(\) => loadStorageRegistry\(executor\)\);/,
        replace: '  storageFallback ??= loadStorageRegistry(executor);\n  return storageFallback;',
      },
      {
        file: STORAGE,
        find: / {2}memo\.reset\(\);/,
        replace: '  memo.reset();\n  storageFallback = null;',
      },
    ],
  },
];

await runMutations({
  files: [MEMO, POLICY, CATALOGUE, STORAGE],
  suites: [
    'src/utils/memo.test.ts',
    'src/policy/registry-cache.test.ts',
    'src/db/introspect.test.ts',
    'src/storage/registry.test.ts',
  ],
  mutations: MUTATIONS,
});
