#!/usr/bin/env node
/**
 * Nothing may call a bridge route that npm does not serve.
 *
 * `AGENTS.md` section 8 states this as an order: publish the CLI first, deploy the
 * site second. The order has now been broken four times.
 *
 *   0.4.9        a page called a verb the published bridge did not have
 *   0.4.12       the same
 *   2026-08-22   the same
 *   2026-08-23   the Health panel shipped calling `GET /usage`, and `baseclf@0.4.15`
 *                on npm had never served that route
 *
 * The fourth was found on 2026-08-24 by downloading the published tarball and
 * grepping it. It had been live the whole time, and what a user got said nothing
 * about the cause. Watched rather than reasoned about, by answering the call with
 * that release's own 404 `{"error":"Not found."}` and reading the screen:
 *
 *     The numbers were not readable
 *     Not found.
 *
 * The heading is honest. The line under it is the bridge's word for a missing row,
 * standing in for a version mismatch, which is the part that sends a reader looking
 * in the wrong place.
 *
 * A rule broken four times is not a discipline problem, it is a missing check.
 *
 * ## Two modes, because there are two different questions
 *
 * **Before a deploy** (the default): read the routes out of the site's source and
 * compare them with the tarball npm hands out today. This is a gate. It is wired
 * into `deploy:site` and it refuses the deploy.
 *
 * **After a deploy** (`--live`): read the routes out of the JavaScript the deployed
 * site is actually serving, and compare those with npm. This is a monitor, and it
 * exists because a gate only guards the path it sits on. The first version of this
 * file said as much and left the hole open: `wrangler deploy` run by hand skips
 * `deploy:site` entirely, and the handover records that `npm run deploy:site` has
 * been blocked before, so the hand path is not hypothetical.
 *
 * The monitor asserts the state rather than the procedure. However the deploy
 * happened, if production ends up calling a route npm does not serve, `--live` says
 * so. That is the same reasoning as `check-staged.mjs`: a check on a step is
 * defeated by moving the step.
 *
 * ## Why the published tarball, and not the local tree
 *
 * The local tree is the side that is ahead. Reading `cli/studio.ts` would compare
 * the site against the routes on this machine, which is the comparison that has
 * never failed and never will. `npx baseclf studio` fetches `latest` from the
 * registry, so `latest` is the only honest right hand side.
 *
 * ## Why it refuses instead of passing when it cannot read something
 *
 * An empty read and a clean read are different answers, and the whole failure this
 * exists to catch is one that looked clean. If the download fails, or the route
 * table in the tarball no longer parses, or the call idiom changes shape, this exits
 * non zero and says which. Rule 00 invariant I1 is about the policy engine, but the
 * reasoning is the same: absence of a readable answer is not permission.
 *
 * Both readers carry a calibration: every mention of the bridge must come back out of
 * the parser as a route, or the run refuses. A parser that quietly skips a call it
 * does not recognise would report a coverage it does not have. Measured on the built
 * bundle: the minifier renames the constant but keeps the template, so `${w}/usage`
 * survives and `${w}` appears exactly as many times as there are calls in the source.
 *
 * ⚠️ Counting the template head alone was not enough, and the hole had the same shape
 * as the bug: `fetch(BRIDGE_URL + '/usage')` uses the constant without that head, so
 * it moved neither counter and the run reported clean. The source reader therefore
 * also counts the identifier itself, which the bundle reader cannot do because there
 * the constant is one letter. So the strong guard sits where the code is written.
 *
 * ## Where the scope stops, stated rather than implied
 *
 *   - Bridge routes only. The engine's own routes live in a Worker the user deploys
 *     themselves, on their own version, so npm says nothing about them.
 *   - The bridge origin is read out of the site's source rather than written here
 *     twice. Two constants that must agree are one constant.
 *   - ⚠️ That coupling has one consequence worth knowing before it surprises
 *     somebody: in `--live` the address comes from the checkout and the bundle comes
 *     from production, so a commit that moves the bridge to a new port will make this
 *     refuse until the site carrying that change is deployed. It refuses rather than
 *     passing, and says it cannot find the bridge, which is the true statement. It is
 *     still a false alarm about the thing being checked, so it is named here.
 *
 *   node scripts/check-ship-order.mjs
 *   node scripts/check-ship-order.mjs --spec baseclf@0.4.16
 *   node scripts/check-ship-order.mjs --live
 *   node scripts/check-ship-order.mjs --live --origin https://baseclf.dev --path studio
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The reading and the comparing live next door, with nothing from `node:` in them, so
// the suite in workerd can exercise the parts that have a way of looking clean while
// being wrong. What is left here is the file system, the network and the registry.
import {
  bridgeIdentifierIn,
  bridgeOriginIn,
  callsIn,
  identifierReferenceProblems,
  key,
  missingRoutes,
  publishedRoutesIn,
  scriptsReferencedBy,
} from './lib/ship-order.mjs';

/* -------------------------------------------------------------- arguments --- */

const args = process.argv.slice(2);
const optionOf = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};

/** What `npx baseclf studio` resolves to for somebody who has never run it. */
const spec = optionOf('spec', 'baseclf@latest');
const clientPath = optionOf('client', 'site/app/lib/api/studio.ts');
const live = args.includes('--live');
const origin = optionOf('origin', 'https://baseclf.dev');
const givenPath = optionOf('path', '/studio');

// Git Bash on Windows rewrites an argument that looks like a unix absolute path into
// a Windows one, so `--path /studio` arrives as `C:/Program Files/Git/studio`. Glued
// to an origin it becomes a hostname nobody typed, and the failure surfaces as DNS.
// `verify-site.mjs` names the same trap; it is the shell, not the thing measured.
if (/^[A-Za-z]:[\\/]/.test(givenPath)) {
  console.error(`ship-order: --path arrived as ${givenPath}, which is a Windows path.`);
  console.error('Git Bash rewrote it. Pass it without the leading slash: --path studio');
  process.exit(2);
}
const pagePath = givenPath.startsWith('/') ? givenPath : `/${givenPath}`;

/** Every refusal collects here so one run reports all of them, not the first. */
const problems = [];

/* --------------------------------------------------- where the bridge is ---- */

/** The site's api client, and the bridge address declared in it. */
function bridgeOriginFromSource(path) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    problems.push(`the site api client is not at ${path}, so the bridge address is unknown`);
    return null;
  }

  const declared = bridgeOriginIn(source, path);
  problems.push(...declared.problems);
  if (declared.origin === null) return null;

  return { origin: declared.origin, source };
}

/* ------------------------------------------------- what the source calls ---- */

function routesInSource(read) {
  if (read === null) return [];

  // Escaped rather than quoted, so this is the literal text `${BRIDGE_URL}` that the
  // source contains, and not a placeholder anybody has to read twice.
  const found = callsIn(read.source, `\${BRIDGE_URL}`, clientPath);
  problems.push(...found.problems);
  // And the stronger half: a call written `BRIDGE_URL + '/usage'` uses the constant
  // without the template head, so it moves neither of the counts above.
  problems.push(
    ...identifierReferenceProblems(read.source, 'BRIDGE_URL', found.calls.length, clientPath),
  );
  if (found.calls.length === 0) {
    problems.push(
      `no bridge call found in ${clientPath}, which cannot be right while Studio works`,
    );
  }
  return found.calls;
}

/* ---------------------------------------- what the deployed site calls ------ */

async function routesInDeployedSite(bridgeOrigin) {
  const pageUrl = `${origin}${pagePath}`;

  let html;
  try {
    const page = await fetch(pageUrl, { headers: { accept: 'text/html' } });
    if (!page.ok) {
      problems.push(`${pageUrl} answered ${page.status}, so what it calls cannot be read`);
      return [];
    }
    html = await page.text();
  } catch (error) {
    problems.push(`${pageUrl} could not be fetched (${error.message}), so it cannot be read`);
    return [];
  }

  const references = scriptsReferencedBy(html);
  if (references.length === 0) {
    // Not a negative result. A page that references nothing means the extraction is
    // wrong, and that must never read as "calls nothing".
    problems.push(`${pagePath} references no scripts, which is not believable`);
    return [];
  }

  const found = [];
  let carrying = 0;
  let unreadable = 0;

  for (const reference of references) {
    // Resolved against the page rather than concatenated onto the origin. A relative
    // reference glued to an origin produced a hostname that never existed once.
    let body;
    try {
      const response = await fetch(new URL(reference, pageUrl));
      if (!response.ok) {
        unreadable += 1;
        continue;
      }
      body = await response.text();
    } catch {
      unreadable += 1;
      continue;
    }

    const identifier = bridgeIdentifierIn(body, bridgeOrigin);
    if (identifier === null) continue;

    carrying += 1;
    const parsed = callsIn(body, `\${${identifier}}`, reference);
    problems.push(...parsed.problems);
    found.push(...parsed.calls);
  }

  if (unreadable > 0) {
    problems.push(
      `${unreadable} of ${references.length} script(s) on ${pagePath} could not be read, so ` +
        'this run does not cover everything the page loads',
    );
  }
  if (carrying === 0) {
    problems.push(
      `no script on ${pagePath} declares the bridge at ${bridgeOrigin}, so either the deployed ` +
        'build does not talk to it or the constant no longer survives bundling in a readable form',
    );
  }

  console.log(
    `read ${references.length} script(s) on ${origin}${pagePath}, ${carrying} carry the bridge.`,
  );
  return found;
}

/* ------------------------------------------------ what npm serves today ----- */

function routesNpmServes(packageSpec) {
  const work = join(tmpdir(), `baseclf-ship-order-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  let version;
  let bundle;
  try {
    // `--silent` so the only thing on stdout is the name of the file npm wrote, and
    // quoted because a spec is not always a package name: pointing this at
    // `dist-publish/baseclf` before a release answers "does the thing I am about to
    // publish satisfy the site", and that path contains a space on the machine this
    // was written on. Unquoted it split into three arguments and npm failed, which
    // was at least the safe direction: the run refused rather than reporting clean.
    const tarball = execSync(`npm pack "${packageSpec}" --silent`, { cwd: work, encoding: 'utf8' })
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

  const published = publishedRoutesIn(bundle, packageSpec);
  problems.push(...published.problems);

  return { version, routes: published.routes };
}

/* ------------------------------------------------------------- the answer --- */

/**
 * ⚠️ `process.exitCode` and a return, never `process.exit`, once a fetch has run.
 *
 * `process.exit` while undici still holds a keep alive socket aborts on Windows with
 * an assertion and an exit code of 127, after printing the right answer. A caller
 * reads 127, not the 0 that was meant. `verify-site.mjs` carries the same note from
 * the run that found it.
 */
async function main() {
  const read = bridgeOriginFromSource(clientPath);
  const calls = live
    ? read === null
      ? []
      : await routesInDeployedSite(read.origin)
    : routesInSource(read);
  const served = routesNpmServes(spec);
  const where = live ? `${origin}${pagePath}` : clientPath;

  const missing = missingRoutes(calls, served.routes);

  if (problems.length > 0) {
    console.error('ship-order: refused, because something here could not be read.\n');
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      '\nThis exits non zero rather than passing. The failure it exists to catch is one\n' +
        'that looked clean, so an unreadable answer is not treated as a clean one.',
    );
    return 1;
  }

  if (missing.length === 0) {
    const distinct = new Set(calls.map(key)).size;
    console.log(
      `ship-order: clean. The ${calls.length} bridge calls in ${where} are ${distinct} routes, ` +
        `and ${served.version} on npm serves every one.`,
    );
    return 0;
  }

  console.error(`ship-order: ${where} calls a bridge route npm does not serve.\n`);
  for (const route of missing) console.error(`  ${route}`);
  console.error(`\nServed by ${served.version}, which is what npx installs today:\n`);
  for (const route of [...new Set(served.routes.map(key))]) console.error(`  ${route}`);
  console.error(
    live
      ? '\nThis is production, now. Somebody running npx baseclf studio and opening the\n' +
          'screen that makes this call gets the bridge\'s 404 rendered as "Not found.", a\n' +
          'sentence about a missing row, for what is a version mismatch.\n' +
          '\n' +
          'Publish the CLI. The site does not need redeploying to be fixed by that.'
      : '\nDeploying the site now ships a screen that calls this route against a bridge\n' +
          'without it. The bridge answers 404 and the client renders "Not found.", a\n' +
          'sentence about a missing row, for what is a version mismatch.\n' +
          '\n' +
          'Publish the CLI first, then deploy the site. That order is AGENTS.md section 8,\n' +
          'and it has been broken four times, which is why this check exists.',
  );
  return 1;
}

process.exitCode = await main();
