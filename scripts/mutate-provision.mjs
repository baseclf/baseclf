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
    find: / {2}const found = listed\.find\(\(namespace\) => namespace\.title === title\);\n {2}if \(found !== undefined\) return \{ namespace: found, created: false \};/,
    replace:
      '  const found = listed.find((namespace) => namespace.title === title);\n' +
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
    // Moved into the body, where Cloudflare does not read it. Invisible until a
    // bucket turns up in the wrong region, and by then it holds objects.
    name: 'R2 jurisdiction sent in the body rather than as a header',
    file: CLOUDFLARE,
    expect: 'the jurisdiction header test',
    find: / {2}const headers: Record<string, string> =\n {4}jurisdiction === undefined \? \{\} : \{ 'cf-r2-jurisdiction': jurisdiction \};/,
    replace: '  const headers: Record<string, string> = {};',
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

  // The upload, which is the step that deploys anything. Two of the mutations below
  // model failures that report success, and they are the reason this step is not a
  // `fetch` at the call site.
  {
    // The obvious client sets a JSON content type on everything, and this call is the
    // one where that replaces the boundary the parts are found with.
    name: 'the JSON content type set on the multipart upload too',
    file: CLOUDFLARE,
    expect: 'the multipart upload tests',
    find: / {6}\.\.\.\(carriesOwnContentType \? \{\} : \{ 'content-type': 'application\/json' \}\),/,
    replace: "      'content-type': 'application/json',",
  },
  {
    // 🔴 Reports success. An inherit that resolves to nothing is dropped rather than
    // refused, so the redeploy ships a Worker without a binding it had a minute ago.
    name: 'bindings_inherit=strict dropped, so a lost binding goes unmentioned',
    file: CLOUDFLARE,
    expect: 'the unresolvable-inherit test',
    find: /\?bindings_inherit=strict`,/,
    replace: '`,',
  },
  {
    // 🔴 Reports success. The Worker runs, answers requests, and behaves differently
    // from every measurement in this project, because it is dated 2021.
    name: 'compatibility_date left out of the metadata, so the platform picks 2021',
    file: CLOUDFLARE,
    expect: 'the deploys-the-date-it-was-given test',
    find: / {4}compatibility_date: compatibilityDate,\n/,
    replace: '',
  },
  {
    name: 'the date format trusted to be rejected by the API rather than checked here',
    file: CLOUDFLARE,
    expect: 'the malformed and empty date tests',
    find: / {2}if \(!COMPATIBILITY_DATE_PATTERN\.test\(compatibilityDate\)\) \{/,
    replace: '  if (false) {',
  },
  {
    // Auth then fails on the first request that hashes, which is nowhere near the
    // deploy that caused it.
    name: "the caller's flags replacing the required ones, so nodejs_compat can be lost",
    file: CLOUDFLARE,
    expect: 'the keeps-nodejs_compat test',
    find: / {4}compatibility_flags: \[\n {6}\.\.\.REQUIRED_COMPATIBILITY_FLAGS,\n {6}\.\.\.\(compatibilityFlags \?\? \[\]\)\.filter\(\(flag\) => !REQUIRED_COMPATIBILITY_FLAGS\.includes\(flag\)\),\n {4}\],/,
    replace: '    compatibility_flags: [...(compatibilityFlags ?? [])],',
  },
  {
    // 🔴 Reports success, and the binding is undefined at runtime. Different from the
    // mutation that tidies the map: this one walks past the map at the use site, so
    // the map can be right and the deployment still wrong.
    name: 'the id field hardcoded at the use site, bypassing the per-type map',
    file: CLOUDFLARE,
    expect: 'the per-type id field test',
    find: / {4}\[BINDING_ID_FIELD\[binding\.type\]\]: binding\.id,/,
    replace: '    id: binding.id,',
  },
  {
    name: 'the module sent as a classic script rather than as ESM',
    file: CLOUDFLARE,
    expect: 'the ESM content type test',
    find: /type: MODULE_CONTENT_TYPE/,
    replace: "type: 'application/javascript'",
  },
  {
    name: 'observability left off, so a broken deployment has nothing to read',
    file: CLOUDFLARE,
    expect: 'the observability test',
    find: / {4}observability: \{ enabled: true \},\n/,
    replace: '',
  },
  {
    name: 'a main module that names no part sent anyway',
    file: CLOUDFLARE,
    expect: 'the main-module refusal test',
    find: / {2}if \(!moduleNames\.includes\(mainModule\)\) \{/,
    replace: '  if (false) {',
  },
  {
    name: 'two modules under one name sent, leaving the server to pick',
    file: CLOUDFLARE,
    expect: 'the duplicate-module refusal test',
    find: / {2}if \(duplicateModule !== undefined\) \{/,
    replace: '  if (false) {',
  },
  {
    name: 'two bindings under one name sent, leaving the server to pick',
    file: CLOUDFLARE,
    expect: 'the duplicate-binding refusal test',
    find: / {2}if \(duplicateBinding !== undefined\) \{/,
    replace: '  if (false) {',
  },
  {
    name: 'an empty module list sent rather than refused',
    file: CLOUDFLARE,
    expect: 'the no-modules refusal test, by its message',
    find: / {2}if \(modules\.length === 0\) \{/,
    replace: '  if (false) {',
  },
  {
    // 🔴 What asking for only the first page did: an account whose namespace sat on
    // the second page did not find it, created it, met KV's hard failure on a
    // duplicate title, looked again at the same single page, and gave up.
    name: 'the page walk stopped after the first page',
    file: CLOUDFLARE,
    expect: 'the more-than-one-page tests',
    find: / {4}if \(received\.length < PAGE_SIZE\) return items;/,
    replace: '    return items;',
  },
  {
    // Not a hang: a list endpoint that never says it is done would spin here until
    // the invocation was killed, with nothing said about why.
    name: 'the ceiling on the walk removed, so a list that never ends never stops',
    file: CLOUDFLARE,
    expect: 'the walk-has-a-ceiling test',
    find: / {2}for \(let page = 1; page <= MAX_PAGES; page\+\+\) \{/,
    replace: '  for (let page = 1; ; page++) {',
  },
  {
    name: 'the upload timeout dropped back to the one the other calls use',
    file: CLOUDFLARE,
    expect: 'nothing, and that is the point',
    find: /export const UPLOAD_TIMEOUT_MS = 120_000;/,
    replace: 'export const UPLOAD_TIMEOUT_MS = 30_000;',
    knownSurvivor:
      'nothing measures elapsed time, and a test that did would be measuring the machine ' +
      'rather than the code. The number is a judgment about a slow uplink carrying 1.8 MB, ' +
      'and re-running the upload is safe, so erring long costs a wait and erring short ' +
      'costs a failed provision. If this ever stops surviving, a test started depending on ' +
      'a duration, and that test is the thing to look at.',
  },
  {
    // 🔴 The leak as it shipped. The path was redacted and Cloudflare's own prose was
    // not, and Cloudflare puts the id in a dashboard link of its own. Nothing about
    // the message looks wrong afterwards, which is why it survived to a screenshot.
    name: 'the id left in the half of the message Cloudflare wrote',
    file: CLOUDFLARE,
    expect: 'the taken-out-of-prose-Cloudflare-wrote test',
    find: / {6}redactAccountId\(\n {8}`\$\{withoutAccountId\(path\)\} answered/,
    replace: '      ((t) => t)(\n        `${withoutAccountId(path)} answered',
  },
  {
    // The other half, and the one whose order is easy to get wrong later: truncating
    // first leaves the front of an id in the message, and a fragment still narrows a
    // guess.
    name: 'a non-JSON body truncated before the id is taken out of it',
    file: CLOUDFLARE,
    expect: 'the redacted-before-truncated test',
    find: / {4}const body = redactAccountId\(text, credentials\.accountId\)\.slice\(0, 120\);/,
    replace: '    const body = redactAccountId(text.slice(0, 120), credentials.accountId);',
  },
];

await runMutations({
  files: [CLOUDFLARE, TOKEN],
  suites: ['cli/cloudflare.test.ts', 'cli/token.test.ts'],
  mutations: MUTATIONS,
});
