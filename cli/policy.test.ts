import { describe, expect, it } from 'vitest';

import { MAX_REGISTRY_AGE_MS } from '../src/utils/memo.js';
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
  /** Rows `loadRegistry` reads back, for the lint verb. Shaped like `_policies`. */
  readonly storedPolicies?: readonly Record<string, unknown>[];
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
    // After the COUNT branch on purpose: `list` groups over the same table and would
    // otherwise be answered with policy rows it does not know how to read.
    if (sql.includes('SELECT') && sql.includes('_policies')) {
      return ok([...(options.storedPolicies ?? [])]);
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
    // ⚠️ Not because anything reads it. Nothing does, which is debt F2 and is measured
    // in `src/policy/registry-cache.test.ts`. It goes up so that somebody reading
    // `policy list` can see the row changed.
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

  it('starts the version over after the table has been removed', async () => {
    // 🔴 Measured against a live database on 2026-08-12: a table at version 2, removed
    // and applied again, comes back at version 1. `rm` deletes the row the version is
    // read from, so the count starts over and a version can repeat with different
    // policies behind it.
    //
    // Free today because nothing reads the number. Written down as a test rather than
    // a comment because the V7 invalidation will read it, and the trap fails open: an
    // isolate holding version 3 that sees a stored 1 concludes it is ahead and keeps
    // serving the policy that was deleted.
    const h = harness({ file: policyDocument(), exposed: [] });

    await runPolicy(['apply', 'p.json'], h.write, PLAIN, h.host);

    const expose = h.sent.find(
      (entry) => entry.sql.includes('INSERT') && entry.sql.includes('_exposed_tables'),
    );

    expect(expose?.params).toContain(1);
  });

  it('names the table in the command it hands back', async () => {
    // The line printed at the end used to read the file path where it meant the
    // table, decide it looked like a filename, and print `your-table`. Every test
    // asserted the outcome and none read the sentence, so a real run found it.
    const h = harness({ file: policyDocument() });
    await runPolicy(['apply', 'p.json'], h.write, PLAIN, h.host);

    // Split the rendered text, not the writes: `nextAction` returns its whole block
    // as one string, so there is no write that is only the curl line.
    const curl = h
      .text()
      .split('\n')
      .find((line) => line.startsWith('curl '));

    expect(curl).toContain('/rest/v1/posts');
    expect(curl).not.toContain('your-table');
    expect(curl).not.toContain('p.json');
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

describe('what a policy will cost to run', () => {
  // 🔴 Debt 4. D1 bills for rows scanned rather than returned, so a policy column
  // with no index is a line on a bill every request, and the author has nowhere else
  // to see it. `rules/01` section D calls this a feature rather than a nice-to-have.
  //
  // The fake database reports no indexes, so `author_id` in the standard document is
  // unindexed and `id` is the primary key.

  it('warns on apply, with a statement that can be pasted as it is', async () => {
    const h = harness({ file: policyDocument() });

    expect(await runPolicy(['apply', 'p.json'], h.write, PLAIN, h.host)).toBe('ok');

    // Split the rendered text, because `copyable` returns the blank lines around the
    // value as part of one write. What a terminal shows is the line, not the write.
    const remedy = h
      .text()
      .split('\n')
      .find((line) => line.includes('CREATE INDEX'));

    // Unindented, and that is not a formatting preference. A statement with two
    // spaces in front of it does not double-click cleanly, and whoever pastes the
    // spaces gets a syntax error from D1 with nothing to explain it.
    expect(remedy).toBe('CREATE INDEX "posts_author_id_idx" ON "posts" ("author_id");');
  });

  it('still stores the policy, because a bill is not a refusal', async () => {
    // ⚠️ The deliberate exception to how the rest of the engine behaves. Everywhere
    // else a doubt is a refusal, because everywhere else the doubt is about who may
    // read what. Refusing a policy that grants exactly what its author meant, over an
    // index, would be the engine overruling them on a question they may be wrong
    // about.
    const h = harness({ file: policyDocument() });

    await runPolicy(['apply', 'p.json'], h.write, PLAIN, h.host);

    expect(
      h.sql().filter((sql) => sql.includes('INSERT') && sql.includes('_policies')),
    ).toHaveLength(1);
  });

  it('says nothing about a policy on the primary key', async () => {
    const h = harness({
      file: policyDocument({
        policies: [
          {
            name: 'read_own',
            for: 'select',
            to: ['authenticated'],
            using: { id: { _eq: '$auth.uid' } },
            columns: ['id', 'title'],
          },
        ],
      }),
    });

    await runPolicy(['apply', 'p.json'], h.write, PLAIN, h.host);
    expect(h.text()).not.toContain('CREATE INDEX');
  });

  it('lints what is already stored, which is where most policies are', async () => {
    // The verb exists because `apply` only ever sees the document in front of it, and
    // every policy applied before this existed was never looked at.
    const h = harness({
      exposed: [{ table_name: 'posts', enabled: 1, version: 1 }],
      storedPolicies: [
        {
          table_name: 'posts',
          name: 'read_own',
          operation: 'select',
          roles: JSON.stringify(['authenticated']),
          using_expr: JSON.stringify({ author_id: { _eq: '$auth.uid' } }),
          check_expr: null,
          columns: JSON.stringify(['id', 'title']),
          set_expr: null,
        },
      ],
    });

    expect(await runPolicy(['lint'], h.write, PLAIN, h.host)).toBe('ok');
    expect(h.text()).toContain('posts.read_own');
    expect(
      h
        .text()
        .split('\n')
        .find((line) => line.includes('CREATE INDEX')),
    ).toBe('CREATE INDEX "posts_author_id_idx" ON "posts" ("author_id");');
  });

  it('prints one statement per index, however many policies need it', async () => {
    // 🔴 Found by running the command, not by a test. Two policies comparing the same
    // column both asked for the same `CREATE INDEX`, and the reader who copies both
    // gets an error from D1 on the second saying the index already exists.
    //
    // Every assertion here counted the statement rather than only looking for it,
    // which is the difference that would have caught it the first time.
    const h = harness({
      file: policyDocument({
        policies: [
          {
            name: 'read_own',
            for: 'select',
            to: ['authenticated'],
            using: { author_id: { _eq: '$auth.uid' } },
            columns: ['id', 'title'],
          },
          {
            name: 'update_own',
            for: 'update',
            to: ['authenticated'],
            using: { author_id: { _eq: '$auth.uid' } },
            check: { author_id: { _eq: '$auth.uid' } },
            columns: ['title'],
          },
        ],
      }),
    });

    await runPolicy(['apply', 'p.json'], h.write, PLAIN, h.host);

    const statements = h
      .text()
      .split('\n')
      .filter((line) => line.includes('CREATE INDEX'));

    expect(statements).toHaveLength(1);

    // Both policies are still named, because which of them is paying for the missing
    // index is the part worth knowing. It is the remedy that is per index.
    expect(h.text()).toContain('read_own:');
    expect(h.text()).toContain('update_own:');
  });

  it('says so plainly when there is nothing to report', async () => {
    const h = harness({ exposed: [], storedPolicies: [] });

    expect(await runPolicy(['lint'], h.write, PLAIN, h.host)).toBe('ok');
    expect(h.text()).toContain('Nothing to report');

    // ⚠️ And it does not promise more than it checked. No query planner runs here.
    expect(h.text()).toContain('can still be slow');
  });
});

describe('removing a table', () => {
  it('does nothing at all without --confirm', async () => {
    const h = harness();

    expect(await runPolicy(['rm', 'posts'], h.write, PLAIN, h.host)).toBe('usage');
    expect(h.sql().filter((sql) => sql.includes('DELETE'))).toHaveLength(0);
  });

  it('refuses an unconfirmed rm before it asks the network for anything', async () => {
    // The same ordering the document parse gets, and it was not here at first. Found
    // by running the command rather than by a test: the refusal arrived after two
    // round trips, so a reader who forgot the flag and whose login had expired was
    // told to log in, for a command that would not have deleted anything either way.
    //
    // Requests rather than statements. The lookup carries no SQL, so counting
    // statements passes whether or not the check comes first, which is exactly how
    // the sibling assertion above passed while this was still wrong.
    const h = harness();

    expect(await runPolicy(['rm', 'posts'], h.write, PLAIN, h.host)).toBe('usage');
    expect(h.requests()).toBe(0);
  });

  it('says the removal is not in force yet', async () => {
    // 🔴 `rm` is the largest narrowing the product has, and it was the one command
    // that did not say this. Measured against a real deployment on 2026-08-12: one
    // run was still serving the removed table 393 seconds after it reported success,
    // another stopped after 57, with nothing changed between them.
    const h = harness();

    expect(await runPolicy(['rm', 'posts', '--confirm'], h.write, PLAIN, h.host)).toBe('ok');
    expect(h.text()).toContain('rules just deleted');

    // ⚠️ Both halves, because either alone is a message that misleads. The window is
    // the engine's, and this command talks to whichever engine is deployed: naming
    // only the bound promises it on behalf of a deployment that may predate it, and
    // naming only the recycling hides that current deployments have an answer.
    expect(h.text()).toContain(`${Math.round(MAX_REGISTRY_AGE_MS / 1000)} seconds`);
    expect(h.text()).toContain('recycle');

    // The number and its unit on one line. A break between them reads as a truncated
    // sentence in a terminal, which is how the first version of it shipped.
    const line = h.lines.find((each) => each.includes('seconds'));
    expect(line).toMatch(/\d+ seconds/);
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
