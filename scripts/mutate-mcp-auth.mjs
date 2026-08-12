/**
 * Break the gate on `/mcp`, and check the tests notice.
 *
 * This endpoint is guarded by a shared secret and nothing else. Every failure here is
 * silent from the outside: a comparison that always succeeds, a deployment that
 * accepts everybody because nobody configured it, a challenge header that stops
 * pointing anywhere. Each of those looks exactly like a working server to whoever is
 * already holding the right token.
 *
 * ⚠️ One mutation reproduces a bug this actually shipped for a few minutes: throwing
 * the project's own error class instead of the SDK's turned a wrong token into a
 * **500**, so a refusal read as a broken deployment. The documentation said which
 * class to throw and it still had to be run to find out.
 *
 * Usage: node scripts/mutate-mcp-auth.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const AUTH = 'src/mcp/auth.ts';
const SERVER = 'src/mcp/server.ts';
const INDEX = 'src/index.ts';

const MUTATIONS = [
  {
    // 🔴 The comparison always agrees. Every token is the right token.
    name: 'the secret comparison always succeeding',
    file: AUTH,
    expect: 'the refuses-a-wrong-token test',
    find: / {2}return crypto\.subtle\.timingSafeEqual\(a, b\);/,
    replace: '  return true;',
  },
  {
    // 🔴 Invariant I1 on a new surface. An unset secret read as "nothing to check"
    // rather than "nobody gets in" is the shape of the most common Supabase incident,
    // moved to a different door.
    name: 'an unconfigured deployment letting anyone in',
    file: AUTH,
    expect: 'the refuses-everybody-when-there-is-no-MCP_TOKEN test',
    find: / {6}if \(expected === undefined \|\| expected === ''\) \{/,
    replace: '      if (false) {',
  },
  {
    // 🔴 The bug that shipped. `OAuthError` is what the middleware maps to a 401 with
    // the challenge; anything else propagates and the caller is told the deployment is
    // broken rather than that their token is wrong.
    name: 'the wrong error class, so a refusal reads as a fault',
    file: AUTH,
    expect: 'the refuses-a-wrong-token test',
    edits: [
      {
        file: AUTH,
        find: / {6}if \(!\(await secretsMatch\(token, expected\)\)\) \{\n {8}throw new OAuthError\(OAuthErrorCode\.InvalidToken, 'Not authorised\.'\);/,
        replace:
          '      if (!(await secretsMatch(token, expected))) {\n' +
          "        throw new Error('Not authorised.');",
      },
    ],
  },
  {
    // Comparing the raw secrets. `timingSafeEqual` throws on different lengths, so a
    // short guess becomes a 500 while a same-length guess is a 401, and the pair of
    // answers is a length oracle.
    name: 'the secrets compared without hashing first',
    file: AUTH,
    expect: 'the refuses-a-wrong-token-of-a-different-length test',
    edits: [
      {
        file: AUTH,
        find: / {2}const \[a, b\] = await Promise\.all\(\[\n {4}crypto\.subtle\.digest\('SHA-256', encoder\.encode\(presented\)\),\n {4}crypto\.subtle\.digest\('SHA-256', encoder\.encode\(expected\)\),\n {2}\]\);/,
        replace:
          '  const a = encoder.encode(presented).buffer;\n' +
          '  const b = encoder.encode(expected).buffer;',
      },
    ],
  },
  {
    // The challenge stops naming the metadata document. The endpoint still refuses
    // correctly and becomes undiscoverable: a client that has never seen this server
    // has nothing to follow.
    name: 'the challenge no longer pointing at the metadata',
    file: SERVER,
    expect: 'the tells-an-unauthenticated-caller-where-to-look test',
    find: / {4}resourceMetadataUrl: metadataUrlFor\(url\.origin\),\n/,
    replace: '',
  },
  {
    // An authorization server invented so the document looks complete. A client would
    // follow it and try to authorise against something that does not exist.
    name: 'a fabricated authorization server in the metadata',
    file: AUTH,
    expect: 'the advertises-no-authorization-server test',
    find: / {4}resource: resource\.href,/,
    replace: '    resource: resource.href,\n    authorization_servers: [resource.origin],',
  },
  {
    // Guessing the secret costs nothing. The endpoint is one long brute force away
    // from open, and the log never says it happened.
    name: 'guesses at the secret going uncounted',
    file: INDEX,
    expect: 'the counts-guesses-against-a-budget test',
    find: / {2}if \(pathname === MCP_ROUTE\) return \{ bucket: 'mcp', rule: CREDENTIAL_LIMIT \};/,
    replace: '',
  },
];

await runMutations({
  files: [AUTH, SERVER, INDEX],
  suites: ['src/mcp/server.test.ts'],
  mutations: MUTATIONS,
});
