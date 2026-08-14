/**
 * Check a token against a deployment's published key set, from outside it.
 *
 * Exists because of the one question that is hard to answer when `/rest/v1`
 * answers 401: is the token wrong, or is the deployment wrong? The engine cannot
 * tell you. Invariant I5 makes every refusal identical to the caller on purpose,
 * so "expired", "wrong signature" and "the verifier could not reach its own keys"
 * all arrive as the same `{"code":"UNAUTHENTICATED"}`.
 *
 * This answers the first half locally. If the checks below pass, the token is
 * good and the deployment is the thing to look at, which on 2026-08-15 is exactly
 * how the JWKS self-fetch bug was cornered. The reason itself is in the logs,
 * never in the response: `wrangler tail <script> --config <config>`.
 *
 * The token is read from stdin, never from argv: a command line is not private.
 * It goes into shell history, `ps` can read it, and CI keeps it in logs that
 * outlive the job.
 *
 *   node scripts/probe-token-verify.mjs https://my-deployment.workers.dev < token.txt
 */

import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';

const origin = process.argv[2];
if (origin === undefined) {
  console.error('usage: node scripts/probe-token-verify.mjs <deployment-origin> < token.txt');
  console.error('       the token is read from stdin, never from the command line.');
  process.exit(2);
}

const token = (
  await new Promise((resolve) => {
    let buffer = '';
    process.stdin.on('data', (chunk) => (buffer += chunk));
    process.stdin.on('end', () => resolve(buffer));
  })
).trim();

// `process.exitCode` rather than `process.exit()` from here down. Exiting while
// the stdin handle is still closing aborts the process on Windows with a libuv
// assertion, which reports 127 and looks like the probe itself is broken.
if (token.length === 0) {
  console.error('nothing was read from stdin, so there is no token to check.');
  process.exitCode = 2;
}

const header = decodeProtectedHeader(token);
const claims = decodeJwt(token);
const now = Math.floor(Date.now() / 1000);

// Claims, not values. No subject, no email, no key material: this prints to a
// terminal, and terminals end up in screenshots. Rule 00 invariant I9.
console.log(`alg        ${header.alg}`);
console.log(`iss        ${JSON.stringify(claims.iss)}`);
console.log(`aud        ${JSON.stringify(claims.aud)}`);
console.log(`role       ${JSON.stringify(claims.role)}`);
console.log(`expires in ${Number(claims.exp ?? 0) - now}s`);

const response = await fetch(`${origin}/api/auth/jwks`);
console.log(`jwks       HTTP ${response.status} from outside`);

if (!response.ok) {
  process.exitCode = 1;
} else {
  const keySet = createLocalJWKSet(await response.json());

  const check = async (label, options) => {
    try {
      await jwtVerify(token, keySet, { algorithms: ['ES256'], clockTolerance: 5, ...options });
      console.log(`${label} -> PASS`);
      return true;
    } catch (error) {
      console.log(`${label} -> FAIL ${error.code ?? error.message}`);
      return false;
    }
  };

  // Signature first, then the claim checks the worker adds. Separating them is
  // the point: a signature that passes while the claim check fails says the key
  // set is fine and the issuer or audience is configured differently than the
  // token was minted with, which is a different afternoon entirely.
  const signed = await check('signature only        ', {});
  const claimed = await check('signature + iss + aud ', { issuer: origin, audience: origin });

  if (signed && claimed) {
    console.log(
      '\nThe token is good. If the deployment still answers 401, the fault is inside it.',
    );
    console.log('The reason is in the logs and never in the response body (invariant I5).');
  }

  process.exitCode = signed && claimed ? 0 : 1;
}
