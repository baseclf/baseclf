import { describe, expect, it } from 'vitest';

import { findVoiceViolations, markFor, PLAIN } from './output.js';
import { POLICY_FIXED_TEXT, type PolicyHost, parseOptions, runPolicy } from './policy.js';

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

function policyDocument(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    table: 'posts',
    enabled: true,
    policies: [
      {
        name: 'read_own',
        for: 'select',
        to: ['authenticated'],
        using: { author_id: { _eq: '$auth.uid' } },
        columns: ['id', 'title'],
      },
    ],
    ...overrides,
  });
}

interface Sent {
  readonly url: string;
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface Harness {
  readonly host: PolicyHost;
  readonly sent: Sent[];
  readonly lines: string[];
  readonly write: (text: string) => void;
  readonly text: () => string;
  /** Only the SQL, in order, which is what the ordering assertions are about. */
  readonly sql: () => string[];
  /**
   * Every request, including the database lookup.
   *
   * ⚠️ Separate from `sql()` on purpose. The lookup does not carry SQL, so counting
   * statements would report zero for a run that had already gone to the network
   * twice. The test that says a bad document is refused before anything is asked of
   * the network needs this one, and asserting on `sql()` there would have passed
   * whether or not the ordering was right.
   */
  readonly requests: () => number;
}

interface Options {
  readonly file?: string | undefined;
  readonly databases?: readonly { uuid: string; name: string }[];
  /** Columns the fake database reports for `posts`. */
  readonly columns?: readonly string[];
  readonly exposed?: readonly { table_name: string; enabled: number; version: number }[];
  readonly counts?: readonly { table_name: string; n: number }[];
  readonly credentials?: null;
}

function harness(options: Options = {}): Harness {
  const sent: Sent[] = [];
  const lines: string[] = [];
  const columns = options.columns ?? ['id', 'title', 'author_id'];

  const ok = (results: unknown[]): Response =>
    new Response(JSON.stringify({ success: true, result: [{ results, meta: META }] }), {
      status: 200,
    });

  let requests = 0;

  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    requests += 1;

    if (url.includes('/d1/database?name=')) {
      return new Response(
        JSON.stringify({
          success: true,
          result: options.databases ?? [{ uuid: 'db-uuid', name: 'baseclf' }],
        }),
        { status: 200 },
      );
    }

    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      sql?: string;
      params?: unknown[];
    };
    const sql = body.sql ?? '';
    sent.push({ url, sql, params: body.params ?? [] });

    if (sql.startsWith('PRAGMA table_list')) {
      return ok([{ name: 'posts', type: 'table' }]);
    }
    if (sql.startsWith('PRAGMA table_info')) {
      return ok(
        columns.map((name, index) => ({
          cid: index,
          name,
          type: 'TEXT',
          notnull: 0,
          dflt_value: null,
          pk: index === 0 ? 1 : 0,
        })),
      );
    }
    if (sql.startsWith('PRAGMA')) return ok([]);

    if (sql.includes('COUNT(*)')) return ok([...(options.counts ?? [])]);
    if (sql.includes('SELECT') && sql.includes('_exposed_tables')) {
      return ok([...(options.exposed ?? [])]);
    }

    return ok([]);
  };

  const host: PolicyHost = {
    fetcher: fetcher as PolicyHost['fetcher'],
    readFile: () => options.file,
    credentials: async () =>
      options.credentials === null
        ? null
        : { credentials: { accountId: ACCOUNT, token: 'oauth-canary' }, warnings: [] },
  };

  return {
    host,
    sent,
    lines,
    write: (text) => {
      lines.push(text);
    },
    text: () => lines.join('\n'),
    sql: () => sent.map((entry) => entry.sql),
    requests: () => requests,
  };
}

describe('refusing before anything is written', () => {
  it('refuses a document that reads user metadata, without touching the database', async () => {
    // 🔴 Invariant I4, and the ordering matters as much as the refusal: parsing needs
    // no network, so the document is rejected before a single call is made. A version
    // of this that validated after reading the schema would still be correct and
    // would still have made requests on behalf of a document it was about to reject.
    const h = harness({
      file: policyDocument({
        policies: [
          {
            name: 'bad',
            for: 'select',
            to: ['authenticated'],
            using: { tenant: { _eq: '$auth.user.tenant' } },
            columns: ['id'],
          },
        ],
      }),
    });

    expect(await runPolicy(['apply', 'p.json'], h.write, PLAIN, h.host)).toBe('usage');

    // Every request, not every statement. Counting statements would have passed
    // whether or not the parse came first, because the database lookup carries no
    // SQL. That weaker assertion was here first.
    expect(h.requests()).toBe(0);
  });

  it('refuses a column the table does not have, and writes nothing', async () => {
    // Invariant I6. Double-quoted strings are enabled on D1, so a wrong column name
    // comes back as a string rather than an error, and this refusal is the only thing
    // between a typo and a predicate that quietly stops filtering.
    const h = harness({ file: policyDocument(), columns: ['id', 'title'] });

    expect(await runPolicy(['apply', 'p.json'], h.write, PLAIN, h.host)).toBe('usage');
    expect(h.sql().filter((sql) => sql.includes('INSERT'))).toHaveLength(0);
    expect(h.sql().filter((sql) => sql.includes('DELETE'))).toHaveLength(0);
  });

  it('says a missing file is a missing file', async () => {
    const h = harness({ file: undefined });

    expect(await runPolicy(['apply', 'nope.json'], h.write, PLAIN, h.host)).toBe('usage');
    expect(h.text()).toContain('nope.json');
  });

  it('refuses when there is no database by that name rather than creating one', async () => {
    const h = harness({ file: policyDocument(), databases: [] });

    expect(await runPolicy(['apply', 'p.json'], h.write, PLAIN, h.host)).toBe('failed');
    expect(h.text()).toContain('create-baseclf');
  });

  it('matches the database name exactly', async () => {
    // A prefix match would write policies into `blog-staging` when asked for `blog`,
    // and the author would find out from the wrong deployment.
    const h = harness({
      file: policyDocument(),
      databases: [{ uuid: 'other', name: 'baseclf-staging' }],
    });

    expect(await runPolicy(['apply', 'p.json'], h.write, PLAIN, h.host)).toBe('failed');
  });
});

describe('the order the write happens in', () => {
  it('closes the table first and opens it last', async () => {
    // 🔴 There is no transaction available, so the order is the safety. Every state
    // between the first statement and the last is one where the table is not exposed.
    const h = harness({ file: policyDocument() });

    expect(await runPolicy(['apply', 'p.json'], h.write, PLAIN, h.host)).toBe('ok');

    const writes = h
      .sql()
      .filter((sql) => sql.includes('_exposed_tables') && !sql.includes('SELECT'));

    expect(writes[0]).toContain('DELETE');
    expect(writes[writes.length - 1]).toContain('INSERT');
  });

  it('bumps the version past whatever was stored', async () => {
    // The registry caches compiled SQL against the version. Reusing one would leave
    // the deployment serving the previous policy with nothing anywhere saying so.
    const h = harness({
      file: policyDocument(),
      exposed: [{ table_name: 'posts', enabled: 1, version: 4 }],
    });

    await runPolicy(['apply', 'p.json'], h.write, PLAIN, h.host);

    const expose = h.sent.find(
      (entry) => entry.sql.includes('INSERT') && entry.sql.includes('_exposed_tables'),
    );

    expect(expose?.params).toContain(5);
  });

  it('never puts a value in the SQL', async () => {
    // Invariant I7, checked rather than trusted.
    const h = harness({ file: policyDocument() });
    await runPolicy(['apply', 'p.json'], h.write, PLAIN, h.host);

    for (const entry of h.sent) {
      if (entry.sql.startsWith('PRAGMA')) continue;
      expect(entry.sql).not.toContain('read_own');
    }
  });
});

describe('removing a table', () => {
  it('does nothing at all without --confirm', async () => {
    const h = harness();

    expect(await runPolicy(['rm', 'posts'], h.write, PLAIN, h.host)).toBe('usage');
    expect(h.sql().filter((sql) => sql.includes('DELETE'))).toHaveLength(0);
  });

  it('unexposes before it deletes the rules', async () => {
    // Same reasoning as a write. The table stops being reachable before its rules
    // go, never after.
    const h = harness();

    expect(await runPolicy(['rm', 'posts', '--confirm'], h.write, PLAIN, h.host)).toBe('ok');

    const deletes = h.sql().filter((sql) => sql.includes('DELETE'));
    expect(deletes[0]).toContain('_exposed_tables');
  });
});

describe('listing what is exposed', () => {
  it('does not report a table with no rules as working', async () => {
    // Invariant I1 makes the engine throw for a table with no matching policy, so
    // calling it exposed would be reporting the opposite of what a request gets.
    const h = harness({
      exposed: [{ table_name: 'posts', enabled: 1, version: 1 }],
      counts: [],
    });

    expect(await runPolicy(['list'], h.write, PLAIN, h.host)).toBe('ok');
    expect(h.text()).toContain('every request is refused');

    // ⚠️ The mark, not only the words. A mutation that reported this table as
    // working survived the assertion above, because it changes the verdict and
    // leaves the sentence alone. Somebody scanning a column of marks reads the
    // mark.
    const line = h.lines.find((each) => each.includes('posts'));
    expect(line?.startsWith(markFor('attention'))).toBe(true);
  });

  it('says plainly when nothing is exposed', async () => {
    const h = harness({ exposed: [] });

    await runPolicy(['list'], h.write, PLAIN, h.host);
    expect(h.text()).toContain('No table is exposed');
  });
});

describe('how it is called', () => {
  it('refuses an option it does not have rather than ignoring it', () => {
    // A misspelled --project that was skipped would write into whichever deployment
    // the default names, which is only noticed from the other side.
    expect(parseOptions(['apply', 'p.json', '--projekt', 'x'])).toHaveProperty('error');
    expect(parseOptions(['--project'])).toHaveProperty('error');
  });

  it('reads the project name and leaves the rest alone', () => {
    const parsed = parseOptions(['apply', 'p.json', '--project', 'blog']);

    expect(parsed).toMatchObject({ project: 'blog', confirm: false, rest: ['apply', 'p.json'] });
  });

  it('answers with usage and no network when called with nothing', async () => {
    const h = harness();

    expect(await runPolicy([], h.write, PLAIN, h.host)).toBe('usage');
    expect(h.sent).toHaveLength(0);
  });

  it('follows the voice rules in everything it prints', async () => {
    const h = harness({ file: policyDocument() });
    await runPolicy(['apply', 'p.json'], h.write, PLAIN, h.host);

    for (const line of [...h.lines, ...POLICY_FIXED_TEXT]) {
      expect(findVoiceViolations(line)).toEqual([]);
    }
  });
});
