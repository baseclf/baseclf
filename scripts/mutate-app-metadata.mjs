/**
 * Break the claims store, and check the tests notice.
 *
 * `$auth.app.*` is the one claim family policies are allowed to trust, so every
 * mutation here models a way that trust could quietly stop being earned: a
 * validator that stops validating, a mint that stops reading the store, a read
 * side that hands a policy something the writer could never have produced, a
 * CLI that stores under an id nobody owns or prints what it promised to keep
 * off terminals. Most of these leave a run that reports success.
 *
 * Usage: node scripts/mutate-app-metadata.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const STORE = 'src/auth/app-metadata.ts';
const AUTH = 'src/auth/index.ts';
const CLI = 'cli/user.ts';

const MUTATIONS = [
  {
    // 🔴 A claim name the policy grammar cannot address is stored anyway. Nothing
    // ever reads it, so the operator's grant silently does not exist.
    name: 'the key pattern no longer checked at the top level',
    file: STORE,
    expect: 'the refuses-a-claim-name test',
    find: /^ {4}if \(!KEY_PATTERN\.test\(key\)\) \{/m,
    replace: '    if (false) {',
  },
  {
    // The 2 KiB ceiling stops existing, and every JWT this user is minted carries
    // whatever got pasted.
    name: 'the size ceiling dropped',
    file: STORE,
    expect: 'the refuses-a-document-too-large test',
    find: / {2}if \(bytes > MAX_APP_METADATA_BYTES\) \{/,
    replace: '  if (false) {',
  },
  {
    // Depth stops being bounded, so a structure is stored where flat facts belong.
    name: 'the depth bound dropped',
    file: STORE,
    expect: 'the refuses-a-structure-nested-past-three-levels test',
    find: / {2}if \(depth > MAX_DEPTH\) \{/,
    replace: '  if (false) {',
  },
  {
    // 🔴 The statement builder trusts its caller. Everything the validator refuses
    // now reaches the database, from every future caller at once.
    name: 'the statement builder skipping the validator',
    file: STORE,
    expect: 'every refusal-before-network test',
    find: / {2}const document = validateAppMetadata\(metadata\);/,
    replace: '  const document = metadata as Record<string, unknown>;',
  },
  {
    // The read side hands back whatever parsed, so a row written around the CLI
    // arrives in tokens as-is instead of narrowing to nothing.
    name: 'the read side accepting a non-object row',
    file: STORE,
    expect: 'the corrupted-row-mints-no-claims test',
    find: / {4}if \(typeof parsed === 'object' && parsed !== null && !Array\.isArray\(parsed\)\) \{/,
    replace: "    if (typeof parsed === 'object' && parsed !== null) {",
  },
  {
    // 🔴 The mint stops reading the store. Every stored grant silently vanishes
    // from every token while the CLI keeps reporting success.
    name: 'the token mint no longer reading the store',
    file: AUTH,
    expect: 'the stored-record-travels-into-the-token test',
    find: / {12}app_metadata: await appClaims\(env, user\.id\),/,
    replace: '            app_metadata: {},',
  },
  {
    // The existence check stops firing, so a typo in the user id stores a grant
    // nobody will ever receive and reports it stored.
    name: 'an unknown user id accepted',
    file: CLI,
    expect: 'the refuses-an-unknown-user-id test',
    find: / {4}if \(\(found\?\.rows\.length \?\? 0\) === 0\) \{/,
    replace: '    if (false) {',
  },
  {
    // The confirmation starts echoing values. Terminals end up in screenshots.
    name: 'claim values echoed to the terminal',
    file: CLI,
    expect: 'the never-echoes-a-value test',
    find: / {4}const listed = names\.length === 0 \? 'an empty record' : names\.join\(', '\);/,
    replace: '    const listed = JSON.stringify(document);',
  },
];

await runMutations({
  files: [STORE, AUTH, CLI],
  suites: ['cli/user.test.ts', 'src/auth/app-claims.test.ts'],
  mutations: MUTATIONS,
});
