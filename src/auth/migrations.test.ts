/**
 * The schema Better Auth needs, and the two ways of getting it there.
 *
 * `runAuthMigrations` applies it through a binding, which is what a Worker can
 * do. `compileAuthMigrations` only emits it, which is what provisioning from
 * outside a Worker has to do, because a D1 binding exists nowhere else.
 *
 * Both derive their options from the same place as the instance. Deriving them
 * separately drops the jwks table the jwt plugin owns, and the deployment that
 * results looks healthy right up until a token is requested.
 */

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { compileAuthMigrations } from './index.js';

const configured = {
  ...env,
  BETTER_AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
  BETTER_AUTH_URL: 'https://baseclf.test',
};

describe('the emitted migration', () => {
  it('creates every table the configured plugins own', async () => {
    const sql = (await compileAuthMigrations(configured)).toLowerCase();

    for (const table of ['user', 'session', 'account', 'verification']) {
      expect(sql).toContain(`create table "${table}"`);
    }
  });

  it('includes jwks, which belongs to a plugin rather than to the core', async () => {
    // The one a hand-written options object leaves out. Asserted separately
    // from the others because it is the one that has actually gone missing,
    // and its absence is invisible until a token is asked for.
    const sql = (await compileAuthMigrations(configured)).toLowerCase();

    expect(sql).toContain('create table "jwks"');
    expect(sql).toContain('"publickey"');
  });

  it('is SQL only, carrying no configured value with it', async () => {
    // It gets handed to whatever applies it, which may well be a file on disk
    // or a CLI argument. The secret must not travel with it.
    const sql = await compileAuthMigrations(configured);

    expect(sql).not.toContain(configured.BETTER_AUTH_SECRET);
    expect(sql).not.toContain(configured.BETTER_AUTH_URL);
  });
});
