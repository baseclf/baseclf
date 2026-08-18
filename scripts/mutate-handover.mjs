/**
 * Break the session handover, and check the tests notice.
 *
 * 🔴 The mutations are picked for one property: **almost all of them leave a working
 * sign-in.** The reader still lands back on their application, still ends up signed
 * in, and still sees their own rows. What changes is where the credential went, or
 * which responses grew one, and neither is visible from a screen that looks right.
 *
 * The one that matters most is the smallest: putting the session in the query string
 * instead of the fragment. Everything works. The session also goes to every server
 * the page fetches from, into `Referer`, and into whatever logs sit in between.
 *
 * Usage: node scripts/mutate-handover.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const HANDOVER = 'src/auth/handover.ts';

const MUTATIONS = [
  {
    // 🔴 The narrowing gone. Every redirect this Worker makes on an auth path would
    // carry a session outward, including the ones that redirect somewhere else for
    // reasons that have nothing to do with signing in. It is also the second line of
    // defence behind Better Auth's own check on `callbackURL`, so losing it quietly
    // is exactly what should not happen.
    name: 'the callback path check dropped, so any auth redirect carries a session',
    file: HANDOVER,
    expect: 'the leaves-every-other-path-alone test',
    find: / {2}if \(!path\.startsWith\(CALLBACK_PREFIX\)\) return response;/,
    replace: '  if (false) return response;',
  },
  {
    // A 200 with a Location header is not a redirect, and a browser does not follow
    // it. Appending there puts a session on a response somebody reads as a body.
    name: 'a non-redirect treated as one',
    file: HANDOVER,
    expect: 'the leaves-a-callback-that-is-not-a-redirect-alone test',
    find: / {2}if \(response\.status < 300 \|\| response\.status >= 400\) return response;/,
    replace: '  if (false) return response;',
  },
  {
    // Every failure path of the callback redirects without establishing a session.
    // Without this check they all grow `session=`, which reads as a session that
    // exists and is empty rather than as no session at all.
    name: 'a redirect with no session given one anyway',
    file: HANDOVER,
    expect: 'the leaves-a-redirect-with-no-session-alone test',
    find: / {2}if \(token === null \|\| token === ''\) return response;/,
    replace: "  if (token === null && token === '') return response;",
  },
  {
    // 🔴 The quiet one, and the reason this file has a mutation script at all. The
    // sign-in works. The application finds the session, because it is looking in the
    // URL either way. And the credential is now in the part of the URL that is sent
    // to every server the page talks to, put in `Referer`, and written to logs.
    name: 'the session moved from the fragment to the query string',
    file: HANDOVER,
    expect: 'the puts-it-in-the-fragment-rather-than-the-query test',
    find: / {2}target\.hash = existing === '' \? handed : `\$\{existing\}&\$\{handed\}`;/,
    replace: '  target.search = existing === \'\' ? handed : `${existing}&${handed}`;',
  },
  {
    // The application's own fragment overwritten. It signs somebody in on the wrong
    // screen, and only for applications that route on the fragment, which is the
    // kind of bug that arrives as one user's report and cannot be reproduced.
    name: "the application's own fragment overwritten rather than kept",
    file: HANDOVER,
    expect: 'the keeps-a-fragment-the-application-already-had test',
    find: / {2}const existing = target\.hash\.startsWith\('#'\) \? target\.hash\.slice\(1\) : target\.hash;/,
    replace: '  const existing = ceil;',
  },
  {
    // A token carrying `&` or `#` breaks out of the value and the application reads
    // half a session. Half a session is not a session, so this looks like a sign-in
    // that silently did not take.
    name: 'the token appended without escaping',
    file: HANDOVER,
    expect: 'the escapes-a-token test',
    find: /encodeURIComponent\(token\)/,
    replace: 'token',
  },
  {
    // Better Auth allows a relative `callbackURL` and resolves it against its own
    // origin. Without the base this throws, the catch returns the response
    // untouched, and those deployments sign nobody in with no error anywhere.
    name: 'a relative location no longer resolved against the deployment',
    file: HANDOVER,
    expect: 'the resolves-a-relative-target test',
    find: / {4}target = new URL\(location, request\.url\);/,
    replace: '    target = new URL(location);',
  },
];

await runMutations({
  files: [HANDOVER],
  suites: ['src/auth/handover.test.ts'],
  mutations: MUTATIONS,
});
