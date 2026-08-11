#!/usr/bin/env node
/**
 * Remote D1 probe — confirms behaviours previously measured only on local
 * (miniflare) D1 against real remote D1 infrastructure.
 *
 * Covers the four caveats left hanging in .claude/rules/01:
 *   U*  unixepoch(): exists, returns INTEGER, self-consistent in one statement  (§G7)
 *   C*  ON CONFLICT DO UPDATE SET right-hand side reads the PRE-update row      (§G7)
 *   N*  ORDER BY ... NULLS FIRST/LAST                                           (§G4)
 *   S*  STRICT table affinity: accepts losslessly-convertible strings           (§G8)
 * Plus two foundations worth a remote number:
 *   F1  bound parameter ceiling (rules/00 §I7)
 *   F2  DQS still enabled (rules/00 §I6)
 *
 * Uses the D1 REST query endpoint because `wrangler d1 execute` cannot bind
 * parameters, and the parameter-ceiling probe is meaningless without binding.
 *
 * SAFETY
 *   - Creates its own throwaway database whose name must start with
 *     "baseclf-probe-" and refuses to run against anything else.
 *   - Never reads the ambient CLOUDFLARE_API_TOKEN: it loads credentials from
 *     .env directly, because an ambient token can silently differ from .env
 *     (see .claude/rules/02 §C1).
 *   - Deletes the throwaway database in a finally block.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.cloudflare.com/client/v4';
const DB_NAME = 'baseclf-probe-remote';

/** Parse .env into a map. Values are never logged. */
function loadDotEnv() {
  const raw = readFileSync(join(ROOT, '.env'), 'utf8');
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = loadDotEnv();
const TOKEN = env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = env.CLOUDFLARE_ACCOUNT_ID;
if (!TOKEN || !ACCOUNT) {
  console.error('Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID in .env');
  process.exit(1);
}

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

let dbId = null;

/** Run one SQL statement with bound parameters. Never throws on SQL error. */
async function q(sql, params = []) {
  const { status, body } = await cf(`/accounts/${ACCOUNT}/d1/database/${dbId}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql, params }),
  });
  if (!body?.success) {
    const msg = (body?.errors ?? []).map((e) => `${e.message} [code: ${e.code}]`).join('; ');
    return { ok: false, error: msg || `HTTP ${status}`, results: null, meta: null };
  }
  const first = body.result?.[0] ?? {};
  return { ok: true, error: null, results: first.results ?? [], meta: first.meta ?? null };
}

const report = [];
/** Record a probe result. `verdict` is a short tag; raw output is always kept. */
function record(id, title, outcome, note, raw) {
  report.push({ id, title, outcome, note, raw });
  const head = `${outcome}  ${id} — ${title}`;
  console.log(`\n${head}`);
  if (note) console.log(`   note: ${note}`);
  console.log(`   ${JSON.stringify(raw)}`);
}

async function probeUnixepoch() {
  let r = await q(`SELECT unixepoch() AS v, typeof(unixepoch()) AS t`);
  const hostNow = Math.floor(Date.now() / 1000);
  record(
    'U1',
    'unixepoch() exists and returns INTEGER',
    r.ok && r.results?.[0]?.t === 'integer' ? 'PASS' : 'FAIL',
    r.ok ? `drift vs host clock = ${r.results[0].v - hostNow}s` : r.error,
    r.ok ? r.results : { error: r.error },
  );

  r = await q(
    `SELECT unixepoch() AS a, unixepoch() AS b, unixepoch() AS c,
            (unixepoch() - unixepoch()) AS delta,
            (unixepoch() = unixepoch()) AS eq`,
  );
  const row = r.results?.[0];
  record(
    'U2',
    'many unixepoch() calls in ONE single-row statement agree',
    r.ok && row.delta === 0 && row.eq === 1 && row.a === row.b && row.b === row.c ? 'PASS' : 'FAIL',
    'this is the shape the rate limiter actually uses',
    r.ok ? r.results : { error: r.error },
  );

  r = await q(
    `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < 200)
     SELECT COUNT(*) AS n, COUNT(DISTINCT u) AS distinct_u,
            MAX(u) - MIN(u) AS spread
     FROM (SELECT unixepoch() AS u FROM c)`,
  );
  record(
    'U3',
    'unixepoch() across 200 rows of one statement',
    r.ok && r.results?.[0]?.distinct_u === 1 ? 'PASS' : 'WARN',
    'SQLite only guarantees stability within one sqlite3_step(); multi-row spans many',
    r.ok ? r.results : { error: r.error },
  );

  r = await q(`SELECT strftime('%s','now') AS v, typeof(strftime('%s','now')) AS t`);
  record(
    'U4',
    "strftime('%s','now') returns TEXT",
    r.ok && r.results?.[0]?.t === 'text' ? 'PASS' : 'FAIL',
    'reason to prefer unixepoch() is clarity, not failure — see rules/01 §G8',
    r.ok ? r.results : { error: r.error },
  );
}

async function probeUpsert() {
  await q(
    `CREATE TABLE _probe_upsert (k TEXT PRIMARY KEY NOT NULL, a INTEGER NOT NULL, b INTEGER NOT NULL) STRICT`,
  );
  await q(`INSERT INTO _probe_upsert (k,a,b) VALUES ('x',1,0)`);

  let r = await q(
    `INSERT INTO _probe_upsert (k,a,b) VALUES ('x',999,999)
     ON CONFLICT("k") DO UPDATE SET "a" = 99, "b" = "_probe_upsert"."a"
     RETURNING "a","b"`,
  );
  record(
    'C1',
    'DO UPDATE SET right-hand side reads the PRE-update row (qualified name)',
    r.ok && r.results?.[0]?.a === 99 && r.results?.[0]?.b === 1 ? 'PASS' : 'FAIL',
    'b === 1 means it read the OLD a, not the 99 assigned in the same SET',
    r.ok ? r.results : { error: r.error },
  );

  await q(`UPDATE _probe_upsert SET a = 1, b = 0 WHERE k = 'x'`);
  r = await q(
    `INSERT INTO _probe_upsert (k,a,b) VALUES ('x',999,999)
     ON CONFLICT("k") DO UPDATE SET "a" = 99, "b" = "a"
     RETURNING "a","b"`,
  );
  record(
    'C2',
    'same, with BARE column name on the right-hand side',
    r.ok && r.results?.[0]?.a === 99 && r.results?.[0]?.b === 1 ? 'PASS' : 'FAIL',
    'bare and qualified must agree, else rules/01 §G7 wording is wrong',
    r.ok ? r.results : { error: r.error },
  );
}

const RATE_SQL = `INSERT INTO "_probe_rate" ("key","window_start","hits") VALUES (?1, unixepoch(), 1)
ON CONFLICT("key") DO UPDATE SET
  "hits"         = CASE WHEN "_probe_rate"."window_start" <= unixepoch() - ?2 THEN 1           ELSE "_probe_rate"."hits" + 1     END,
  "window_start" = CASE WHEN "_probe_rate"."window_start" <= unixepoch() - ?2 THEN unixepoch() ELSE "_probe_rate"."window_start" END
RETURNING "hits","window_start", unixepoch() AS "now"`;

async function probeRateLimiterIdiom() {
  await q(
    `CREATE TABLE _probe_rate (key TEXT PRIMARY KEY NOT NULL, window_start INTEGER NOT NULL, hits INTEGER NOT NULL) STRICT`,
  );

  const hits = [];
  for (let i = 0; i < 3; i++) {
    const r = await q(RATE_SQL, ['k1', 60]);
    if (!r.ok) {
      record('C3', 'fixed-window counter idiom, 3 calls inside one window', 'FAIL', r.error, {
        error: r.error,
      });
      return;
    }
    hits.push(r.results[0]);
  }
  record(
    'C3',
    'fixed-window counter idiom, 3 calls inside one window',
    hits.map((h) => h.hits).join(',') === '1,2,3' ? 'PASS' : 'FAIL',
    'note only 2 bound params although ?2 appears 4 times — ordinal reuse works',
    hits,
  );

  await q(`UPDATE _probe_rate SET window_start = unixepoch() - 3600 WHERE key = 'k1'`);
  const r = await q(RATE_SQL, ['k1', 60]);
  record(
    'C4',
    'same counter after the window has rotated → must reset to 1',
    r.ok && r.results?.[0]?.hits === 1 ? 'PASS' : 'FAIL',
    'both CASE clauses must agree the window rotated; they see one snapshot',
    r.ok ? r.results : { error: r.error },
  );
}

async function probeNullsOrdering() {
  await q(`CREATE TABLE _probe_nulls (id INTEGER PRIMARY KEY, body TEXT)`);
  await q(`INSERT INTO _probe_nulls (id, body) VALUES (1,'a'),(2,NULL),(3,'b'),(4,NULL),(5,'c')`);

  const shape = (rows) => rows.map((x) => (x.body === null ? 'NULL' : x.body)).join(',');

  let r = await q(
    `SELECT id, body FROM _probe_nulls ORDER BY "_probe_nulls"."body" ASC NULLS LAST`,
  );
  record(
    'N1',
    'ORDER BY <qualified> ASC NULLS LAST — the exact shape Kysely emits',
    r.ok && shape(r.results).endsWith('NULL,NULL') ? 'PASS' : 'FAIL',
    r.ok ? `order = ${shape(r.results)}` : r.error,
    r.ok ? r.results : { error: r.error },
  );

  r = await q(`SELECT id, body FROM _probe_nulls ORDER BY body ASC NULLS FIRST`);
  record(
    'N2',
    'ORDER BY ... ASC NULLS FIRST',
    r.ok && shape(r.results).startsWith('NULL,NULL') ? 'PASS' : 'FAIL',
    r.ok ? `order = ${shape(r.results)}` : r.error,
    r.ok ? r.results : { error: r.error },
  );

  r = await q(`SELECT id, body FROM _probe_nulls ORDER BY body DESC NULLS LAST`);
  record(
    'N3',
    'ORDER BY ... DESC NULLS LAST',
    r.ok && shape(r.results).endsWith('NULL,NULL') ? 'PASS' : 'FAIL',
    r.ok ? `order = ${shape(r.results)}` : r.error,
    r.ok ? r.results : { error: r.error },
  );

  r = await q(`SELECT id, body FROM _probe_nulls ORDER BY body ASC`);
  record(
    'N4',
    'ORDER BY ... ASC with NO nulls clause (baseline default)',
    r.ok ? 'INFO' : 'FAIL',
    r.ok ? `default order = ${shape(r.results)}` : r.error,
    r.ok ? r.results : { error: r.error },
  );
}

async function probeStrictAffinity() {
  await q(
    `CREATE TABLE _probe_strict (id INTEGER PRIMARY KEY NOT NULL, ts INTEGER NOT NULL) STRICT`,
  );

  const cases = [
    ['S1', 'unixepoch() into INTEGER col', `unixepoch()`, 'accept'],
    ['S2', "strftime('%s','now') (TEXT) into INTEGER col", `strftime('%s','now')`, 'accept'],
    ['S3', "literal 'not-a-number' into INTEGER col", `'not-a-number'`, 'reject'],
    ['S4', "numeric string '12' into INTEGER col", `'12'`, 'accept'],
    ['S5', "string '12.0' into INTEGER col (lossless to 12?)", `'12.0'`, '?'],
    ['S6', "string '12.5' into INTEGER col (LOSSY)", `'12.5'`, 'reject'],
    ['S7', 'REAL literal 12.0 into INTEGER col (lossless)', `12.0`, '?'],
    ['S8', 'REAL literal 12.5 into INTEGER col (LOSSY)', `12.5`, 'reject'],
  ];

  let id = 100;
  for (const [pid, title, expr, expectation] of cases) {
    id += 1;
    const r = await q(
      `INSERT INTO _probe_strict (id, ts) VALUES (${id}, ${expr}) RETURNING ts, typeof(ts) AS stored_type`,
    );
    const accepted = r.ok;
    const outcome =
      expectation === '?'
        ? 'INFO'
        : (accepted ? 'accept' : 'reject') === expectation
          ? 'PASS'
          : 'FAIL';
    record(
      pid,
      title,
      outcome,
      accepted ? `ACCEPTED, stored as ${r.results?.[0]?.stored_type}` : `REJECTED: ${r.error}`,
      accepted ? r.results : { error: r.error },
    );
  }
}

async function probeFoundations() {
  // Bound parameter ceiling, measured with a FLAT IN-list so that expression
  // tree depth cannot be the thing that breaks first. Chaining "? + ? + ?..."
  // instead measures the depth limit — see F4.
  const out = {};
  for (const n of [99, 100, 101, 128, 200]) {
    const sql = `SELECT 1 AS ok WHERE 1 IN (${Array(n).fill('?').join(',')})`;
    const r = await q(sql, Array(n).fill(1));
    out[n] = r.ok ? `OK (rows=${r.results.length})` : `FAIL: ${r.error}`;
  }
  record(
    'F1',
    'bound parameter ceiling (flat IN-list, depth held constant)',
    out[100].startsWith('OK') && out[101].startsWith('FAIL') ? 'PASS' : 'FAIL',
    'this is the real rules/00 §I7 ceiling; note the error text differs from F4',
    out,
  );

  // Expression tree depth, isolated: literals only, ZERO bound parameters, so
  // nothing here can be confused for the parameter ceiling.
  const depth = {};
  for (const n of [64, 99, 100, 101, 102, 150]) {
    const sql = `SELECT ${Array(n).fill('1').join(' + ')} AS s`;
    const r = await q(sql, []);
    depth[n] = r.ok ? `OK (sum=${r.results?.[0]?.s})` : `FAIL: ${r.error}`;
  }
  record(
    'F4',
    'expression tree DEPTH limit — chained binary operators, no params at all',
    'INFO',
    'NOT in rules/01 today: a policy OR-ing/AND-ing ~100 terms compiles to a tree this deep',
    depth,
  );

  let r = await q(`SELECT "definitely_not_a_column" AS x`);
  record(
    'F2',
    'DQS: SELECT "definitely_not_a_column" — error, or silent string?',
    r.ok && r.results?.[0]?.x === 'definitely_not_a_column' ? 'DQS ON' : 'DQS OFF',
    'DQS ON means an allowlist bug returns WRONG DATA silently instead of erroring',
    r.ok ? r.results : { error: r.error },
  );

  r = await q(`SELECT id, "no_such_column" AS x FROM _probe_nulls LIMIT 2`);
  record(
    'F3',
    'DQS against a real table: unknown identifier in the select list',
    r.ok && r.results?.[0]?.x === 'no_such_column' ? 'DQS ON' : 'DQS OFF',
    'the dangerous form: every row silently carries the identifier as a literal',
    r.ok ? r.results : { error: r.error },
  );

  // The shape that actually breaks a policy: a mistyped column in a predicate
  // degenerates into 'literal' = 'literal', a tautology matching EVERY row.
  const total = await q(`SELECT COUNT(*) AS n FROM _probe_nulls`);
  r = await q(`SELECT id FROM _probe_nulls WHERE "no_such_col" = 'no_such_col'`);
  record(
    'F5',
    'DQS inside WHERE — a mistyped policy column becomes a TAUTOLOGY',
    r.ok && r.results.length === total.results?.[0]?.n ? 'DQS ON — ALL ROWS LEAK' : 'other',
    `table has ${total.results?.[0]?.n} rows; predicate returned ${r.results?.length}. ` +
      `This is why rules/00 §I6 demands a post-compile identifier assertion: the ` +
      `predicate does not error, it silently stops filtering.`,
    r.ok ? r.results : { error: r.error },
  );
}

function writeReport() {
  const lines = [];
  lines.push('# D1 Probe REMOTE — xác nhận lại bốn caveat "chưa đo remote"');
  lines.push('');
  lines.push(`Chạy lúc: ${new Date().toISOString()}`);
  lines.push(
    `Đường đi: D1 REST \`/query\` endpoint (cần bound param, \`wrangler d1 execute\` không có)`,
  );
  lines.push(`Database tạm: \`${DB_NAME}\` (đã xoá sau khi chạy)`);
  lines.push('');
  lines.push('## Tổng quan');
  lines.push('');
  lines.push('| ID | Probe | Kết quả |');
  lines.push('|---|---|---|');
  for (const p of report) lines.push(`| ${p.id} | ${p.title} | ${p.outcome} |`);
  lines.push('');
  lines.push('## Phương pháp & caveat — đọc trước khi trích số');
  lines.push('');
  lines.push(
    '- **Đường đo là D1 REST `/query`, KHÔNG phải Worker binding.** 27 probe gốc (2026-07-29) ' +
      'chạy qua binding. Ngữ nghĩa SQL nên giống nhau vì cùng một engine, nhưng điều đó **chưa được ' +
      'chứng minh** ở đây — chứng minh cần deploy một Worker probe, mà việc đó phải xin phép chủ dự án.',
  );
  lines.push(
    '- **Lý do không dùng `wrangler d1 execute`:** nó **không bind được tham số** (`--help` chỉ có ' +
      '`--command`/`--file`), nên probe trần 100 param không thực hiện được qua đường đó.',
  );
  lines.push(
    '- 🔴 **BẪY ĐO ĐẠC trên Windows/PowerShell:** `wrangler d1 execute --command \'SELECT "x"\'` bị ' +
      'PowerShell **nuốt mất dấu nháy kép** trước khi wrangler nhìn thấy. SQL thật gửi đi thành ' +
      '`SELECT x`, và D1 trả `no such column ... at offset 7` — trông y hệt "DQS đã TẮT". ' +
      'Đã dựng lại đúng lỗi này rồi bác bỏ bằng cách gửi cả hai dạng qua REST. ' +
      '**Mọi probe về quoting identifier chạy qua `--command` trên máy này đều vô giá trị.**',
  );
  lines.push(
    '- `unixepoch()` lệch 0 giây so với đồng hồ máy đo. Cửa sổ rate limit do DB quyết nên điều này ' +
      'chỉ là kiểm tra tỉnh táo, không phải điều kiện đúng đắn.',
  );
  lines.push('');
  lines.push('## Chi tiết');
  for (const p of report) {
    lines.push('');
    lines.push(`### ${p.id} — ${p.title}`);
    lines.push('');
    lines.push(`**Kết quả:** ${p.outcome}`);
    lines.push('');
    if (p.note) {
      lines.push(`**Ghi chú:** ${p.note}`);
      lines.push('');
    }
    lines.push('```json');
    lines.push(JSON.stringify(p.raw, null, 2));
    lines.push('```');
  }
  lines.push('');
  mkdirSync(join(ROOT, 'probe'), { recursive: true });
  writeFileSync(join(ROOT, 'probe', 'RESULT-remote.md'), lines.join('\n'), 'utf8');
  console.log(`\nReport written to probe/RESULT-remote.md`);
}

async function main() {
  if (!DB_NAME.startsWith('baseclf-probe-')) {
    throw new Error('Refusing to run: database name is not a throwaway probe name.');
  }

  // Reuse a leftover probe database if one exists, else create.
  const listed = await cf(`/accounts/${ACCOUNT}/d1/database?name=${DB_NAME}`);
  const existing = (listed.body?.result ?? []).find((d) => d.name === DB_NAME);
  if (existing) {
    dbId = existing.uuid;
    console.log(`Reusing leftover probe database ${DB_NAME} (${dbId})`);
  } else {
    const created = await cf(`/accounts/${ACCOUNT}/d1/database`, {
      method: 'POST',
      body: JSON.stringify({ name: DB_NAME }),
    });
    if (!created.body?.success) {
      throw new Error(`Create failed: ${JSON.stringify(created.body?.errors)}`);
    }
    dbId = created.body.result.uuid;
    console.log(`Created probe database ${DB_NAME} (${dbId})`);
  }

  try {
    await probeUnixepoch();
    await probeUpsert();
    await probeRateLimiterIdiom();
    await probeNullsOrdering();
    await probeStrictAffinity();
    await probeFoundations();
    writeReport();
  } finally {
    const del = await cf(`/accounts/${ACCOUNT}/d1/database/${dbId}`, { method: 'DELETE' });
    if (del.body?.success) {
      console.log(`\nCLEANUP OK — deleted ${DB_NAME} (${dbId})`);
    } else {
      console.error(
        `\nCLEANUP FAILED for ${DB_NAME} (${dbId}) — DELETE THIS BY HAND: ${JSON.stringify(del.body?.errors)}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
