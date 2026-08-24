/**
 * `baseclf storage`, tested from the side that refuses.
 *
 * Two properties carry this file and neither is about a bucket being registered.
 *
 * The first is the ORDER. There is no transaction available here, so what makes an
 * interrupted run safe is that the bucket row is deleted before anything else and
 * written back last. Between those two statements the engine refuses every request
 * for that bucket, which is what invariant I1 calls the safe state. A test that only
 * checked the end state would pass for an implementation with no such guarantee.
 *
 * The second is that this command owns no security rule of its own. The document
 * goes to the engine's `validateStorageBucket`, so a policy the engine would refuse
 * has to be refused here, and refused before the network is touched at all.
 */

import { describe, expect, it } from 'vitest';

import { findVoiceViolations, PLAIN } from './output.js';
import type { PolicyHost } from './policy.js';
import { parseStorageOptions, runStorage, STORAGE_FIXED_TEXT } from './storage.js';

const ACCOUNT = '00000000b4a5968778695a4b3c2d1e0f';

const META = {
  duration: 0.5,
  size_after: 147_456,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changes: 0,
  changed_db: false,
};

function storageDocument(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    bucket: 'avatars',
    enabled: true,
    policies: [
      {
        name: 'upload_own',
        for: 'upload',
        to: ['authenticated'],
        prefix: 'avatars/$auth.uid/',
        maxSizeBytes: 1024,
        allowedMimeTypes: ['image/png'],
      },
      { name: 'list_own', for: 'list', to: ['authenticated'], prefix: 'avatars/$auth.uid/' },
    ],
    ...overrides,
  });
}

interface Sent {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface Options {
  readonly file?: string | undefined;
  readonly buckets?: readonly { bucket: string; enabled: number; version: number }[];
  readonly counts?: readonly { bucket: string; n: number }[];
  readonly storedVersion?: number;
  readonly failOn?: string;
}

function harness(options: Options = {}) {
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

    if (options.failOn !== undefined && sql.startsWith(options.failOn)) {
      return new Response(
        JSON.stringify({ success: false, errors: [{ code: 7500, message: 'refused on purpose' }] }),
        { status: 500 },
      );
    }

    if (sql.startsWith('SELECT "version"')) {
      return ok(options.storedVersion === undefined ? [] : [{ version: options.storedVersion }]);
    }
    if (sql.startsWith('SELECT "bucket", "enabled"')) return ok([...(options.buckets ?? [])]);
    if (sql.startsWith('SELECT "bucket", COUNT')) return ok([...(options.counts ?? [])]);

    return ok([]);
  };

  const host: PolicyHost = {
    fetcher,
    readFile: (path: string) => (path === 'bucket.json' ? options.file : undefined),
    newId: () => 'unused-here',
    credentials: async () => ({
      credentials: { accountId: ACCOUNT, token: 'cfut_not-a-real-token' },
      warnings: [],
    }),
  };

  return {
    host,
    sent,
    write: (text: string) => lines.push(text),
    text: () => lines.join('\n'),
    sql: () => sent.map((one) => one.sql),
    requests: () => requests,
  };
}

describe('the order that makes an interrupted run safe', () => {
  it('closes the bucket before anything else and opens it last', async () => {
    const test = harness({ file: storageDocument() });

    expect(await runStorage(['apply', 'bucket.json'], test.write, PLAIN, test.host)).toBe('ok');

    // Only the statements that touch the two tables, so the schema statements at the
    // front do not have to be counted to read the order.
    const touching = test
      .sql()
      .filter((sql) => sql.startsWith('DELETE') || sql.startsWith('INSERT'));

    expect(touching[0]).toContain('DELETE FROM "_storage_buckets"');
    expect(touching[1]).toContain('DELETE FROM "_storage_policies"');
    expect(touching.at(-1)).toContain('INSERT INTO "_storage_buckets"');

    // Between the first and the last, the bucket is not registered, so the engine
    // refuses every request for it. That is the property, not the count.
    expect(
      touching.filter((sql) => sql.startsWith('INSERT INTO "_storage_policies"')),
    ).toHaveLength(2);
  });

  it('bumps the version rather than reusing the one that is there', async () => {
    const test = harness({ file: storageDocument(), storedVersion: 4 });

    await runStorage(['apply', 'bucket.json'], test.write, PLAIN, test.host);

    const written = test.sent.find((one) => one.sql.startsWith('INSERT INTO "_storage_buckets"'));
    expect(written?.params).toEqual(['avatars', 1, 5]);
  });

  it('starts at one for a bucket that has never been written', async () => {
    const test = harness({ file: storageDocument() });

    await runStorage(['apply', 'bucket.json'], test.write, PLAIN, test.host);

    const written = test.sent.find((one) => one.sql.startsWith('INSERT INTO "_storage_buckets"'));
    expect(written?.params).toEqual(['avatars', 1, 1]);
  });

  it('sends every value as a bound parameter, never inside the statement', async () => {
    // Invariant I7. The prefix and the roles are the values a document controls, so
    // finding either one inside the SQL text would mean they were concatenated.
    const test = harness({ file: storageDocument() });

    await runStorage(['apply', 'bucket.json'], test.write, PLAIN, test.host);

    for (const one of test.sent) {
      expect(one.sql).not.toContain('avatars/$auth.uid/');
      expect(one.sql).not.toContain('authenticated');
    }

    const policy = test.sent.find((one) => one.sql.startsWith('INSERT INTO "_storage_policies"'));
    expect(policy?.params).toContain('avatars/$auth.uid/');
    expect(policy?.params).toContain('["authenticated"]');
  });
});

describe('a document the engine would refuse', () => {
  it('is refused here too, and before the network is touched', async () => {
    // The prefix rule, which exists because without the separator `avatars/u_ann`
    // also matches `avatars/u_annex/secret`.
    const test = harness({
      file: storageDocument({
        policies: [
          { name: 'upload_own', for: 'upload', to: ['authenticated'], prefix: 'avatars/$auth.uid' },
        ],
      }),
    });

    expect(await runStorage(['apply', 'bucket.json'], test.write, PLAIN, test.host)).toBe('usage');
    expect(test.requests()).toBe(0);
    expect(test.text()).toContain('refused');
  });

  it('is refused when it names a claim the user can write', async () => {
    // Invariant I4 reaches storage through the prefix template. The engine owns the
    // rule; this asserts the command does not go around it.
    const test = harness({
      file: storageDocument({
        policies: [
          {
            name: 'upload_own',
            for: 'upload',
            to: ['authenticated'],
            prefix: 'avatars/$auth.user.tenant/',
          },
        ],
      }),
    });

    expect(await runStorage(['apply', 'bucket.json'], test.write, PLAIN, test.host)).toBe('usage');
    expect(test.requests()).toBe(0);
  });

  it('is refused when it is not JSON at all, and says so differently', async () => {
    const test = harness({ file: 'not json' });

    expect(await runStorage(['apply', 'bucket.json'], test.write, PLAIN, test.host)).toBe('usage');
    expect(test.text()).toContain('not JSON');
  });

  it('is refused when there is no such file', async () => {
    const test = harness({ file: undefined });

    expect(await runStorage(['apply', 'missing.json'], test.write, PLAIN, test.host)).toBe('usage');
    expect(test.requests()).toBe(0);
  });
});

describe('what list reports', () => {
  it('says a bucket with no rules refuses everything, rather than calling it registered', async () => {
    // Invariant I1 seen from the operator's side. A bucket row with no policies is
    // not a working bucket, and reporting it as one would report the opposite of
    // what a request gets.
    const test = harness({ buckets: [{ bucket: 'avatars', enabled: 1, version: 2 }] });

    expect(await runStorage(['list'], test.write, PLAIN, test.host)).toBe('ok');
    expect(test.text()).toContain('no rules');
  });

  it('says a disabled bucket is disabled, whatever rules it has', async () => {
    const test = harness({
      buckets: [{ bucket: 'avatars', enabled: 0, version: 2 }],
      counts: [{ bucket: 'avatars', n: 3 }],
    });

    await runStorage(['list'], test.write, PLAIN, test.host);
    expect(test.text()).toContain('disabled');
  });

  it('says nothing is registered rather than printing an empty list', async () => {
    const test = harness();

    await runStorage(['list'], test.write, PLAIN, test.host);
    expect(test.text()).toContain('No bucket is registered');
    expect(test.text()).toContain('baseclf storage apply');
  });
});

describe('removing a bucket', () => {
  it('changes nothing without the flag, and says what would go', async () => {
    const test = harness();

    expect(await runStorage(['rm', 'avatars'], test.write, PLAIN, test.host)).toBe('usage');
    expect(test.requests()).toBe(0);
    expect(test.text()).toContain('--confirm');
    // The objects are not the rules, and a reader deciding whether to run this needs
    // to know which one they are deleting.
    expect(test.text()).toContain('objects stay in R2');
  });

  it('takes the bucket out of the registry before deleting its rules', async () => {
    const test = harness();

    expect(await runStorage(['rm', 'avatars', '--confirm'], test.write, PLAIN, test.host)).toBe(
      'ok',
    );

    const touching = test.sql().filter((sql) => sql.startsWith('DELETE'));
    expect(touching[0]).toContain('_storage_buckets');
    expect(touching[1]).toContain('_storage_policies');
  });

  it('does not claim the bucket was there', async () => {
    // `DELETE` on a row that does not exist is not an error, so reporting "removed"
    // would be a sentence a reader could act on wrongly.
    const test = harness();

    await runStorage(['rm', 'never-registered', '--confirm'], test.write, PLAIN, test.host);
    expect(test.text()).toContain('is not served by this deployment');
  });
});

describe('the flags and the verbs', () => {
  it('refuses an option it does not have rather than ignoring it', () => {
    // A misspelled `--project` that was skipped would write into whichever
    // deployment the default names, and that is only noticed from the other side.
    expect(parseStorageOptions(['apply', 'x.json', '--projekt', 'other'])).toEqual({
      error: 'there is no --projekt option.',
    });
  });

  it('refuses a project flag with nothing after it', () => {
    expect(parseStorageOptions(['list', '--project'])).toEqual({
      error: '--project needs a name after it.',
    });
  });

  it('refuses a verb it does not have, and names it', async () => {
    const test = harness();

    expect(await runStorage(['expose'], test.write, PLAIN, test.host)).toBe('usage');
    expect(test.text()).toContain('"expose"');
    expect(test.requests()).toBe(0);
  });

  it('asks for a file when apply has none', async () => {
    const test = harness();

    expect(await runStorage(['apply'], test.write, PLAIN, test.host)).toBe('usage');
    expect(test.text()).toContain('needs a file');
  });
});

describe('what the command prints', () => {
  it('keeps to the voice rules every other fixed text does', () => {
    expect(STORAGE_FIXED_TEXT.flatMap(findVoiceViolations)).toEqual([]);
  });

  it('reports a database refusal as a refusal rather than crashing', async () => {
    const test = harness({ file: storageDocument(), failOn: 'DELETE FROM "_storage_buckets"' });

    expect(await runStorage(['apply', 'bucket.json'], test.write, PLAIN, test.host)).toBe('failed');
    expect(test.text()).toContain('refused');
  });
});
