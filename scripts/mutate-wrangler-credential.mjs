/**
 * Break the credential lookup, and check the tests notice.
 *
 * This module decides which Cloudflare account a whole provisioning run lands in, and
 * every way it can be wrong is quiet. There is no exception to catch and no message
 * that names the real cause: Cloudflare answers a stale credential by talking about
 * permissions, and `rules/02` section C1 is a day this project spent following that
 * advice while the permissions were already correct.
 *
 * The mutations below are the wrong answers that were actually available while writing
 * it. Two of them are what an unmeasured implementation would have done: prefer the
 * XDG path, and trust a token without checking its expiry.
 *
 * Usage: node scripts/mutate-wrangler-credential.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const FILE = 'cli/wrangler-credential.ts';

const MUTATIONS = [
  {
    // 🔴 The measured trap. Both directories existed on the machine this was written
    // on, holding different tokens, and the XDG one was two weeks stale.
    name: 'the XDG path preferred over the legacy home directory',
    file: FILE,
    expect: 'the prefers-the-legacy-home-directory test',
    find: / {2}if \(paths\.isDirectory\(legacy\)\) return legacy;/,
    replace: '  if (false) return legacy;',
  },
  {
    // The other half of the same decision: taking the legacy path unconditionally
    // breaks every machine that has never had one.
    name: 'the legacy directory taken without checking that it is there',
    file: FILE,
    expect: 'the falls-back-to-the-XDG-path test',
    find: / {2}if \(paths\.isDirectory\(legacy\)\) return legacy;/,
    replace: '  return legacy;',
  },
  {
    // 🔴 An expired token is the ordinary case, not the edge case: these last an
    // hour. Skipping the check starts a run that dies partway through, with
    // resources already created on the reader's account.
    name: 'expiry ignored, so a dead login is used as a live one',
    file: FILE,
    expect: 'the refuses-an-expired-login test',
    find: / {2}if \(remaining <= 0\) \{/,
    replace: '  if (false) {',
  },
  {
    // The flag is what lets a caller refresh before a long run. Losing it does not
    // refuse anything, it just stops `create` from renewing a token that is about to
    // die between two of its steps.
    //
    // ⚠️ This mutation targeted the margin comparison until the design changed under
    // it: being close to expiry used to be a refusal and is now a report, because
    // refusing created a two minute window before every expiry in which the command
    // could not run and the reader could do nothing about it.
    name: 'the expiring-soon flag never set, so nothing refreshes ahead of a long run',
    file: FILE,
    expect: 'the flags-a-login-that-expires-during-the-run test',
    find: /expiringSoon: remaining <= EXPIRY_MARGIN_MS,/,
    replace: 'expiringSoon: false,',
  },
  {
    // A missing or unreadable expiry read as "fine forever" is the same failure with
    // a different cause, and it is what a keyring or a reworded file would produce.
    //
    // ⚠️ This used to be two mutations against two branches, and one of them always
    // survived: the parse below caught what the explicit check was there to catch, so
    // deleting the check changed nothing observable. The branches were merged rather
    // than the mutation being marked a known survivor, because a layer no test can
    // tell the absence of is a layer that hides bugs (ledger D3).
    name: 'a missing or unreadable expiry treated as no expiry at all',
    file: FILE,
    expect: 'the refuses-rather-than-guessing test',
    find: / {2}if \(expiresAt === undefined \|\| Number\.isNaN\(expiresAt\.getTime\(\)\)\) \{/,
    replace: '  if (false) {',
  },
  {
    // 🔴 The split-brain. Provisioning shells out to wrangler for one step, so a run
    // that used the login here while wrangler used an environment token would
    // provision into one account and configure another.
    name: 'the login preferred over an API token, against wrangler own precedence',
    file: FILE,
    expect: 'the lets-an-API-token-win test',
    find: / {2}if \(decision\.token !== undefined\) \{/,
    replace: '  if (!oauth.ok && decision.token !== undefined) {',
  },
  {
    // The warning is the whole value of the choice above. Somebody who just ran
    // `wrangler login` assumes the login is what is being used.
    name: 'the shadowing left silent, which is how it cost a day the first time',
    file: FILE,
    expect: 'the warns-when-a-token-silently-beats-a-login test',
    find: / {4}if \(oauth\.ok\) \{\n {6}warnings\.unshift\(/,
    replace: '    if (false) {\n      warnings.unshift(',
  },
  {
    // A line-based reader that ignored table headers would take a same-named key out
    // of a table wrangler adds later, and pick the wrong credential silently.
    name: 'table headers ignored, so a key inside one can win',
    file: FILE,
    expect: 'the stops-at-a-table-header test',
    find: / {4}if \(line\.startsWith\('\['\)\) break;/,
    replace: "    if (line.startsWith('[')) continue;",
  },
  {
    // The profile decides which account's token is read. Hardcoding `default`
    // silently reads the wrong file for anybody pointed at staging.
    name: 'the profile hardcoded, so a staging login is read from the wrong file',
    file: FILE,
    expect: 'the reads-the-profile-named-by-WRANGLER_API_ENVIRONMENT test',
    find: / {2}return environment;\n\}/,
    replace: "  return 'default';\n}",
  },
  {
    // The one line that tells an OAuth session from an API token session. Without
    // it, the caller cannot tell which credential wrangler is holding, which is the
    // question section C1 says to answer before concluding anything.
    name: 'the OAuth signal read as an API token signal',
    file: FILE,
    expect: 'the recognises-an-OAuth-session test',
    find: /const oauth = \/logged in with an OAuth Token\/i\.test\(text\);/,
    replace: 'const oauth = false;',
  },
];

await runMutations({
  files: [FILE],
  suites: ['cli/wrangler-credential.test.ts'],
  mutations: MUTATIONS,
});
