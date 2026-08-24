/**
 * Break the agreement between `_diagnose` and the CORS layer, and check the tests
 * notice.
 *
 * The point of `_diagnose` is that a CORS problem is something an operator reads
 * rather than deduces from a browser console, and that only holds while it agrees
 * with the code doing the work. It did not: it compared the caller's origin
 * against the configured list as raw strings while the request path normalised
 * both sides through `URL.origin`, so a configured value with a trailing slash
 * was allowed by CORS and reported here as missing. Fixed by removing the second
 * implementation, not by copying the matching rule more carefully.
 *
 * These mutations put each way of getting it wrong back, including the two
 * opposite failures: reporting a working origin as broken, and reporting a broken
 * one as working.
 *
 * Usage: node scripts/mutate-diagnose-cors.mjs
 */

import { runMutations } from './mutation-runner.mjs';

const DIAGNOSE = 'src/auth/diagnose.ts';
const INDEX = 'src/index.ts';

const MUTATIONS = [
  {
    // 🔴 The state the real deployment was in on 2026-08-11, undetected. The
    // config it was built from had no `r2_buckets` entry, so the Worker shipped
    // without `env.BUCKET`. The deploy reported success, /health answered 200, and
    // /storage/v1 returned the same 404 it returns when everything is fine.
    name: 'a missing binding reported as a fact but never warned about',
    file: DIAGNOSE,
    expect: 'the forgot-a-binding tests',
    find: / {2}checkBindings\(input\.bindings, warnings\);/,
    replace: '  void input.bindings;',
  },
  {
    // The type declares both as required and non-optional, so nothing upstream
    // catches this. Reading the live `env` is the only way to know.
    name: 'the binding presence assumed rather than read off the live env',
    file: INDEX,
    expect: 'the forgot-a-binding tests, through the worker',
    edits: [
      {
        find: /\{ name: 'BUCKET', present: env\.BUCKET !== undefined \},/,
        replace: "{ name: 'BUCKET', present: true },",
      },
    ],
    // Was a knownSurvivor until 2026-08-24, on the claim that driving the worker
    // with a binding absent meant removing it from `wrangler.jsonc`. It never
    // did: `worker.fetch` takes any env, so a test builds one without BUCKET by
    // destructuring, the same `bare` idiom routes.test.ts already used for the
    // optional variables, plus the cast the required field forces.
  },
  {
    name: 'the drift restored: diagnose forms its own opinion, by raw string',
    file: DIAGNOSE,
    expect: 'the trailing slash agreement test',
    find: /if \(cors\.allowedOriginForCaller !== null\) return;/,
    replace: 'if (trustedOrigins.includes(caller)) return;',
  },
  {
    name: 'every caller reported as allowed, whatever CORS decided',
    file: INDEX,
    expect: 'the refusal agreement test',
    find: /allowedOriginForCaller: allowedOrigin\(request, config\.trustedOrigins\),/,
    replace: "allowedOriginForCaller: request.headers.get('origin'),",
  },
  {
    name: 'the reported header list written out by hand instead of derived',
    file: INDEX,
    expect: 'the header list agreement test',
    find: /allowedRequestHeaders: splitHeaderList\(ALLOWED_REQUEST_HEADERS\),/,
    replace: "allowedRequestHeaders: ['authorization', 'content-type'],",
  },
  {
    name: 'the unusable entry warning removed',
    file: DIAGNOSE,
    expect: 'the entry that matches nothing test',
    find: / {2}if \(unusable\.length === 0\) return;/,
    replace: '  if (unusable.length >= 0) return;',
  },
  {
    // The opposite mistake, and the one that does the more insidious damage. A
    // warning about a value that works sends somebody to change a setting that
    // was already correct, and they have no way to know the diagnostic is wrong.
    name: 'over-eager: a trailing slash reported as matching nothing',
    file: DIAGNOSE,
    expect: 'the trailing slash is fine test',
    find: / {4}return entry\.trim\(\)\.replace\(\/\\\/\+\$\/, ''\) !== asOrigin;/,
    replace: '    return entry.trim() !== asOrigin;',
  },
  {
    // The warning removed, so a deployment that cannot run sign-in at all reports
    // itself healthy. Hashing one password costs 58ms of CPU against a 10ms ceiling
    // on the free plan, and the request is killed with nothing in it naming a
    // password, so this is the only surface that would ever say why.
    name: 'the email and password cost never mentioned',
    file: DIAGNOSE,
    expect: 'the gives-both-numbers and counts-against-ok tests',
    find: / {2}if \(!enabled\) return;/,
    replace: '  if (true) return;',
  },
  {
    // The other direction, and it is the one that gets ignored rather than missed:
    // a warning on every deployment `create` makes teaches people to stop reading
    // the list, and the list is where the real ones live.
    name: 'the cost warning fired even when the path is off',
    file: DIAGNOSE,
    expect: 'the says-nothing-when-it-is-off test',
    find: / {2}if \(!enabled\) return;/,
    replace: '  if (false) return;',
  },
  {
    // 🔴 The one that shipped. Without `set-auth-token` on the expose list a browser
    // hides it, so a cross-origin sign-in answers 200, the client captures null, and
    // every request after it goes out anonymous. The symptom is rows missing rather
    // than an error, on a path that reports success at every step.
    //
    // ⚠️ Weaker than it looks, and the note is the point. This suite runs the worker
    // in-process where nothing enforces CORS, so the mutation cannot reproduce the
    // browser behaviour; it can only be caught by a test that reads the list. That is
    // why the list is asserted rather than the outcome.
    name: 'the session header dropped from what a browser may read',
    file: INDEX,
    expect: 'the reads-the-header-a-session-arrives-in test',
    find: /, retry-after, set-auth-token';/,
    replace: ", retry-after';",
  },
];

await runMutations({
  files: [DIAGNOSE, INDEX],
  // routes.test.ts is here for the forgot-a-binding test that drives the whole
  // worker with `env.BUCKET` absent, which no unit suite can express.
  suites: ['src/auth/diagnose.test.ts', 'src/cors.test.ts', 'src/auth/routes.test.ts'],
  mutations: MUTATIONS,
});
