/**
 * Break provisioning on purpose, and check the tests notice.
 *
 * Everything mutated here is a behaviour of Cloudflare's API rather than a choice of
 * ours, which is what makes them worth guarding. Code written against a forgiving
 * imaginary API passes review and then fails on somebody's account, and three of these
 * fail in ways that report success:
 *
 *   - A binding written under the wrong field name deploys, reports success, and
 *     leaves an undefined binding at runtime. There is nothing to search for.
 *   - Creating a D1 database without listing first makes a second one with the same
 *     name, because D1 tolerates duplicates.
 *   - Trusting the HTTP status treats a 200 with `success: false` as a result.
 *
 * The token mutations guard a warning rather than a behaviour, and that warning is the
 * one thing standing between the next person and the day this project lost to a stale
 * environment variable.
 *
 * Usage: node scripts/mutate-provision.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const CLOUDFLARE = 'cli/cloudflare.ts';
const TOKEN = 'cli/token.ts';

const MUTATIONS = [
  {
    // Deploys, reports success, and the binding is undefined at runtime.
    name: 'the binding field names tidied so everything uses id',
    file: CLOUDFLARE,
    expect: 'the binding field name tests',
    find: / {2}kv_namespace: 'namespace_id',\n {2}r2_bucket: 'bucket_name',/,
    replace: "  kv_namespace: 'id',\n  r2_bucket: 'id',",
  },
  {
    name: 'D1 created without listing first, so a second run makes a second database',
    file: CLOUDFLARE,
    expect: 'the run-twice tests',
    find: / {2}const found = \(existing \?\? \[\]\)\.find\(\(database\) => database\.name === name\);\n {2}if \(found !== undefined\) return \{ database: found, created: false \};/,
    replace:
      '  const found = (existing ?? []).find((database) => database.name === name);\n' +
      '  if (found !== undefined && false) return { database: found, created: false };',
  },
  {
    // Survived the first time, and the survival was informative: the conflict handler
    // absorbs the duplicate so the outcome is identical. The test now counts requests,
    // which is what the list actually buys.
    name: 'KV created without listing first, so a second run makes a request known to fail',
    file: CLOUDFLARE,
    expect: 'the KV request-count test',
    find: / {2}const found = \(listed \?\? \[\]\)\.find\(\(namespace\) => namespace\.title === title\);\n {2}if \(found !== undefined\) return \{ namespace: found, created: false \};/,
    replace:
      '  const found = (listed ?? []).find((namespace) => namespace.title === title);\n' +
      '  if (found !== undefined && false) return { namespace: found, created: false };',
  },
  {
    // Both paths, because a mutation that disabled only the code check survived: the
    // message match covered for it. Each is separately tested now, and this one
    // establishes that absorbing a conflict at all is load-bearing.
    name: 'a duplicate conflict treated as a failure rather than absorbed',
    file: CLOUDFLARE,
    expect: 'the raced-create and unknown-code tests',
    edits: [
      {
        find: / {2}if \(error\.codes\.some\(\(code\) => ALREADY_EXISTS_CODES\.includes\(code\)\)\) return true;/,
        replace: '  if (false) return true;',
      },
      {
        find: / {2}return \/already exists\|duplicate\|taken\/i\.test\(error\.message\);/,
        replace: '  return false;',
      },
    ],
  },
  {
    // A client that trusts the status reports a refusal as a successful provision.
    name: 'the HTTP status trusted, so a 200 with success:false reads as a result',
    file: CLOUDFLARE,
    expect: 'the refusal-arrives-as-200 tests',
    find: / {2}if \(!response\.ok \|\| envelope\.success === false\) \{/,
    replace: '  if (!response.ok) {',
  },
  {
    name: 'R2 jurisdiction moved into the body, where Cloudflare does not read it',
    file: CLOUDFLARE,
    expect: 'the jurisdiction header test',
    find: / {6}body: JSON\.stringify\(\{ name \}\),\n {6}\.\.\.\(jurisdiction === undefined/,
    replace:
      '      body: JSON.stringify({ name, jurisdiction }),\n      ...(true\n        ? {}\n        : jurisdiction === undefined',
  },
  {
    name: 'an existing workers.dev subdomain overwritten rather than left alone',
    file: CLOUDFLARE,
    expect: 'the leaves-an-existing-one-alone test',
    find: / {4}if \(existing\?\.subdomain !== undefined && existing\.subdomain !== ''\) \{/,
    replace: "    if (false && existing?.subdomain !== '') {",
  },
  {
    name: 'every subdomain failure treated as "no subdomain yet", so a 403 leads to a PUT',
    file: CLOUDFLARE,
    expect: 'the does-not-swallow-a-real-failure test',
    find: / {4}if \(!\(error instanceof CloudflareError\) \|\| error\.status !== 404\) throw error;/,
    replace: '    void error;',
  },
  {
    // The warning the day was lost to.
    name: 'the environment-beats-.env warning removed',
    file: TOKEN,
    expect: 'the warning tests',
    find: / {2}if \(environment !== undefined && file !== undefined && environment !== file\) \{/,
    replace: '  if (false) {',
  },
  {
    name: 'the file preferred over the environment, which is not what actually happens',
    file: TOKEN,
    expect: 'the which-token-wins tests',
    find: / {2}const token = argument \?\? environment \?\? file;/,
    replace: '  const token = argument ?? file ?? environment;',
  },
  {
    name: 'a blank environment variable treated as a token',
    file: TOKEN,
    expect: 'the blank-and-whitespace test',
    find: / {2}return trimmed === '' \? undefined : trimmed;/,
    replace: '  return trimmed;',
  },
  {
    // Cloudflare's own message points at permissions, and the permissions are usually
    // fine. Naming the source first is the whole value of this function.
    name: 'a refusal explained without naming where the token came from',
    file: TOKEN,
    expect: 'the explaining-a-refusal tests',
    find: / {2}if \(status === 401 \|\| status === 403\) \{/,
    replace: '  if (false) {',
  },
];

await runMutations({
  files: [CLOUDFLARE, TOKEN],
  suites: ['cli/cloudflare.test.ts', 'cli/token.test.ts'],
  mutations: MUTATIONS,
});
