/**
 * Break the storage wiring on purpose, and check the tests notice.
 *
 * Two things get mutated here that are easy to read as plumbing:
 *
 *   - The route shape. A file name cannot contain a separator because a third
 *     path segment does not parse, so the URL grammar is a defence and not a
 *     formality. It stops being one the moment the segment count is relaxed.
 *   - The registry's refusals. A policy in the database is not a policy that was
 *     ever checked, since `wrangler d1 execute` bypasses this engine entirely, so
 *     validating at load is the only thing between such a row and a key built
 *     from it.
 *
 * One mutation is a regression guard for a bug found while writing the route: PUT
 * was missing from ALLOWED_METHODS, so a browser preflighting an upload was
 * refused and the console said nothing about a method.
 *
 * Usage: node scripts/mutate-storage-wiring.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const INDEX = 'src/index.ts';
const REGISTRY = 'src/storage/registry.ts';

const MUTATIONS = [
  {
    name: 'the route accepts more than two segments, so a name can be a path',
    file: INDEX,
    expect: 'the third segment test',
    find: /if \(segments\.length !== 2\) return null;/,
    replace: 'if (segments.length < 2) return null;',
  },
  {
    // The bug this file's route actually had when it was first written.
    name: 'PUT missing from ALLOWED_METHODS, so a browser cannot preflight an upload',
    file: INDEX,
    expect: 'the PUT preflight test',
    find: /const ALLOWED_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';/,
    replace: "const ALLOWED_METHODS = 'GET, HEAD, POST, PATCH, DELETE, OPTIONS';",
  },
  {
    name: 'a method the storage path does not offer treated as an upload',
    file: INDEX,
    expect: 'the 405 test',
    find: /if \(method === 'PUT' \|\| method === 'POST'\) return 'upload';/,
    replace: "if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') return 'upload';",
  },
  {
    name: 'stored policies trusted without validation',
    file: REGISTRY,
    expect: 'the I4-from-the-database test',
    find: /^ {4}validateStorageBucket\(definition\);$/m,
    replace: '    void definition;',
  },
  {
    name: 'a disabled bucket loaded as enabled',
    file: REGISTRY,
    expect: 'the disabled bucket test',
    find: /enabled: row\.enabled === 1,/,
    replace: 'enabled: row.enabled >= 0,',
  },
  {
    name: 'a bucket name that could never be addressed loaded anyway',
    file: REGISTRY,
    expect: 'the unaddressable bucket name tests',
    find: /if \(row\.bucket\.length > MAX_BUCKET_NAME_LENGTH \|\| !BUCKET_NAME_PATTERN\.test\(row\.bucket\)\) \{/,
    replace: 'if (false) {',
  },
  {
    name: 'roles accepted without checking they are a list of strings',
    file: REGISTRY,
    expect: 'the malformed roles test',
    find: /if \(!Array\.isArray\(parsed\) \|\| !parsed\.every\(\(entry\) => typeof entry === 'string'\)\) \{/,
    replace: 'if (!Array.isArray(parsed)) {',
  },
];

await runMutations({
  files: [INDEX, REGISTRY],
  suites: ['src/storage/http.test.ts', 'src/storage/registry.test.ts'],
  mutations: MUTATIONS,
});
