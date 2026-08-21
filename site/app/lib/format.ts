/**
 * Display formatting for real deployment data.
 *
 * Engine timestamps are INTEGER unix seconds (`unixepoch()`), so a raw row
 * renders `created_at: 1755772800` — correct and unreadable. And any TEXT
 * column can legally hold five hundred characters, which real data will do
 * the moment it exists. One place decides both questions so every surface
 * answers them the same way.
 */

/** Columns that carry unix-second timestamps, by the engine's own convention. */
const TIME_COLUMN = /(_at|_time)$/;

/** Unix seconds between 2001 and 2096 — outside this, a number is not a date. */
const EPOCH_MIN = 1_000_000_000;
const EPOCH_MAX = 4_000_000_000;

const MAX_CELL_CHARS = 140;

export interface CellText {
  /** What renders. Always bounded in length. */
  readonly text: string;
  /** Full value for the title attribute, when text is a shortening of it. */
  readonly title?: string;
}

function asEpochSeconds(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" && /^\d{10}$/.test(value) ? Number(value) : Number.NaN;
  return Number.isInteger(numeric) && numeric >= EPOCH_MIN && numeric <= EPOCH_MAX ? numeric : null;
}

/**
 * One cell of a real row: local time for timestamp columns with the ISO
 * instant as the title, and a hard length cap for everything else.
 */
export function formatCell(column: string, value: unknown): CellText {
  if (value === null || value === undefined) return { text: "null" };

  if (TIME_COLUMN.test(column)) {
    const seconds = asEpochSeconds(value);
    if (seconds !== null) {
      const instant = new Date(seconds * 1000);
      return {
        text: instant.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
        title: instant.toISOString(),
      };
    }
  }

  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  return raw.length > MAX_CELL_CHARS ? { text: `${raw.slice(0, MAX_CELL_CHARS)}…`, title: raw } : { text: raw };
}
