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
];

await runMutations({
  files: [DIAGNOSE, INDEX],
  suites: ['src/auth/diagnose.test.ts', 'src/cors.test.ts'],
  mutations: MUTATIONS,
});
