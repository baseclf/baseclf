/**
 * Break the client, and check the tests notice.
 *
 * 🔴 The mutations here are chosen for one property: **most of them leave a client
 * that works.** A dropped bookmark still returns rows, just occasionally stale ones. A
 * token read once still authenticates, for fifteen minutes. An embed sent instead of
 * refused still gets an answer, a 404, which reads as "no rows" to anybody who has not
 * read the parser. None of them look like a bug from the outside, which is why they
 * need mutations rather than review.
 *
 * The two that do fail loudly are the two that matter least.
 *
 * Usage: node scripts/mutate-sdk.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const QUERY = 'sdk/query.ts';
const CLIENT = 'sdk/index.ts';
const AUTH = 'sdk/auth.ts';
const STORAGE = 'sdk/storage.ts';

const MUTATIONS = [
  {
    // ⭐ The bookmark never sent. Reads stop being guaranteed to see writes, and the
    // symptom is a row that is missing sometimes, on somebody else's machine, under
    // load. It is the one promise this client makes that the shape it copies does not.
    name: 'the session bookmark never sent',
    file: QUERY,
    expect: 'the picked-up-and-sent-on-the-next-request test',
    find: /if \(bookmark !== null\) headers\['x-d1-bookmark'\] = bookmark;/,
    replace: '',
  },
  {
    // The other half. Sending one is useless if none is ever kept, and this half is
    // invisible from the request: every call looks correct on its own.
    name: 'the bookmark from a response never kept',
    file: QUERY,
    expect: 'the picked-up-and-sent-on-the-next-request test',
    find: /if \(returned !== null && returned !== ''\) this\.#context\.bookmark\.write\(returned\);/,
    replace: '',
  },
  {
    // 🔴 An embed sent rather than refused. The server answers 404, which reads as
    // "no rows" to anybody who has not read the parser, so the caller goes looking at
    // their data instead of at the feature that does not exist.
    name: 'a relationship embed sent instead of refused',
    file: QUERY,
    expect: 'the refuses-an-embed test',
    find: /if \(columns\.includes\('\('\)\) \{/,
    replace: '    if (false) {',
  },
  {
    // A bulk insert sent as an array. The router refuses it, so this is one round trip
    // for an answer the client already had, and the reason arrives without the part
    // that explains why a partial write would be worse than a refusal.
    name: 'an array body sent instead of refused',
    file: QUERY,
    expect: 'the refuses-a-bulk-insert test',
    find: /if \(Array\.isArray\(row\)\) \{/,
    replace: '    if (false) {',
  },
  {
    // Without it a write answers 204 and the caller reads again to find out what it
    // did: another round trip, and a second policy evaluation of the same rows.
    name: 'the write no longer asking for its rows back',
    file: QUERY,
    expect: 'the asks-for-the-rows-back test',
    find: / {4}if \(this\.#method !== 'GET'\) \{/,
    replace: '    if (this.#body !== undefined) {',
  },
  {
    // 🔴 The token captured once instead of read per request. Works through a whole
    // afternoon of development and starts failing in production fifteen minutes into
    // every session, with nothing reporting why.
    name: 'the token captured at construction rather than read per request',
    file: CLIENT,
    expect: 'the reads-the-token-per-request test',
    // One line, and it is the whole bug: resolve the accessor once at construction
    // and every later call reads the value it had then.
    find: / {4}const given = options\.token;/,
    replace:
      "    const given = typeof options.token === 'function' ? options.token() : options.token;",
  },
  {
    // The builder mutating instead of returning a new one. A shared base becomes a
    // trap: two callers refining it separately get each other's filters, and it shows
    // up as rows missing rather than as an error.
    name: 'the builder mutating instead of returning a new one',
    file: QUERY,
    expect: 'the two-callers-refining-one-builder test',
    find: / {2}#add\(key: string, value: string\): QueryBuilder<Row> \{\n {4}return this\.#with\(this\.#method, \[\.\.\.this\.#params, \[key, value\]\]\);\n {2}\}/,
    replace:
      '  #add(key: string, value: string): QueryBuilder<Row> {\n' +
      '    (this.#params as (readonly [string, string])[]).push([key, value]);\n' +
      '    return this;\n  }',
  },
  {
    // The reason dropped from a refused filter. "match is not available" sends
    // somebody looking for a typo; naming SQLite's missing REGEXP ends the search.
    name: 'a refused filter reported without its reason',
    file: QUERY,
    expect: 'the names-the-reason test',
    find: / {8}: `The "\$\{operator\}" filter is not available on this backend\. \$\{reason\}`,/,
    replace: '        : `The "${operator}" filter is not available on this backend.`,',
  },
  {
    // Errors thrown rather than returned. Every caller has to wrap, and the ones who
    // forget get an unhandled rejection where they expected `{ data, error }`.
    name: 'a refusal thrown instead of returned in error',
    file: QUERY,
    expect: 'the reports-a-refusal-as-an-error test',
    find: / {4}if \(!response\.ok\) \{/,
    replace: '    if (!response.ok) {\n      throw new Error("refused");',
  },
  {
    // single() picking the first of many. The caller said one, the filter matched
    // several, and the row they get depends on an ordering nobody wrote. It is a
    // plausible answer to a question they did not ask.
    name: 'single() answering with the first of many rows',
    file: QUERY,
    expect: 'the refuses-when-more-than-one test',
    find: / {4}if \(result\.data !== null && result\.data\.length > 1\) \{/,
    replace: '    if (false) {',
  },
  {
    // The other direction: an empty result treated as an error. The engine answers
    // "no such row" and "not yours" identically on purpose, so raising on empty
    // invents a distinction the server refuses to make.
    name: 'single() treating an empty result as an error',
    file: QUERY,
    expect: 'the gives-null-and-no-error-when-nothing-matched test',
    find: / {4}if \(result\.data !== null && result\.data\.length > 1\) \{/,
    replace: '    if (result.data !== null && result.data.length !== 1) {',
  },
  {
    // 🔴 The session never captured. Sign-in answers 200, the user is really signed
    // in on the deployment, and the client has nothing to show for it. Every request
    // after goes out anonymous, so the symptom is rows missing rather than an error.
    name: 'the session token never taken off the header',
    file: AUTH,
    expect: 'the captures-the-session and signs-the-data-request tests',
    find: / {6}this\.#session = token;/,
    replace: '',
  },
  {
    // The JWT kept past its life. Measured at 900 seconds, so this works for fifteen
    // minutes and then every request is a 401 that reads as a policy refusal.
    name: 'the JWT reused however old it is',
    file: AUTH,
    expect: 'the drops-the-session-and-the-JWT-with-it test',
    find: / {6}this\.#jwtExpiresAt - now > REFRESH_MARGIN_SECONDS/,
    replace: '      true',
  },
  {
    // 🔴 The one that would be a leak rather than a bug: a client still holding the
    // session of somebody who signed out, and still sending it.
    name: 'the session kept after signing out',
    file: AUTH,
    expect: 'the drops-the-session test',
    // Only the session line: the JWT is derived from it, so keeping the session is
    // the half that matters and the half that is a leak.
    find: / {4}this\.#session = null;/,
    replace: '',
  },
  {
    // A failed exchange keeping the stale token. The engine answers 401, which reads
    // as a policy refusal rather than as a client that could not refresh.
    name: 'a failed token exchange keeping the old token',
    file: AUTH,
    expect: 'the drops-the-session-and-the-JWT-with-it test',
    // ⚠️ The whole branch, because a mutation that only changed the return would be a
    // no-op: the two lines above it have just set the field to null, so returning it
    // returns null anyway. The first version did exactly that and survived, and it
    // survived for being harmless rather than for being uncaught.
    find: / {6}this\.#jwt = null;\n {6}this\.#jwtExpiresAt = null;\n {6}return null;/,
    replace: '      return this.#jwt;',
  },
  {
    // The explicit token losing to a session picked up elsewhere. A server that
    // verified a token already was being deliberate.
    name: 'a signed-in session overriding the token the caller passed',
    file: CLIENT,
    expect: 'the explicit-token-wins test',
    find: / {6}if \(given !== undefined\) return typeof given === 'function' \? given\(\) : given;/,
    replace: '      if (false) return null;',
  },
  {
    // 🔴 The length not declared. Without it the deployment answers 411, because a
    // size limit has nothing to check against, and the caller is told their request
    // was malformed for a header they never knew about.
    name: 'the upload length never declared',
    file: STORAGE,
    expect: 'the declares-it and measures-a-string-in-bytes tests',
    find: / {8}'content-length': String\(length\),/,
    replace: '',
  },
  {
    // A string measured in characters. Five accented characters are six bytes, and a
    // length that disagrees with the body is refused by the runtime rather than
    // trimmed, so this fails only for text that is not plain ASCII.
    name: 'a string body measured in characters rather than bytes',
    file: STORAGE,
    expect: 'the measures-a-string-in-bytes test',
    find: / {2}if \(typeof body === 'string'\) return new TextEncoder\(\)\.encode\(body\)\.byteLength;/,
    replace: "  if (typeof body === 'string') return body.length;",
  },
  {
    // A file name with a slash sent rather than refused. The engine answers 404,
    // which reads as "no such bucket" to somebody who was asking for a folder.
    name: 'a file name with a slash sent instead of refused',
    file: STORAGE,
    expect: 'the refuses-a-file-name-with-a-slash test',
    find: / {4}if \(fileName\.includes\('\/'\)\) \{/,
    replace: '    if (false) {',
  },
];

await runMutations({
  files: [QUERY, CLIENT, AUTH, STORAGE],
  // ⚠️ Both, and leaving the second one out cost a false survivor. The anonymous role
  // can see exactly one row in the fixture, so the case where `single()` matches
  // several can only be written where an identity owns several, which is the other
  // file. A mutation runner pointed at half the tests reports the other half as
  // missing coverage.
  suites: [
    'sdk/client.test.ts',
    'sdk/authenticated.test.ts',
    'sdk/auth.test.ts',
    'sdk/storage.test.ts',
  ],
  mutations: MUTATIONS,
});
