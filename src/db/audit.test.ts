/**
 * The audit table, against a real D1 binding.
 *
 * Two things are worth running rather than reasoning about. The key column is
 * declared `INTEGER PRIMARY KEY NOT NULL`, and whether SQLite still fills a
 * rowid alias in when the column also carries NOT NULL is a question rules/01
 * section G1 does not answer: it measured the alias without the constraint. And
 * the table is STRICT, so what it refuses is part of what it is for.
 */

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  AUDIT_SCHEMA,
  type AuditEntry,
  appendAuditStatement,
  auditSubjectForRow,
} from './audit.js';
import { ENGINE_SCHEMA } from './bootstrap.js';
import { getCatalogue, isReservedTableName, resetCatalogue } from './introspect.js';

interface LogRow {
  readonly id: number;
  readonly at: number;
  readonly lane: string;
  readonly action: string;
  readonly subject: string;
  readonly detail: string | null;
}

async function reset(): Promise<void> {
  await env.DB.prepare('DROP TABLE IF EXISTS _audit_log').run();
  for (const statement of AUDIT_SCHEMA) {
    await env.DB.prepare(statement).run();
  }
}

async function append(entry: AuditEntry): Promise<void> {
  const statement = appendAuditStatement(entry);
  await env.DB.prepare(statement.sql)
    .bind(...statement.parameters)
    .run();
}

const EDIT: AuditEntry = {
  lane: 'bridge',
  action: 'row_edit',
  subject: 'posts[id=p_1]',
  detail: 'title',
};

beforeEach(reset);

describe('an entry', () => {
  it('gets an id without one being supplied, even though the key is NOT NULL', async () => {
    // The question this file exists for. `INTEGER PRIMARY KEY` is a rowid alias
    // and SQLite fills it; whether adding NOT NULL turns an omitted column into
    // a constraint failure is not something rules/01 G1 measured, and the answer
    // decides whether every caller has to carry a counter.
    await append(EDIT);
    await append({ ...EDIT, subject: 'posts[id=p_2]' });

    const rows = await env.DB.prepare(
      'SELECT id, subject FROM _audit_log ORDER BY id',
    ).all<LogRow>();
    expect(rows.results.map((row) => row.subject)).toEqual(['posts[id=p_1]', 'posts[id=p_2]']);
    expect(rows.results[0]?.id).toBeTypeOf('number');
    expect(rows.results[1]?.id).toBeGreaterThan(rows.results[0]?.id ?? 0);
  });

  it('takes its time from the database rather than from the caller', async () => {
    // A Worker's clock is frozen between I/O (rules/02 A2), and two lanes on two
    // machines have no reason to agree. unixepoch() is one clock for all of them.
    await append(EDIT);
    const row = await env.DB.prepare('SELECT at FROM _audit_log').first<LogRow>();
    expect(row?.at).toBeTypeOf('number');
    expect(row?.at).toBeGreaterThan(1_700_000_000);
  });

  it('keeps detail optional, since not every action names a column', async () => {
    await append({ lane: 'cli', action: 'policy_apply', subject: 'posts' });
    const row = await env.DB.prepare('SELECT detail FROM _audit_log').first<LogRow>();
    expect(row?.detail).toBeNull();
  });

  it('records the column that changed and never a value', async () => {
    // The trade written down in the module comment, asserted so that adding a
    // value column later has to break a test that says why it was left out.
    const statement = appendAuditStatement(EDIT);
    // The column list, spelled out rather than pattern-matched: the first
    // attempt here searched the whole statement for "value" and matched the
    // word VALUES, which is a test that fails for a reason that is not the one
    // it is about.
    expect(statement.sql).toContain('(at, lane, action, subject, detail)');
    expect(statement.sql).not.toContain('old_');
    expect(statement.sql).not.toContain('new_');
    expect(statement.parameters).toEqual(['bridge', 'row_edit', 'posts[id=p_1]', 'title']);
    expect(statement.parameters).toHaveLength(4);
  });
});

describe('what the table refuses', () => {
  it('refuses a row with no subject, because an entry naming nothing is not one', async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO _audit_log (at, lane, action, subject) VALUES (unixepoch(), 'cli', 'row_edit', NULL)",
      ).run(),
    ).rejects.toThrow();
  });

  it('refuses text where the time goes, because STRICT is on', async () => {
    // Not a formality: G8 measured that STRICT accepts a string that converts
    // without loss, so this asserts the case it does refuse rather than assuming
    // the declaration does more than it does.
    await expect(
      env.DB.prepare(
        "INSERT INTO _audit_log (at, lane, action, subject) VALUES ('not-a-time', 'cli', 'row_edit', 'posts')",
      ).run(),
    ).rejects.toThrow();
  });
});

describe('naming a row', () => {
  it('renders a single key the way both lanes will', () => {
    expect(auditSubjectForRow('posts', { id: 'p_1' })).toBe('posts[id=p_1]');
  });

  it('joins a composite key in the order it was given', () => {
    expect(auditSubjectForRow('memberships', { org_id: 'o_1', user_id: 'u_1' })).toBe(
      'memberships[org_id=o_1,user_id=u_1]',
    );
  });

  it('names the table alone when there is no row to name', () => {
    expect(auditSubjectForRow('posts', {})).toBe('posts');
  });
});

/**
 * The `_` prefix is the whole protection, so it gets asserted rather than assumed.
 *
 * Invariant I8 wants two independent refusals for an engine table, and this
 * table adds none of its own: it inherits them by being named this way. That is
 * the point of the convention, and it is also exactly the kind of inheritance
 * that is worth one test rather than a comment, because a table added to the
 * schema with an ordinary name would be exposed and nothing else would say so.
 */
describe('the table is not reachable from outside', () => {
  it('is refused by name, like every other engine table', () => {
    expect(isReservedTableName('_audit_log')).toBe(true);
  });

  it('is flagged in the catalogue as belonging to the engine', async () => {
    resetCatalogue();
    const catalogue = await getCatalogue(env.DB);
    // The second, independent layer: a route that trusted the flag rather than
    // the name still refuses it.
    expect(catalogue.tables.get('_audit_log')?.isSystem).toBe(true);
  });

  it('is in the schema the engine applies, so it exists without a migration', () => {
    expect(ENGINE_SCHEMA.some((statement) => statement.includes('_audit_log'))).toBe(true);
  });
});

describe('reading the log newest first is not a scan', () => {
  it('indexes the column the log is ordered by', async () => {
    // D1 bills rows scanned rather than rows returned (rules/01 section D), so
    // the index is a bill rather than a nicety, and which column it covers is
    // the whole of it.
    //
    // ⚠️ This test exists because a mutation survived. The sweep's first attempt
    // at breaking the index replaced the statement with an empty string, which
    // made every test in this file throw and looked like twelve tests were
    // watching it. Pointed at the wrong column instead, nothing noticed at all.
    const indexes = await env.DB.prepare('PRAGMA index_list(_audit_log)').all<{ name: string }>();
    const names = (indexes.results ?? []).map((row) => row.name);
    expect(names).toContain('_audit_log_at');

    const columns = await env.DB.prepare('PRAGMA index_info(_audit_log_at)').all<{
      name: string;
    }>();
    expect((columns.results ?? []).map((row) => row.name)).toEqual(['at']);
  });
});
