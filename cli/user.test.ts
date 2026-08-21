/**
 * `baseclf user set-app`, tested from the refusing side first.
 *
 * The command writes the store that `$auth.app.*` policies trust, so what
 * matters most is what never reaches the network: a document the engine's
 * validator refuses, and a write aimed at a user who does not exist, which is
 * the one mistake that is silent everywhere else (the row sits in the table and
 * no token ever reads it).
 */

import { describe, expect, it } from 'vitest';

import { findVoiceViolations, PLAIN } from './output.js';
import type { PolicyHost } from './policy.js';
import { runUser, USER_FIXED_TEXT } from './user.js';

const ACCOUNT = '00000000b4a5968778695a4b3c2d1e0f';

/** Meta in the shape the endpoint really returns, which the transport validates. */
const META = {
  duration: 0.5,
  size_after: 147_456,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changes: 0,
  changed_db: false,
};

interface Sent {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface Harness {
  readonly host: PolicyHost;
  readonly sent: Sent[];
  readonly text: () => string;
  readonly write: (line: string) => void;
  readonly requests: () => number;
}

function harness(options: { file?: string; userExists?: boolean } = {}): Harness {
  const sent: Sent[] = [];
  const lines: string[] = [];
  let requests = 0;

  const ok = (results: unknown[]): Response =>
    new Response(JSON.stringify({ success: true, result: [{ results, meta: META }] }), {
      status: 200,
    });

  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    requests += 1;

    if (url.includes('/d1/database?name=')) {
      return new Response(
        JSON.stringify({ success: true, result: [{ uuid: 'db-uuid', name: 'baseclf' }] }),
        { status: 200 },
      );
    }

    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      sql?: string;
      params?: unknown[];
    };
    const sql = body.sql ?? '';
    sent.push({ sql, params: body.params ?? [] });

    if (sql.startsWith('SELECT id FROM user')) {
      return ok(options.userExists === false ? [] : [{ id: 'u_real' }]);
    }
    return ok([]);
  };

  return {
    host: {
      fetcher,
      readFile: (path) => (path === 'claims.json' ? options.file : undefined),
      newId: () => 'unused',
      credentials: async () => ({
        credentials: { accountId: ACCOUNT, token: 'a-token-for-tests' },
        warnings: [],
      }),
    },
    sent,
    text: () => lines.join('\n'),
    write: (line: string) => {
      lines.push(line);
    },
    requests: () => requests,
  };
}

describe('refusals that never reach the network', () => {
  it('refuses a claim name the policy grammar cannot spell, before any request', async () => {
    const h = harness({ file: JSON.stringify({ 'bad key': 1 }) });
    const outcome = await runUser(['set-app', 'u_real', 'claims.json'], h.write, PLAIN, h.host);

    expect(outcome).toBe('usage');
    expect(h.text()).toContain('not a usable claim name');
    expect(h.requests()).toBe(0);
  });

  it('refuses a document that is not an object, before any request', async () => {
    const h = harness({ file: JSON.stringify(['not', 'an', 'object']) });
    const outcome = await runUser(['set-app', 'u_real', 'claims.json'], h.write, PLAIN, h.host);

    expect(outcome).toBe('usage');
    expect(h.text()).toContain('one JSON object');
    expect(h.requests()).toBe(0);
  });

  it('refuses a document too large to ride in every JWT, before any request', async () => {
    const h = harness({ file: JSON.stringify({ note: 'x'.repeat(3000) }) });
    const outcome = await runUser(['set-app', 'u_real', 'claims.json'], h.write, PLAIN, h.host);

    expect(outcome).toBe('usage');
    expect(h.text()).toContain('ceiling');
    expect(h.requests()).toBe(0);
  });

  it('refuses a structure nested past three levels, before any request', async () => {
    const h = harness({ file: JSON.stringify({ a: { b: { c: { d: 1 } } } }) });
    const outcome = await runUser(['set-app', 'u_real', 'claims.json'], h.write, PLAIN, h.host);

    expect(outcome).toBe('usage');
    expect(h.text()).toContain('nests deeper');
    expect(h.requests()).toBe(0);
  });

  it('needs a verb, a user id and a file', async () => {
    const h = harness();
    expect(await runUser([], h.write, PLAIN, h.host)).toBe('usage');
    expect(await runUser(['set-app'], h.write, PLAIN, h.host)).toBe('usage');
    expect(await runUser(['revoke', 'u_1', 'f.json'], h.write, PLAIN, h.host)).toBe('usage');
    expect(h.requests()).toBe(0);
  });
});

describe('the write itself', () => {
  it('refuses a user id the deployment has never seen, and writes nothing', async () => {
    const h = harness({ file: JSON.stringify({ plan: 'pro' }), userExists: false });
    const outcome = await runUser(['set-app', 'u_typo', 'claims.json'], h.write, PLAIN, h.host);

    expect(outcome).toBe('failed');
    expect(h.text()).toContain('No user "u_typo"');
    expect(h.sent.some((s) => s.sql.startsWith('INSERT INTO _app_metadata'))).toBe(false);
  });

  it('stores the record and reports the claim names, never the values', async () => {
    const h = harness({ file: JSON.stringify({ plan: 'a-value-not-for-terminals' }) });
    const outcome = await runUser(['set-app', 'u_real', 'claims.json'], h.write, PLAIN, h.host);

    expect(outcome).toBe('ok');

    const upsert = h.sent.find((s) => s.sql.startsWith('INSERT INTO _app_metadata'));
    expect(upsert).toBeDefined();
    expect(upsert?.params[0]).toBe('u_real');
    expect(JSON.parse(String(upsert?.params[1]))).toEqual({ plan: 'a-value-not-for-terminals' });

    expect(h.text()).toContain('plan');
    expect(h.text()).toContain('fifteen minutes');
    expect(h.text()).not.toContain('a-value-not-for-terminals');
  });

  it('creates the table before it writes, so an old deployment still takes the record', async () => {
    const h = harness({ file: JSON.stringify({ plan: 'pro' }) });
    await runUser(['set-app', 'u_real', 'claims.json'], h.write, PLAIN, h.host);

    const kinds = h.sent.map((s) => s.sql.split(' ').slice(0, 3).join(' '));
    const ddl = kinds.findIndex((k) => k.startsWith('CREATE TABLE'));
    const write = kinds.findIndex((k) => k.startsWith('INSERT INTO'));
    expect(ddl).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(ddl);
  });
});

describe('the words themselves', () => {
  it('every fixed sentence passes the voice rules', () => {
    expect(USER_FIXED_TEXT.flatMap(findVoiceViolations)).toEqual([]);
  });
});
