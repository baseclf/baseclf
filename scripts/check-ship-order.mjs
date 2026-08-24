#!/usr/bin/env node
/**
 * The site may not call a bridge route that npm does not serve yet.
 *
 * `AGENTS.md` section 8 states this as an order: publish the CLI first, deploy the
 * site second. The order has now been broken four times.
 *
 *   0.4.9        a page called a verb the published bridge did not have
 *   0.4.12       the same
 *   2026-08-22   the same
 *   2026-08-23   the Health panel shipped calling `GET /usage`, and `baseclf@0.4.15`
 *                on npm has never served that route
 *
 * The fourth was found by hand on 2026-08-24, by downloading the published tarball
 * and grepping it. It had been live the whole time. What a user got was not an error
 * naming the cause: the bridge answers an unknown route with 404 `{"error":"Not
 * found."}`, and the client falls through to rendering that string, so the screen
 * says "Not found." A sentence about a missing row, for a version mismatch.
 *
 * A rule broken four times is not a discipline problem, it is a missing check. This
 * is the check. It compares two sets that can both be read:
 *
 *   what the site calls    the `${BRIDGE_URL}/...` templates in the site's api client
 *   what npm serves        the route table inside the tarball npm hands out today
 *
 * ## Why the published tarball and not the local tree
 *
 * The local tree is the thing that is ahead. Reading `cli/studio.ts` would compare
 * the site against the routes that exist on this machine, which is the comparison
 * that has never failed and never will. `npx baseclf studio` fetches `latest` from
 * the registry, so `latest` is the only honest right hand side.
 *
 * ## Why it refuses instead of passing when it cannot read something
 *
 * An empty read and a clean read are different answers, and the whole failure this
 * exists to catch is one that looked clean. If the download fails, or the route table
 * in the tarball no longer parses, or the site's call idiom changes shape, this exits
 * non zero and says which. Rule 00 invariant I1 is about the policy engine, but the
 * reasoning is the same one: absence of a readable answer is not permission.
 *
 * The site side carries its own calibration. Every `${BRIDGE_URL}` occurrence must
 * come out of the parser as a route. If the counts disagree, some call is written in
 * a shape this does not understand, and a parser that quietly skips it would report
 * a coverage it does not have.
 *
 * ## Where the scope stops, stated rather than implied
 *
 *   - Bridge routes only. The engine's own routes live in a Worker the user deploys
 *     themselves, on their own version, so npm says nothing about them.
 *   - Source, not the built site bundle. This is a gate for before a deploy, and the
 *     source is where the call is written.
 *   - Running `wrangler deploy` by hand walks around this. It is wired into
 *     `npm run deploy:site`, and that is the only path it can guard.
 *
 *   node scripts/check-ship-order.mjs
 *   node scripts/check-ship-order.mjs --spec baseclf@0.4.16
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* -------------------------------------------------------------- arguments --- */

const args = process.argv.slice(2);
const optionOf = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};

/** What `npx baseclf studio` resolves to for somebody who has never run it. */
const spec = optionOf('spec', 'baseclf@latest');
const clientPath = optionOf('client', 'site/app/lib/api/studio.ts');

/** Every refusal collects here so one run reports all of them, not the first. */
const problems = [];

/* ------------------------------------------------- what the site calls ------ */

/**
 * A bridge call, as the site writes one.
 *
 * The path stops at the first character that is not part of a path segment, which is
 * how a template carrying a query string comes out as its route: the two reads of
 * `/rows` differ only after the `?`, and the bridge routes on what comes before it.
 */
const CALL = /\$\{BRIDGE_URL\}(\/[A-Za-z0-9._-]*)/g;
const BRIDGE_URL_MENTION = /\$\{BRIDGE_URL\}/g;
const METHOD = /method:\s*['"]([A-Z]+)['"]/;

function routesTheSiteCalls(path) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    problems.push(`the site api client is not at ${path}, so what it calls cannot be read`);
    return [];
  }

  const found = [];
  const matches = [...source.matchAll(CALL)];

  for (const [index, match] of matches.entries()) {
    // The window ends where the next call begins, so a `method` belonging to the next
    // fetch cannot be read as this one's. A call with no `method` is a GET, which is
    // what fetch itself does with the option absent.
    const from = match.index + match[0].length;
    const to = index + 1 < matches.length ? matches[index + 1].index : source.length;
    const method = METHOD.exec(source.slice(from, to));

    found.push({ method: method === null ? 'GET' : method[1], path: match[1] });
  }

  const mentions = [...source.matchAll(BRIDGE_URL_MENTION)].length;
  if (mentions !== found.length) {
    problems.push(
      `${path} mentions the bridge ${mentions} times but only ${found.length} parsed as a ` +
        'route, so at least one call is written in a shape this check does not read',
    );
  }
  if (found.length === 0) {
    problems.push(`no bridge call found in ${path}, which cannot be right while Studio works`);
  }

  return found;
}

/* ------------------------------------------------ what npm serves today ----- */

/**
 * The bridge's route table, read out of the bytes the registry hands out.
 *
 * The table survives bundling as object literals, measured on `baseclf@0.4.15`: five
 * entries in `dist-cli/baseclf.mjs` and no other pair of these two keys anywhere in
 * that file, so this pattern has no false positive to filter.
 */
const PUBLISHED_ROUTE = /\{\s*method:\s*['"]([A-Z]+)['"],\s*path:\s*['"](\/[^'"]*)['"]/g;

function routesNpmServes(packageSpec) {
  const work = join(tmpdir(), `baseclf-ship-order-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  let version;
  let bundle;
  try {
    // `--silent` so the only thing on stdout is the name of the file npm wrote.
    const tarball = execSync(`npm pack ${packageSpec} --silent`, { cwd: work, encoding: 'utf8' })
      .trim()
      .split('\n')
      .pop();
    execSync(`tar -xzf ${tarball}`, { cwd: work });

    version = JSON.parse(readFileSync(join(work, 'package', 'package.json'), 'utf8')).version;
    bundle = readFileSync(join(work, 'package', 'dist-cli', 'baseclf.mjs'), 'utf8');
  } catch (error) {
    problems.push(
      `${packageSpec} could not be downloaded and read (${error.message.split('\n')[0]}), ` +
        'so what npm serves is unknown',
    );
    return { version: null, routes: [] };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const routes = [...bundle.matchAll(PUBLISHED_ROUTE)].map((match) => ({
    method: match[1],
    path: match[2],
  }));

  if (routes.length === 0) {
    problems.push(
      `no route table found in ${packageSpec}, so either the bridge stopped declaring one ` +
        'or its shape changed and this check can no longer read it',
    );
  }

  return { version, routes };
}

/* ------------------------------------------------------------- the answer --- */

const calls = routesTheSiteCalls(clientPath);
const served = routesNpmServes(spec);

const key = (route) => `${route.method} ${route.path}`;
const servedKeys = new Set(served.routes.map(key));

// Deduplicated because two reads of `/rows` are one route, and naming it twice in a
// refusal would read as two problems.
const missing = [...new Set(calls.filter((call) => !servedKeys.has(key(call))).map(key))];

if (problems.length > 0) {
  console.error('ship-order: refused, because something here could not be read.\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nThis exits non zero rather than passing. The failure it exists to catch is one\n' +
      'that looked clean, so an unreadable answer is not treated as a clean one.',
  );
  process.exit(1);
}

if (missing.length === 0) {
  const distinct = new Set(calls.map(key)).size;
  console.log(
    `ship-order: clean. The ${calls.length} bridge calls in the site are ${distinct} routes, ` +
      `and ${served.version} on npm serves every one.`,
  );
  process.exit(0);
}

console.error('ship-order: the site calls a bridge route npm does not serve.\n');
for (const route of missing) console.error(`  ${route}`);
console.error(`\nServed by ${served.version}, which is what npx installs today:\n`);
for (const route of [...new Set(served.routes.map(key))]) console.error(`  ${route}`);
console.error(
  '\nDeploying the site now ships a screen that calls this route against a bridge\n' +
    'without it. The bridge answers 404 and the client renders "Not found.", a\n' +
    'sentence about a missing row, for what is a version mismatch.\n' +
    '\n' +
    'Publish the CLI first, then deploy the site. That order is AGENTS.md section 8,\n' +
    'and it has been broken four times, which is why this check exists.',
);

process.exit(1);
