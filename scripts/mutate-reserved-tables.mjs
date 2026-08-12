/**
 * Reopen the hole, and check the tests notice.
 *
 * 🔴 The hole this guards was live. Measured against the deployment on
 * 2026-08-12, `GET /_schema` with no token listed `user`, `session`, `account`,
 * `verification`, `jwks`, and a row in `_exposed_tables` would have turned
 * `account` into a REST route. The whole suite was green for all of it, which is
 * the reason these mutations exist rather than a code reading.
 *
 * Two of them are recorded as survivors instead of being deleted. Invariant I8
 * asks for independent checks, so removing any single one leaves the answer
 * unchanged, and a mutation runner cannot tell a redundant line from a
 * deliberately redundant one. Where a layer could be tested on its own contract
 * it is, and those mutations die.
 *
 * Usage: node scripts/mutate-reserved-tables.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const CATALOGUE = 'src/db/introspect.ts';
const WORKER = 'src/index.ts';
const ALLOWLIST = 'src/rest/allowlist.ts';
const ROUTER = 'src/rest/router.ts';

const MUTATIONS = [
  {
    // 🔴 The bug itself, restored in one line: the check that knew only about the
    // underscore prefix. Everything else in this file is a variation on it.
    name: 'the reserved check knowing only about the underscore prefix',
    file: CATALOGUE,
    expect: 'the is-reserved cases, the catalogue flag test, and both allow list tests',
    find: / {2}return name\.startsWith\(SYSTEM_TABLE_PREFIX\) \|\| AUTH_TABLE_SET\.has\(name\);/,
    replace: '  return name.startsWith(SYSTEM_TABLE_PREFIX);',
  },
  {
    // A plugin arriving and the list not keeping up looks exactly like this. The
    // table that holds provider tokens is the one worth losing a test over.
    name: 'account missing from the list of tables the engine owns',
    file: CATALOGUE,
    expect: 'the is-reserved case for account, and the exposing-an-engine-table tests',
    find: / {2}'account',\n/,
    replace: '',
  },
  {
    // Reads as more thorough and is a different bug: `users` and `accounts` are
    // ordinary application tables, and refusing them denies a caller for a reason
    // nobody can find. The exactness is the contract, not an implementation detail.
    name: 'matching the reserved names by prefix instead of exactly',
    file: CATALOGUE,
    expect: 'the matches-character-for-character test',
    find: /AUTH_TABLE_SET\.has\(name\);/,
    replace: 'AUTH_TABLES.some((table) => name.startsWith(table));',
  },
  {
    // The catalogue flag is what every consumer reads. Narrowing it here is the
    // quiet version of the bug: nothing throws, the flag is just wrong.
    name: 'the catalogue flagging only underscore tables as the engine own',
    file: CATALOGUE,
    expect: 'the flags-the-identity-provider-tables test',
    find: / {6}isSystem: isReservedTableName\(entry\.name\),/,
    replace: '      isSystem: entry.name.startsWith(SYSTEM_TABLE_PREFIX),',
  },
  {
    // The allow list has its own test asserting its own contract, which is what
    // makes this one killable while its neighbours are not.
    name: 'the allow list going back to the prefix check',
    file: ALLOWLIST,
    expect: 'the allow-list-refuses-an-engine-table test',
    find: / {2}if \(isReservedTableName\(name\)\) \{/,
    replace: "  if (name.startsWith('_')) {",
  },
  {
    name: 'the public schema endpoint dropping its second check',
    file: WORKER,
    expect: 'nothing, and that is recorded rather than hidden',
    find: / && !isReservedTableName\(table\.name\)/,
    replace: '',
    knownSurvivor:
      'the two checks are deliberately redundant. `isSystem` is decided when the ' +
      'catalogue is built and already covers these names, so removing the check made ' +
      'from the name alone changes no answer. Independence is the point of having both ' +
      'and is precisely what a behavioural test cannot observe. The mutation above it ' +
      'covers the case where the catalogue flag is the thing that is wrong; between ' +
      'the two, either layer failing on its own is caught.',
  },
  {
    name: 'the REST router going back to the prefix check',
    file: ROUTER,
    expect: 'nothing, and that is recorded rather than hidden',
    find: / {2}if \(isReservedTableName\(table\)\) \{/,
    replace: "  if (table.startsWith('_')) {",
    knownSurvivor:
      'same shape as the endpoint above: the allow list and the registry both refuse ' +
      'this table, so the router giving up changes no observable answer. Unlike the ' +
      'allow list there is no seam to call `assertRoutable` on its own, since it is ' +
      'module-private and deliberately so. Worth revisiting if it ever gets exported.',
  },
];

await runMutations({
  files: [CATALOGUE, WORKER, ALLOWLIST, ROUTER],
  suites: ['src/db/reserved-tables.test.ts', 'src/index.test.ts'],
  mutations: MUTATIONS,
});
