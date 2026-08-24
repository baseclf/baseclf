/**
 * Separate the two explanations for debt 34's 19ms, which one probe cannot.
 *
 * `probe-cpu-ceiling.mjs` drove a burst of `GET /health` and the platform
 * charged 0.4ms at the median, against the 19.0ms recorded for this deployment
 * over seven days. A 47x gap invites a conclusion, and there are two on offer:
 *
 *   A. cold isolates are dear and warm ones are cheap, so a seven day median
 *      full of cold starts sits far above a warm burst.
 *   B. `/health` is cheap and the real paths are dear, so the burst measured
 *      the cheapest thing this worker does and proved nothing about the rest.
 *
 * Both predict exactly what was seen, which is why that run settles neither.
 * Section C6 is the standing lesson here: a confident instrument that is wrong
 * costs more than no instrument.
 *
 * ## How this tells them apart
 *
 * Drive a warm burst down an expensive path as well as a cheap one, in windows
 * far enough apart that the dataset can be asked about each separately. Section
 * C8 measured `/api/auth/jwks` as one of the two heavy paths: it builds Better
 * Auth and reads D1, and the earlier probe measured it cold at 509ms to 2410ms
 * against `/health` at 235ms to 378ms.
 *
 *   warm jwks stays cheap   -> explanation A. The cost is in cold starts, and
 *                              a warm request of any kind is nowhere near 10ms.
 *   warm jwks is dear       -> explanation B, and debt 34 is about a real cost
 *                              on a real path rather than about start-up.
 *
 * `/api/auth/jwks` also happens to be the one auth path deliberately left out
 * of the rate limiter (`routes.test.ts` pins that), so a burst down it measures
 * the handler rather than a refusal.
 *
 * ⚠️ This adds its own traffic to the account's analytics, and the traffic is
 * cheap, so it drags the seven-day median DOWN. Anybody reading that median
 * after today is reading it partly about this probe. Recorded rather than
 * discovered later as an improvement nobody made.
 *
 * Reads only. Writes nothing, touches no policy, prints no token, no account id
 * and no hostname.
 *
 *   node scripts/probe-cpu-by-path.mjs
 */

import { readFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
const GRAPHQL = `${API}/graphql`;
const SCRIPT = 'baseclf';
const BURST = 40;

/**
 * How far apart the windows are held.
 *
 * The previous probe asked about two windows two minutes apart and got byte
 * identical answers for both, which means the dataset was not resolving them as
 * separate windows at all. Four minutes is a guess at a resolution nobody has
 * measured, and the run prints both windows so an identical pair is visible as
 * a failure to separate rather than read as a result.
 */
const GAP_MS = 4 * 60 * 1000;

function fromEnvFile(name) {
  const line = readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${name}=`));
  return line === undefined ? '' : line.slice(name.length + 1).trim();
}

const token = fromEnvFile('CLOUDFLARE_API_TOKEN');
const accountId = fromEnvFile('CLOUDFLARE_ACCOUNT_ID');

if (token === '' || accountId === '') {
  console.error('probe: .env is missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID.');
  process.exit(2);
}

if (process.env.CLOUDFLARE_API_TOKEN !== undefined && process.env.CLOUDFLARE_API_TOKEN !== token) {
  console.error('probe: the process carries a different CLOUDFLARE_API_TOKEN than .env holds.');
  process.exit(2);
}

const authorized = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const safe = (text) => String(text).split(accountId).join('<account>');

const subdomainAnswer = await fetch(`${API}/accounts/${accountId}/workers/subdomain`, {
  headers: authorized,
});
const subdomain = (await subdomainAnswer.json().catch(() => ({})))?.result?.subdomain;

if (typeof subdomain !== 'string' || subdomain === '') {
  console.error('probe: could not resolve the account subdomain.');
  process.exit(1);
}

const ORIGIN = `https://${SCRIPT}.${subdomain}.workers.dev`;
const withoutOrigin = (text) => String(text).split(subdomain).join('<subdomain>');
const hide = (text) => withoutOrigin(safe(text));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drive one path hard enough that most of the requests land on a warm isolate.
 *
 * 🔴 `from` is stamped before the first request rather than reconstructed by
 * subtracting the request times from the end. The first version did the latter,
 * which ignores every gap between requests, so the window opened LATE and the
 * dataset reported 15 of 40 requests for the expensive path. The requests it
 * dropped were the earliest ones, which are exactly the cold ones this is
 * trying to see. A window that quietly excludes the measurement's whole point
 * still returns a confident looking quantile.
 */
async function drive(path) {
  const times = [];
  const from = Date.now();
  let status = 0;

  for (let index = 0; index < BURST; index += 1) {
    const at = Date.now();
    const response = await fetch(`${ORIGIN}${path}`);
    await response.text();
    times.push(Date.now() - at);
    status = response.status;
  }

  const sorted = [...times].sort((left, right) => left - right);
  return {
    from,
    until: Date.now(),
    status,
    first: times[0],
    median: sorted[Math.floor(sorted.length / 2)],
  };
}

const WINDOW = `
  query Window($accountTag: String!, $since: Time!, $until: Time!, $scriptName: String!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 100
          filter: { datetime_geq: $since, datetime_leq: $until, scriptName: $scriptName }
          orderBy: [datetimeMinute_ASC]
        ) {
          sum { requests errors }
          quantiles { cpuTimeP50 cpuTimeP99 }
          dimensions { datetimeMinute }
        }
      }
    }
  }`;

async function costOf(since, until) {
  const response = await fetch(GRAPHQL, {
    method: 'POST',
    headers: authorized,
    body: JSON.stringify({
      query: WINDOW,
      variables: {
        accountTag: accountId,
        since: new Date(since).toISOString(),
        until: new Date(until).toISOString(),
        scriptName: SCRIPT,
      },
    }),
  });
  const body = await response.json().catch(() => ({}));
  const errors = Array.isArray(body.errors) ? body.errors : [];
  if (errors.length > 0) return { refused: errors.map((error) => hide(error.message)).join('; ') };

  const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  if (rows.length === 0) return { empty: true };

  // 🔴 Every row, not `rows[0]`. This dataset buckets by MINUTE (measured in
  // `probe-analytics-resolution.mjs`), so a burst that crosses a minute boundary
  // comes back as two rows and reading the first one reports a fraction of the
  // traffic as though it were all of it. That is how 40 sent requests were
  // reported as 15 and then as 26.
  //
  // The counts add. The quantiles do NOT: a median of medians is not a median,
  // so they are carried per row and the caller is shown each one.
  return {
    requests: rows.reduce((total, row) => total + (row.sum?.requests ?? 0), 0),
    errors: rows.reduce((total, row) => total + (row.sum?.errors ?? 0), 0),
    buckets: rows.map((row) => ({
      at: row.dimensions?.datetimeMinute ?? '?',
      requests: row.sum?.requests ?? 0,
      p50: (row.quantiles?.cpuTimeP50 ?? 0) / 1000,
      p99: (row.quantiles?.cpuTimeP99 ?? 0) / 1000,
    })),
  };
}

// The cheap path first, so that if the run is interrupted the expensive one is
// the measurement that was worth waiting for rather than the one that is missing.
console.log(`driving ${BURST} requests down the cheap path (/health)...`);
const cheap = await drive('/health');
console.log(`  HTTP ${cheap.status}, first ${cheap.first}ms, median ${cheap.median}ms`);

console.log(`\nholding ${GAP_MS / 60000} minutes so the two windows do not overlap...`);
await wait(GAP_MS);

console.log(`\ndriving ${BURST} requests down an expensive path (/api/auth/jwks)...`);
const dear = await drive('/api/auth/jwks');
console.log(`  HTTP ${dear.status}, first ${dear.first}ms, median ${dear.median}ms`);

console.log('\nwaiting 150s for the dataset to catch up...\n');
await wait(150 * 1000);

const report = async (label, window) => {
  const cost = await costOf(window.from - 5000, window.until + 5000);
  if (cost.refused !== undefined)
    return console.log(`${label.padEnd(26)} refused: ${cost.refused}`);
  if (cost.empty) return console.log(`${label.padEnd(26)} no rows`);
  // The calibration that caught both instrument bugs: compare what the dataset
  // reports against what was definitely sent. A window holding fewer requests
  // dropped some, and the dropped ones are the earliest, which are the cold
  // ones. A window holding MORE is picking up traffic that is not this burst.
  const complete = cost.requests === BURST;
  console.log(
    `${label.padEnd(26)} requests=${cost.requests}/${BURST} errors=${cost.errors}` +
      `${complete ? '' : '   <- does not match what was sent'}`,
  );

  // Per minute, because that is the bucket. One line each rather than a single
  // number, since the quantiles cannot be combined into one.
  for (const bucket of cost.buckets) {
    console.log(
      `    ${bucket.at}  requests=${String(bucket.requests).padStart(3)} ` +
        `cpuP50=${bucket.p50.toFixed(1).padStart(5)}ms cpuP99=${bucket.p99.toFixed(1).padStart(6)}ms`,
    );
  }

  return { ...cost, complete };
};

const cheapCost = await report('warm /health', cheap);
const dearCost = await report('warm /api/auth/jwks', dear);

console.log('');

/**
 * The bucket carrying most of the burst, which is the warm one.
 *
 * A burst starts on a cold isolate and then runs warm, so its first bucket may
 * hold one dear request and the next one the other thirty-nine. Taking the
 * fullest bucket is taking the warm population; the small bucket beside it is
 * where a cold measurement can be read, and that is worth printing rather than
 * averaging away. See rules/02 section A0d, where a one-request bucket turned
 * out to be the single most useful number in the run.
 */
const busiest = (cost) =>
  (cost?.buckets ?? []).reduce(
    (best, bucket) => (best === null || bucket.requests > best.requests ? bucket : best),
    null,
  );

const warmCheap = busiest(cheapCost);
const warmDear = busiest(dearCost);

if (warmCheap === null || warmDear === null) {
  console.log('🔴 A window came back empty, so nothing about paths can be read off this run.');
} else if (!cheapCost.complete || !dearCost.complete) {
  console.log('🔴 A window does not hold the number of requests that were sent, so its');
  console.log('   quantiles describe a population the window chose rather than one that was');
  console.log('   sampled. Read the per-minute lines above; do not read a conclusion here.');
} else if (warmDear.p50 < 10) {
  console.log('⭐ Explanation A. A warm request down an EXPENSIVE path still costs');
  console.log(
    `   ${warmDear.p50.toFixed(1)}ms at the median, far under 10ms. So the seven-day 19.0ms`,
  );
  console.log('   is not what a warm request costs, whichever path it takes, and the');
  console.log('   remaining candidate is start-up: exactly the hypothesis section A0');
  console.log('   wrote down on 2026-08-11 and recorded as never tested.');
} else {
  console.log('⭐ Explanation B. The expensive path is genuinely dear even warm');
  console.log(
    `   (${warmDear.p50.toFixed(1)}ms at the median), so debt 34 is about a real per-request`,
  );
  console.log('   cost rather than about cold starts, and it is worth optimising rather');
  console.log('   than explaining away.');
}

console.log('');
console.log('⚠️ Neither burst proves anything about how many of the seven-day requests');
console.log('   were cold. It bounds what a warm one costs, which is the half that was');
console.log('   missing. The other half needs the in-worker timing section G14 used.');
