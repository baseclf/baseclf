/**
 * Look for the cold-isolate hang, by waiting long enough to get cold isolates.
 *
 * The symptom on record: the first request into a cold isolate either answers in
 * about 0.2 seconds or never answers at all, on the paths that touch D1. Twenty five
 * seconds was not enough to see one finish. `wrangler tail` showed `Canceled` with no
 * query line, so it dies before reaching a statement.
 *
 * 🔴 **Why this script exists rather than a loop.** Firing requests back to back
 * measures warm isolates almost every time, because the isolate the last request
 * built is still there. Sixty seven requests sent that way found nothing, and that
 * result says very little: it is mostly a measurement of the warm path. The gap
 * between samples is the entire point of this script.
 *
 * ⚠️ **A gap does not guarantee a cold isolate, and nothing does.** `rules/02`
 * section C6 measured isolate recycling anywhere between 57 and 393 seconds, on the
 * same deployment, with nothing changed in between. So this raises the odds of a cold
 * hit rather than forcing one, and a run with no hang is weak evidence rather than
 * proof. That is also why the summary reports how many samples were slow: a slow
 * sample is the closest observable thing to a cold one.
 *
 * ⚠️ **And a hang here is one observation about one isolate.** Section C6 records the
 * mistake in the other direction, where a single polling thread reported on a whole
 * deployment. Read a hang as "this happened", never as a rate, unless the sample is
 * large.
 *
 * Usage:
 *   node scripts/probe-cold-isolate-hang.mjs <url> [--samples 10] [--gap 240] [--timeout 25]
 *
 * Run `npx wrangler tail --config wrangler.local.jsonc` alongside it. A hang is only
 * half a diagnosis without the outcome and the log lines that came before it.
 */

const args = process.argv.slice(2);
const url = args.find((each) => !each.startsWith('--'));

if (url === undefined) {
  console.error('usage: node scripts/probe-cold-isolate-hang.mjs <url> [--samples N] [--gap S] [--timeout S]');
  process.exit(2);
}

/** A numeric flag, or its default. */
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = Number(args[at + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const samples = flag('samples', 10);
const gapSeconds = flag('gap', 240);
const timeoutSeconds = flag('timeout', 25);

/**
 * The paths that were seen hanging, plus one that was not.
 *
 * `/health` is here as the control. It is the one path that never touches D1, so if it
 * ever hangs too then the cause is not in the database path and this whole line of
 * investigation is pointed at the wrong place.
 */
const PATHS = ['/rest/v1/posts', '/_schema', '/health'];

/** Everything one request produced, including the shape of its failure. */
async function sample(path) {
  const started = Date.now();
  try {
    const response = await fetch(`${url}${path}`, {
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
      // Cache would defeat the point: a cached answer never reaches an isolate.
      headers: { 'cache-control': 'no-cache' },
    });
    await response.text();
    return { path, ms: Date.now() - started, status: response.status, hung: false };
  } catch (error) {
    const timedOut = error instanceof Error && /timeout|abort/i.test(error.name + error.message);
    return {
      path,
      ms: Date.now() - started,
      status: null,
      hung: timedOut,
      why: error instanceof Error ? error.message : String(error),
    };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`probing ${url}`);
console.log(`${samples} samples, ${gapSeconds}s apart, ${timeoutSeconds}s timeout, ${PATHS.length} paths each`);
console.log(`expect this to take about ${Math.round((samples * gapSeconds) / 60)} minutes\n`);

const results = [];

for (let round = 1; round <= samples; round++) {
  // ⚠️ The gap comes first for every round after the first, so the last round is not
  // followed by a pointless wait, and the first sample is taken while the deployment
  // is as idle as it was when the script started.
  if (round > 1) await sleep(gapSeconds * 1000);

  const at = new Date().toISOString().slice(11, 19);
  const line = [];

  for (const path of PATHS) {
    const result = await sample(path);
    results.push({ ...result, round });
    line.push(`${path} ${result.hung ? 'HUNG' : `${result.status ?? 'ERR'} ${result.ms}ms`}`);
  }

  console.log(`${at}  round ${String(round).padStart(2)}  ${line.join('  ')}`);
}

console.log('');

for (const path of PATHS) {
  const mine = results.filter((each) => each.path === path);
  const hung = mine.filter((each) => each.hung).length;
  // Anything past half a second is treated as a likely cold hit. A judgment, not a
  // measurement: the warm path measured 180 to 210ms and the slow one 790 to 1250ms,
  // so the gap between the two clusters is wide and the line sits in it.
  const slow = mine.filter((each) => !each.hung && each.ms > 500).length;
  const errors = mine.filter((each) => !each.hung && each.status === null).length;

  console.log(
    `${path.padEnd(16)} n=${mine.length}  hung=${hung}  slow=${slow}  other-errors=${errors}`,
  );
}

const anyHang = results.some((each) => each.hung);

console.log(
  anyHang
    ? '\nA hang was seen. Read `wrangler tail` for its outcome and the last log line before it.'
    : '\nNo hang seen. That is weak evidence: a gap raises the odds of a cold isolate rather than forcing one.',
);

process.exit(anyHang ? 1 : 0);
