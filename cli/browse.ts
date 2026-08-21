/**
 * The operator's row browse: one page of one application table, newest first.
 *
 * This is the statement half of the bridge's `/rows` lane, kept apart from the
 * route so a test can hold the exact SQL. The page sends a table name and an
 * offset, never SQL; everything that reaches the statement is either resolved
 * through the catalogue or bound as a parameter.
 *
 * ## What this lane is, said plainly
 *
 * An operator view. It reads with the operator's own credential and applies no
 * policy, which is the same trust as `wrangler d1 execute` on their machine,
 * behind the same session key as every other bridge verb. That is the point:
 * the Tables screen answers "did my data land", including on a table nobody
 * has exposed yet, which is exactly the table the policy engine (correctly)
 * refuses to discuss. What a caller would see remains the simulator's
 * question, and the UI says so on the panel.
 *
 * ## The three refusals, and why each is shaped the way it is
 *
 *   - **Engine tables are refused, twice.** `isReservedTableName` answers from
 *     the name alone, and the catalogue's `isSystem` flag is checked as well:
 *     invariant I8 wants layers that do not share a failure. `account` holds
 *     provider tokens and `jwks` holds signing keys; a browser tab is where
 *     screenshots happen. The CLI is the deliberate path to those.
 *   - **An unknown table is refused by exact match.** DQS is on (rules/00 I6),
 *     so a misspelled identifier inside a statement would come back as a
 *     string, not an error. The name is matched character for character
 *     against the catalogue and the statement is built from the catalogue's
 *     own spelling, never the caller's.
 *   - **A deep offset is refused with the reason.** OFFSET on D1 scans every
 *     row it skips, and rows_read is what D1 bills (rules/01 D). The ceiling
 *     keeps one request at or under MAX_BROWSE_SCAN scanned rows, and the
 *     refusal says that instead of pretending the page does not exist.
 *
 * ## Newest first
 *
 * Ordinary tables are ordered by `rowid DESC`, which is insertion order and
 * therefore the page an operator who just seeded wants to see. The identifier
 * is deliberately bare: double-quoting it would turn it into a string literal
 * on a WITHOUT ROWID table under DQS, and ORDER BY a constant silently sorts
 * nothing. Bare, it errs loudly if the flag below is ever wrong. WITHOUT
 * ROWID tables (catalogue `withoutRowid`, measured from PRAGMA table_list)
 * have no rowid, so they order by their primary key descending, which SQLite
 * requires them to declare.
 */

import type { Catalogue } from '../src/db/introspect.js';
import { isReservedTableName } from '../src/db/introspect.js';

/** Rows per page. Display-sized, the same reasoning as the simulator's ROW_LIMIT. */
export const BROWSE_PAGE_SIZE = 50;

/** The most rows one request may cost, counting the rows OFFSET skips. */
export const MAX_BROWSE_SCAN = 1_000;

export const MAX_BROWSE_OFFSET = MAX_BROWSE_SCAN - BROWSE_PAGE_SIZE;

export type BrowsePlan =
  | { readonly ok: true; readonly sql: string; readonly parameters: readonly number[] }
  | { readonly ok: false; readonly refusal: string };

const ENGINE_TABLE_REFUSAL =
  'Engine tables are not browsable here. Read them with the CLI on your machine.';

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function browseStatement(catalogue: Catalogue, table: string, offset: number): BrowsePlan {
  if (!Number.isInteger(offset) || offset < 0) {
    return { ok: false, refusal: 'The offset has to be a whole number of rows, zero or more.' };
  }
  if (offset > MAX_BROWSE_OFFSET) {
    return {
      ok: false,
      refusal:
        `Browsing stops after ${MAX_BROWSE_SCAN} rows: a deeper page pays to scan every row ` +
        'before it, and rows read is what D1 bills. Narrow it with a query instead.',
    };
  }

  if (isReservedTableName(table)) {
    return { ok: false, refusal: ENGINE_TABLE_REFUSAL };
  }

  const info = catalogue.tables.get(table);
  if (info === undefined) {
    return { ok: false, refusal: 'No table with this name.' };
  }
  // The second, independent layer of I8: a catalogue entry flagged as the
  // engine's is refused even if the name check above ever drifts.
  if (info.isSystem) {
    return { ok: false, refusal: ENGINE_TABLE_REFUSAL };
  }

  const columns = [...info.columns.keys()].map(quote).join(', ');

  const keyColumns = [...info.columns.values()]
    .filter((column) => column.primaryKey)
    .map((column) => `${quote(column.name)} DESC`);
  // SQLite requires a WITHOUT ROWID table to declare a primary key, so the
  // empty branch is unreachable on a real table; an unordered page beats a
  // statement that does not parse if a catalogue ever disagrees.
  const order = info.withoutRowid
    ? keyColumns.length === 0
      ? ''
      : ` ORDER BY ${keyColumns.join(', ')}`
    : ' ORDER BY rowid DESC';

  return {
    ok: true,
    sql: `SELECT ${columns} FROM ${quote(info.name)}${order} LIMIT ? OFFSET ?`,
    parameters: [BROWSE_PAGE_SIZE, offset],
  };
}
