/**
 * The operator's row edit: one column of one row, swapped only if it has not moved.
 *
 * The statement half of the bridge's edit lane, kept apart from the route the
 * same way `browse.ts` is, so a test can hold the exact SQL. The page sends a
 * table, a primary key, a column, the value it saw and the value it wants.
 * Never SQL, and never a `WHERE` of its own.
 *
 * ## What this lane is, and why the shape is this narrow
 *
 * The same operator view `browse.ts` describes: the operator's own credential,
 * no policy applied, the trust of `wrangler d1 execute` on their machine. That
 * argument is bounded for a read, because an operator can already see anything
 * they browse. It is *not* bounded for a write. D1 has no interactive
 * transaction and Time Travel restores a whole database rather than a row, so a
 * wrong write here has no small undo. The bridge already learned this the
 * expensive way once: a probe mangled by a shell overwrote four live policy
 * documents through `/apply`, answered 200, and was noticed by accident.
 *
 * So the blast radius is made small by what can be *said*, not by what is
 * checked:
 *
 *   - **One row, addressed by its primary key.** No filter reaches this file, so
 *     "update every row" is not a thing a caller can express. A table with no
 *     declared key is refused, because there is no way to name one of its rows;
 *     `rowid` is not a substitute, since VACUUM moves it.
 *   - **One column per call, and never a key column.** Changing a key is moving
 *     a row, which is a different operation with different consequences, and it
 *     is not this one.
 *   - **Compare and swap.** The old value the operator saw goes into the WHERE.
 *     If somebody else changed it first, nothing is written and the caller is
 *     told, which is the only concurrency answer available without a
 *     transaction to hold. Measured on D1: rules/01 section G16.
 *   - **Engine tables refused twice**, by name and by the catalogue's own flag,
 *     exactly as browsing refuses them. Invariant I8 wants two layers that do
 *     not share a failure.
 *
 * ## The value, and what it is allowed to be
 *
 * A browser text field produces a string for everything. A STRICT table would
 * refuse a string for an INTEGER column (rules/01 section G8 measured that it
 * accepts one that converts without loss, and refuses one that does not), but a
 * table that is not STRICT applies affinity and stores whatever it can make of
 * it. So the value arrives typed as JSON and is checked against the column's
 * declared type here, before D1 is asked, rather than relying on the table to
 * have been declared carefully.
 */

import type { Catalogue, ColumnInfo } from '../src/db/introspect.js';
import { isReservedTableName } from '../src/db/introspect.js';

/** What a caller may send as a cell value. Anything else is not a cell. */
export type CellValue = string | number | boolean | null;

export interface EditRequest {
  readonly table: string;
  /** Every primary key column of the row, by name. All of them, or none will do. */
  readonly key: Readonly<Record<string, CellValue>>;
  readonly column: string;
  /** What the operator saw. Written into the WHERE, never into the SET. */
  readonly expected: CellValue;
  readonly next: CellValue;
}

export type EditPlan =
  | { readonly ok: true; readonly sql: string; readonly parameters: readonly CellValue[] }
  | { readonly ok: false; readonly refusal: string };

const ENGINE_TABLE_REFUSAL =
  'Engine tables are not editable here. Change them with the CLI on your machine.';

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function refuse(refusal: string): EditPlan {
  return { ok: false, refusal };
}

/**
 * Whether a value may go in this column at all.
 *
 * Declared type rather than affinity rules, and deliberately narrow: the point
 * is that a value typed into a browser cannot arrive somewhere it changes shape
 * on the way in. A column with no declared type takes anything, because the
 * schema said nothing to hold it to.
 */
function valueFitsColumn(column: ColumnInfo, value: CellValue): string | null {
  if (value === null) {
    return column.notNull ? `"${column.name}" cannot be null.` : null;
  }

  const declared = column.type.toUpperCase();
  if (declared === '') return null;

  // SQLite type names are matched the way affinity is: by what the declaration
  // contains. TEXT, VARCHAR(20) and CHARACTER all mean text.
  if (declared.includes('INT')) {
    return Number.isInteger(value) ? null : `"${column.name}" holds whole numbers.`;
  }
  if (declared.includes('REAL') || declared.includes('FLOA') || declared.includes('DOUB')) {
    return typeof value === 'number' && Number.isFinite(value)
      ? null
      : `"${column.name}" holds numbers.`;
  }
  if (declared.includes('CHAR') || declared.includes('CLOB') || declared.includes('TEXT')) {
    return typeof value === 'string' ? null : `"${column.name}" holds text.`;
  }
  if (declared.includes('BLOB')) {
    // The bridge has no way to carry bytes from a text field, and pretending a
    // string is a blob is how a column quietly stops holding what it held.
    return `"${column.name}" holds binary data, which cannot be edited here.`;
  }
  // ANY in a STRICT table, or a name SQLite gives NUMERIC affinity. Left open
  // rather than guessed at.
  return null;
}

/**
 * The statement for one edit, or the reason there is not one.
 *
 * Every identifier comes from the catalogue's own spelling and every value is a
 * bound parameter, so nothing a caller sends is ever concatenated. DQS is on
 * (rules/00 I6), which means a misspelled identifier would come back as a
 * string instead of an error, so names are matched character for character
 * against the catalogue rather than checked for shape.
 */
export function editStatement(catalogue: Catalogue, request: EditRequest): EditPlan {
  if (isReservedTableName(request.table)) return refuse(ENGINE_TABLE_REFUSAL);

  const info = catalogue.tables.get(request.table);
  if (info === undefined) return refuse('No table with this name.');
  // The second, independent layer of I8, the same pairing browsing uses.
  if (info.isSystem) return refuse(ENGINE_TABLE_REFUSAL);

  const keyColumns = [...info.columns.values()].filter((column) => column.primaryKey);
  if (keyColumns.length === 0) {
    return refuse(
      'This table declares no primary key, so there is no way to name one of its rows. ' +
        'Editing needs a key; rowid is not one, because it moves when the database is ' +
        'vacuumed.',
    );
  }

  const target = info.columns.get(request.column);
  if (target === undefined) return refuse('No column with this name on this table.');
  if (target.primaryKey) {
    return refuse(
      `"${request.column}" is part of the primary key. Changing a key moves the row rather ` +
        'than editing it, which is a different operation and not this one.',
    );
  }

  // Every key column, and only key columns. A partial key would address more
  // than one row on a composite key, which is the one way this lane could touch
  // something the operator did not point at.
  const provided = Object.keys(request.key);
  const expectedNames = keyColumns.map((column) => column.name);
  const missing = expectedNames.filter((name) => !Object.hasOwn(request.key, name));
  const extra = provided.filter((name) => !expectedNames.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    return refuse(
      `The row has to be named by its whole primary key: ${expectedNames.join(', ')}.` +
        (missing.length > 0 ? ` Missing ${missing.join(', ')}.` : '') +
        (extra.length > 0 ? ` Not a key column: ${extra.join(', ')}.` : ''),
    );
  }

  const badNext = valueFitsColumn(target, request.next);
  if (badNext !== null) return refuse(badNext);

  for (const column of keyColumns) {
    const value = request.key[column.name] as CellValue;
    if (value === null) return refuse(`"${column.name}" is part of the key and cannot be null.`);
  }

  // `IS`, not `=`. `col = NULL` is NULL rather than true, so an equality here
  // would never match a column that is currently null and every such edit would
  // be reported as somebody else's concurrent change. Measured: rules/01 G16.
  const where = [
    ...expectedNames.map((name, index) => `${quote(name)} = ?${index + 2}`),
    `${quote(target.name)} IS ?${expectedNames.length + 2}`,
  ].join(' AND ');

  // RETURNING carries the post-image back, which is what the panel redraws from.
  // An empty result means the compare failed, and the caller is told that rather
  // than being shown a value nothing wrote.
  const returning = [...info.columns.keys()].map(quote).join(', ');

  return {
    ok: true,
    sql:
      `UPDATE ${quote(info.name)} SET ${quote(target.name)} = ?1 WHERE ${where} ` +
      `RETURNING ${returning}`,
    parameters: [
      request.next,
      ...expectedNames.map((name) => request.key[name] as CellValue),
      request.expected,
    ],
  };
}
