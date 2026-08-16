/**
 * Whether D1 will take PRAGMA statements inside `batch()`, and give their rows back.
 *
 * Building a catalogue costs about forty round trips today: one `PRAGMA table_list`,
 * then three PRAGMAs per table, plus one per index. Measured inside a deployed Worker
 * on 2026-08-16, a warm round trip is 5 to 11ms, and the catalogue's floor of 312ms is
 * that count multiplied by that latency. It is the one predictable part of a cold
 * request, so it is the part worth removing.
 *
 * ⚠️ `rules/01` §A confirms the four PRAGMAs work and confirms `batch()` works. It says
 * nothing about a batch that contains PRAGMAs, and this project has been wrong three
 * times about exactly that shape of inference: a thing that is true of each half and
 * assumed of the pair. So it is measured before anything is designed around it.
 *
 * ⚠️ And measured here means measured in **miniflare's** D1, not the real one. This
 * project keeps a record of the two disagreeing. A pass here is permission to run the
 * same probe against remote D1, not permission to ship.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

describe('a batch of PRAGMA statements', () => {
  beforeAll(async () => {
    await env.DB.prepare('DROP TABLE IF EXISTS pragma_batch_probe').run();
    await env.DB.prepare(
      'CREATE TABLE pragma_batch_probe (id TEXT PRIMARY KEY NOT NULL, n INTEGER NOT NULL)',
    ).run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS pragma_batch_probe_n ON pragma_batch_probe (n)',
    ).run();
  });

  it('is accepted at all, or says why not', async () => {
    // The question the whole idea rests on. Written to report the refusal rather than
    // to assert success, because a refusal here is the useful answer and an assertion
    // would hide its wording.
    let refusal: string | null = null;
    try {
      await env.DB.batch([env.DB.prepare('PRAGMA table_info(pragma_batch_probe)')]);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }

    console.log(`  batch of one PRAGMA: ${refusal === null ? 'ACCEPTED' : `REFUSED: ${refusal}`}`);
    expect(refusal).toBeNull();
  });

  it('gives back the rows of each statement, in order', async () => {
    // Acceptance is not enough. A batch that runs the PRAGMAs and returns nothing
    // useful would pass the test above and be worthless: the catalogue needs the rows.
    const results = await env.DB.batch<Record<string, unknown>>([
      env.DB.prepare('PRAGMA table_info(pragma_batch_probe)'),
      env.DB.prepare('PRAGMA index_list(pragma_batch_probe)'),
      env.DB.prepare('PRAGMA foreign_key_list(pragma_batch_probe)'),
    ]);

    const counts = results.map((each) => each.results.length);
    console.log(
      `  rows per statement: table_info=${counts[0]} index_list=${counts[1]} fk=${counts[2]}`,
    );

    // Two columns, and at least the one index. Asserted loosely on the index count
    // because SQLite adds its own for a primary key on some declarations, and this
    // probe is about the transport rather than about how many indexes exist.
    expect(counts[0]).toBe(2);
    expect(counts[1]).toBeGreaterThanOrEqual(1);
    expect(results[0]?.results[0]?.['name']).toBe('id');
  });

  it('mixes a PRAGMA with an ordinary statement in one batch', async () => {
    // The shape a real catalogue load would use: `table_list` first, then a PRAGMA per
    // table. If only an all-PRAGMA batch worked, the saving would be smaller and the
    // code would have to know that.
    const results = await env.DB.batch<Record<string, unknown>>([
      env.DB.prepare('SELECT 1 AS one'),
      env.DB.prepare('PRAGMA table_info(pragma_batch_probe)'),
    ]);

    expect(results[0]?.results[0]?.['one']).toBe(1);
    expect(results[1]?.results.length).toBe(2);
  });

  it('reports how many statements one batch will take', async () => {
    // Not a limit test, a size test. A catalogue for this database is about forty
    // statements, and a batch is one round trip only if the whole thing fits in one.
    const statements = Array.from({ length: 40 }, () =>
      env.DB.prepare('PRAGMA table_info(pragma_batch_probe)'),
    );

    const results = await env.DB.batch<Record<string, unknown>>(statements);

    console.log(`  batch of 40 PRAGMAs returned ${results.length} result sets`);
    expect(results).toHaveLength(40);
  });
});
