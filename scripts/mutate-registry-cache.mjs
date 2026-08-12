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
    // 🔴 F2. Without expiry the memo is kept until the isolate recycles, which is
    // unbounded. Measured against a live deployment before the fix: 393 seconds in one
    // run, 57 in another.
    name: 'the window never closing',
    file: MEMO,
    expect: 'the keeps-the-value-until-the-window-closes test, and both registry tests',
    find: / {2}const expired = \(\): boolean =>[^;]+;/,
    replace: '  const expired = (): boolean => false;',
  },
  {
    // Off by one at the boundary, which is the mutation that survives a test asserting
    // only "eventually reloads". Both registry tests step to the millisecond before
    // and then onto it, so this dies.
    name: 'the window closing one tick late',
    file: MEMO,
    expect: 'the tests that step exactly onto the boundary',
    find: /now\(\) - loadStartedAt >= maxAgeMs/,
    replace: 'now() - loadStartedAt > maxAgeMs',
  },
  {
    // A memo that never expires is what the policy registry had. The helper being
    // correct does not help if the call site does not ask for the window.
    name: 'the policy registry not asking for a window',
    file: POLICY,
    expect: 'the picks-the-narrowed-policy-up-on-its-own test',
    find: / {2}maxAgeMs: MAX_REGISTRY_AGE_MS,\n {2}now: \(\) => registryClock\(\),/,
    replace: '  now: () => registryClock(),',
  },
  {
    name: 'the storage registry not asking for a window',
    file: STORAGE,
    expect: 'the drops-a-bucket-on-its-own test',
    find: / {2}maxAgeMs: MAX_REGISTRY_AGE_MS,\n {2}now: \(\) => storageClock\(\),/,
    replace: '  now: () => storageClock(),',
  },
  {
    name: 'the policy registry hand-rolling the memo again',
    expect: 'the registry-cache F4 test',
    // Three edits rather than one: the fallback has to be declared and reset as well
    // as read, or the mutated file does not compile and the run reports a build
    // failure where it means to report a surviving mutation.
    //
    // ⚠️ Anchored on the exported function rather than on the `isolateMemo(...)` call.
    // The first version anchored on the call, and adding options to it silently stopped
    // the pattern matching. The runner aborted rather than reporting a false survivor,
    // which is the behaviour worth having, but a pattern that tracks a signature is a
    // pattern that goes stale on the next edit to it.
    edits: [
      {
        file: POLICY,
        find: /export function getRegistry\(executor: D1Executor\): Promise<Registry> \{/,
        replace:
          'let policyFallback: Promise<Registry> | null = null;\n' +
          'export function getRegistry(executor: D1Executor): Promise<Registry> {',
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
        find: /export function getCatalogue\(executor: D1Executor\): Promise<Catalogue> \{/,
        replace:
          'let catalogueFallback: Promise<Catalogue> | null = null;\n' +
          'export function getCatalogue(executor: D1Executor): Promise<Catalogue> {',
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
        find: /export function getStorageRegistry\(executor: D1Executor\): Promise<StorageRegistry> \{/,
        replace:
          'let storageFallback: Promise<StorageRegistry> | null = null;\n' +
          'export function getStorageRegistry(executor: D1Executor): Promise<StorageRegistry> {',
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
