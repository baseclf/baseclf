/**
 * What one password hash costs, and which implementation workerd actually runs.
 *
 * Trap 2 of the auth skill: Better Auth hashes with scrypt at N=16384, r=16,
 * p=1, dkLen=64. The r=16 is eight times the usual setting. A Worker on the
 * free plan gets 10 ms of CPU for an entire request, so this decides whether
 * email and password sign-up can run there at all.
 *
 * The skill expected the problem to be that workerd falls back to the
 * `@noble/hashes` pure JS scrypt, and prescribed overriding it with
 * `node:crypto`. That turns out to be the wrong diagnosis, which is why this
 * file measures which implementation runs as well as how long it takes.
 * `@better-auth/utils@0.4.2` declares a `workerd` export condition pointing at
 * the `node:crypto` build, so the native path is already the one in use.
 *
 * Where the number comes from: a deployed Worker freezes its clock between I/O,
 * so this only works here, in workerd under the test runner (rules/02 A2). This
 * is a development machine rather than an edge machine, and the figure is wall
 * clock rather than the `cpu_ms` Cloudflare bills. For a decision that turns on
 * 10 ms against 60 ms, that is enough; for a promise to a customer, it is not.
 */

import { randomBytes, scrypt } from 'node:crypto';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

/** Verified against node_modules on 2026-08-11, unchanged since the skill was written. */
const SCRYPT = { N: 16384, r: 16, p: 1, dkLen: 64 } as const;

/** The Workers free plan allows this much CPU for an entire request. */
const FREE_PLAN_CPU_BUDGET_MS = 10;

const PASSWORD = 'a-password-of-ordinary-length';

/** The same derivation Better Auth performs, called directly, as a yardstick. */
function nativeScrypt(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      SCRYPT.dkLen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** Median of three, because a single run can catch a collection pause. */
async function median(operation: () => Promise<unknown>): Promise<number> {
  await operation(); // warm up

  const timings: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const started = performance.now();
    await operation();
    timings.push(performance.now() - started);
  }

  timings.sort((a, b) => a - b);
  return timings[1] as number;
}

let nativeMs = 0;
let hashMs = 0;
let verifyMs = 0;

// Measured once. scrypt at these settings is slow by design, so repeating the
// measurement per test would make the whole suite noticeably slower for nothing.
beforeAll(async () => {
  const salt = randomBytes(16).toString('hex');
  const hash = await hashPassword(PASSWORD);

  nativeMs = await median(() => nativeScrypt(PASSWORD, salt));
  hashMs = await median(() => hashPassword(PASSWORD));
  verifyMs = await median(() => verifyPassword({ hash, password: PASSWORD }));

  const share = (hashMs / FREE_PLAN_CPU_BUDGET_MS) * 100;
  console.log('');
  console.log(`  node:crypto scrypt, called directly   ${nativeMs.toFixed(1)} ms`);
  console.log(`  better-auth hashPassword              ${hashMs.toFixed(1)} ms`);
  console.log(`  better-auth verifyPassword            ${verifyMs.toFixed(1)} ms`);
  console.log(`  one hash is ${share.toFixed(0)}% of the free plan CPU budget for a whole request`);
  console.log('');
});

describe('password hashing on workerd', () => {
  it('uses native scrypt, not the pure JS fallback', () => {
    // The fallback is not within a small factor of native scrypt. If the
    // workerd export condition stopped being honoured, this ratio would blow
    // out, and the failure would say so before anyone shipped it.
    expect(hashMs / nativeMs).toBeLessThan(3);
  });

  it('costs more than the free plan allows for an entire request', () => {
    // Recorded as an expectation rather than a note, because the product
    // decision behind it depends on the fact staying true: OAuth performs no
    // hash, which is why social login is the main path and email with password
    // carries a plan warning. If this ever passes cheaply, revisit that.
    expect(hashMs).toBeGreaterThan(FREE_PLAN_CPU_BUDGET_MS);
  });

  it('produces a verifiable hash, and rejects a wrong password', async () => {
    const hash = await hashPassword(PASSWORD);

    expect(await verifyPassword({ hash, password: PASSWORD })).toBe(true);
    expect(await verifyPassword({ hash, password: `${PASSWORD}x` })).toBe(false);
  });
});
