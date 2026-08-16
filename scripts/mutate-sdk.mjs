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
];

await runMutations({
  files: [QUERY, CLIENT],
  suites: ['sdk/client.test.ts'],
  mutations: MUTATIONS,
});
