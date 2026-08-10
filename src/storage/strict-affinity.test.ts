/**
 * What a STRICT table does with a TEXT value in an INTEGER column.
 *
 * `rules/01` §G7 records that `strftime('%s','now')` returns TEXT while
 * `unixepoch()` returns INTEGER, and reads as though the first is therefore the
 * wrong type for an INTEGER column in a STRICT table. A mutation that swapped one
 * for the other survived the suite, so either the note is stronger than the truth
 * or a test is weaker than it looks. Measured here rather than argued about.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

describe('a STRICT INTEGER column', () => {
  beforeAll(async () => {
    await env.DB.prepare('DROP TABLE IF EXISTS strict_affinity_probe').run();
    await env.DB.prepare(
      'CREATE TABLE strict_affinity_probe (id TEXT PRIMARY KEY NOT NULL, n INTEGER NOT NULL) STRICT',
    ).run();
  });

  it('accepts unixepoch(), which is what the engine uses', async () => {
    await env.DB.prepare("INSERT INTO strict_affinity_probe VALUES ('epoch', unixepoch())").run();
    const row = await env.DB.prepare(
      "SELECT n, typeof(n) AS t FROM strict_affinity_probe WHERE id = 'epoch'",
    ).first<{ n: number; t: string }>();

    console.log(`  unixepoch() stored as typeof=${row?.t}`);
    expect(row?.t).toBe('integer');
  });

  it("records what happens with strftime('%s','now'), which returns TEXT", async () => {
    let error = '';
    let stored = '';
    try {
      await env.DB.prepare(
        "INSERT INTO strict_affinity_probe VALUES ('strftime', strftime('%s','now'))",
      ).run();
      const row = await env.DB.prepare(
        "SELECT typeof(n) AS t FROM strict_affinity_probe WHERE id = 'strftime'",
      ).first<{ t: string }>();
      stored = row?.t ?? 'missing';
    } catch (cause) {
      error = (cause as Error).message;
    }

    console.log(
      `  strftime('%s','now') -> ${error === '' ? `stored as typeof=${stored}` : `REFUSED: ${error}`}`,
    );

    // Recorded rather than asserted one way. Either outcome is a fact worth having
    // written down, and which one it is decides whether rules/01 §G7 needs
    // correcting.
    expect(error !== '' || stored !== '').toBe(true);
  });

  it('records what happens with a TEXT value that is not a number at all', async () => {
    let error = '';
    try {
      await env.DB.prepare(
        "INSERT INTO strict_affinity_probe VALUES ('word', 'not-a-number')",
      ).run();
    } catch (cause) {
      error = (cause as Error).message;
    }

    console.log(`  'not-a-number' -> ${error === '' ? 'ACCEPTED' : `refused: ${error}`}`);
    expect(error).not.toBe('');
  });
});
