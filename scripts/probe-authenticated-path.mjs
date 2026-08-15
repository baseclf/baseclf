/**
 * Drive the `authenticated` path against a live deployment with a real JWT.
 *
 * The engine's hardest guarantee is the one this exercises, and until 2026-08-15
 * it had only ever been exercised by unit tests. `update` has no `WITH CHECK` in
 * SQLite and D1 has no interactive transaction, so a condition on the row *as it
 * will be* is compiled by rewriting every column reference in `check` into its
 * post-image. The resulting statement is safe in a way that is not visible from
 * the policy that produced it, which is exactly why it deserves a probe against
 * real infrastructure rather than another unit test.
 *
 * `policy_simulate` does not cover this. It proves what a policy compiles to, not
 * what D1 returns for a token a person actually signed in to get.
 *
 * The token is read from stdin, never argv: a command line goes into shell
 * history, `ps`, and CI logs that outlive the job.
 *
 *   node scripts/probe-authenticated-path.mjs https://deployment.workers.dev < token.txt
 *
 * Expects two seeded rows, one owned by the token's subject and one owned by
 * somebody else. It prints what it found rather than asserting a fixture, so a
 * missing row reads as a missing row instead of as a failed invariant.
 */

const origin = process.argv[2];
if (origin === undefined) {
  console.error('usage: node scripts/probe-authenticated-path.mjs <origin> < token.txt');
  process.exitCode = 2;
}

const OWN = 'p_probe_own';
const OTHER = 'p_probe_other';

const token = (
  await new Promise((resolve) => {
    let buffer = '';
    process.stdin.on('data', (chunk) => (buffer += chunk));
    process.stdin.on('end', () => resolve(buffer));
  })
).trim();

const claims = JSON.parse(
  Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8') || '{}',
);
const subject = claims.sub;
const secondsLeft = Number(claims.exp ?? 0) - Math.floor(Date.now() / 1000);

console.log(`role ${JSON.stringify(claims.role)}, expires in ${secondsLeft}s\n`);

const call = async (path, init = {}) => {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const body = await response.text();
  return { status: response.status, body };
};

const results = [];

function record(name, proves, ok, detail) {
  results.push({ name, proves, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      proves: ${proves}`);
  console.log(`      ${detail}\n`);
}

// 1. Reading as somebody. The negative half matters more than the positive one:
//    a verifier that quietly downgraded to anon would still return rows.
{
  const { status, body } = await call('/rest/v1/posts');
  const rows = status === 200 ? JSON.parse(body) : [];
  const ids = rows.map((row) => row.id).sort();
  const sawOwnDraft = ids.includes(OWN);
  const sawOthersDraft = ids.includes(OTHER);

  record(
    "reads own draft, not another account's draft",
    'the token verified and resolved to authenticated, not silently to anon',
    status === 200 && sawOwnDraft && !sawOthersDraft,
    `HTTP ${status}, rows [${ids.join(', ')}]`,
  );
}

const patch = (id, payload) =>
  call(`/rest/v1/posts?id=eq.${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });

// 2. The positive case. Without it, a deployment refusing everything would score
//    full marks on the three refusals below.
{
  const { status, body } = await patch(OWN, { title: 'Renamed by its owner' });
  record(
    'updates its own row',
    'the `using` predicate lets the owner through',
    status === 200,
    `HTTP ${status}, ${body.slice(0, 120)}`,
  );
}

// 3. Invariant I5: forbidden and absent answer the same way, so an attacker
//    cannot walk ids and learn which ones exist.
{
  const { status } = await patch(OTHER, { title: 'Taken over' });
  record(
    "cannot update another account's row, and gets 404 rather than 403",
    'invariant I5: forbidden and non-existent are indistinguishable',
    status === 404,
    `HTTP ${status}`,
  );
}

// 4. The column allowlist, which is the *easy* layer. `author_id` is absent from
//    the policy's `columns`, so this is refused before the post-image check ever
//    matters. Recorded as its own case precisely so it is not mistaken for the
//    post-image check, which needs a policy that grants `author_id`.
{
  const { status } = await patch(OWN, { title: 'Still mine', author_id: 'u_someone_else' });
  record(
    'cannot hand its own row to somebody else',
    'the column allowlist refuses a column the policy never granted',
    status === 404,
    `HTTP ${status}`,
  );
}

const failed = results.filter((result) => !result.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (subject === undefined) console.log('note: the token carried no subject');
process.exitCode = failed.length === 0 ? 0 : 1;
