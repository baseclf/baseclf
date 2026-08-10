/**
 * What the policy engine costs in CPU, per request, before any I/O.
 *
 * This matters because of a number that is not ours to negotiate: a Worker on
 * the free plan gets 10 ms of CPU per request, and the engine spends some of it
 * on every single call. Compilation is not cached. It cannot easily be, because
 * Kysely's SQLite compiler emits positional `?` rather than `?NNN`, so a cached
 * fragment could not have its values re-bound (rules/01 section G2). So the
 * question "how much of the budget does building the statement eat" has to be
 * answered by measurement before anything is designed on top of it.
 *
 * What is measured is everything from a URL and a body to a checked statement:
 * parsing, catalogue resolution, policy compilation, SQL generation, and the
 * identifier and structural guards. The D1 round trip is excluded on purpose;
 * that is I/O, and it is not what the engine is spending CPU on.
 *
 * Two things to know before trusting a number from this file:
 *
 *   1. The clock advances here. A deployed Worker freezes time between I/O to
 *      blunt timing attacks, so this technique reports zero in production. To
 *      measure a real deployment, read `cpu_ms` from the platform's own logs.
 *      Measured in workerd on 2026-08-11: 20M iterations of arithmetic showed
 *      161 ms on Date.now and 164 ms on performance.now.
 *   2. This is a development machine, not a Cloudflare edge machine. Treat the
 *      absolute figures as an order of magnitude and the read-to-write ratio as
 *      the more durable finding.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { type Catalogue, getCatalogue, resetCatalogue } from '../db/introspect.js';
import { seedDatabase, seedStandardPolicies } from '../policy/__fixtures__/schema.js';
import { applyPolicy } from '../policy/plugin.js';
import { getRegistry, type Registry, resetRegistry } from '../policy/registry.js';
import type { AuthCtx } from '../policy/types.js';
import { buildWrite } from '../policy/write.js';
import { resolveTable } from './allowlist.js';
import { buildClientFilter, buildSelect } from './build.js';
import { prepareStatement } from './execute.js';
import { parseQueryString, type SelectItem } from './parse-query.js';
import { readTable, writeTable } from './router.js';

/** The Workers free plan allows this much CPU for an entire request. */
const FREE_PLAN_CPU_BUDGET_MS = 10;

const ANN: AuthCtx = {
  role: 'authenticated',
  uid: 'u_ann',
  email: 'ann@example.test',
  app: {},
};

const READ_QUERY = 'select=id,title,status&order=created_at.asc&limit=20';
const WRITE_FILTER = 'id=eq.p2';

let catalogue: Catalogue;
let registry: Registry;

beforeAll(async () => {
  await seedDatabase(env.DB);
  await seedStandardPolicies(env.DB);
  resetCatalogue();
  resetRegistry();
  catalogue = await getCatalogue(env.DB);
  registry = await getRegistry(env.DB);
});

/**
 * The read path with the database removed, in the same order `readTable` runs
 * it. Kept in step with the router by the agreement tests below, which compare
 * the statement this produces against the one the router actually sends.
 */
function buildReadStatement(): string {
  const table = resolveTable(catalogue, 'posts');
  const parsed = parseQueryString(new URLSearchParams(READ_QUERY));

  const columns: readonly SelectItem[] =
    parsed.select ??
    registry
      .resolve(table, 'select', ANN.role, null)
      .columns.map((column) => ({ column, alias: null }));

  const node = buildSelect({ catalogue, table, parsed, columns });
  const policied = applyPolicy(node, { registry, catalogue, auth: ANN, operation: 'select' });

  const aliases = new Set<string>();
  for (const item of columns) {
    if (item.alias !== null) aliases.add(item.alias);
  }

  return prepareStatement({ node: policied, catalogue, scope: { aliases } }).sql;
}

/** The update path with the database removed, in the same order `writeTable` runs it. */
function buildWriteStatement(): string {
  const table = resolveTable(catalogue, 'posts');
  const parsed = parseQueryString(new URLSearchParams(WRITE_FILTER));
  const filter = buildClientFilter(catalogue, table, parsed);

  const built = buildWrite({
    registry,
    catalogue,
    auth: ANN,
    table,
    operation: 'update',
    body: new Map([['title', 'measured']]),
    filter,
  });

  return prepareStatement({ node: built.node, catalogue, scope: { aliases: new Set() } }).sql;
}

interface Timing {
  readonly perOperationMs: number;
  readonly medianMs: number;
  readonly slowestBatchMs: number;
}

/**
 * Time one operation by running it in batches and taking the median batch.
 *
 * Batches rather than single calls because one call lands under the timer's
 * resolution; median rather than mean because a garbage collection inside one
 * batch should not become the headline number.
 */
function measure(operation: () => unknown, batches = 12, perBatch = 400): Timing {
  // Warm up so the figure describes steady state rather than the first pass
  // through an unoptimised function.
  for (let i = 0; i < perBatch; i += 1) operation();

  const perOperation: number[] = [];
  for (let batch = 0; batch < batches; batch += 1) {
    const started = performance.now();
    for (let i = 0; i < perBatch; i += 1) operation();
    perOperation.push((performance.now() - started) / perBatch);
  }

  const sorted = [...perOperation].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;

  return {
    perOperationMs: median,
    medianMs: median,
    slowestBatchMs: sorted[sorted.length - 1] as number,
  };
}

function report(label: string, timing: Timing): void {
  const share = (timing.medianMs / FREE_PLAN_CPU_BUDGET_MS) * 100;
  console.log(
    `  ${label.padEnd(28)} ${timing.medianMs.toFixed(4)} ms median, ` +
      `${timing.slowestBatchMs.toFixed(4)} ms worst batch, ` +
      `${share.toFixed(2)}% of the free plan budget`,
  );
}

describe('the measurement matches what the router really sends', () => {
  it('produces the same read statement as readTable', async () => {
    const actual = await readTable<{ id: string }>({
      executor: env.DB,
      catalogue,
      registry,
      auth: ANN,
      table: 'posts',
      search: new URLSearchParams(READ_QUERY),
    });

    // If this ever fails, the benchmark below has drifted away from the code it
    // claims to describe, and its numbers stop meaning anything.
    expect(buildReadStatement()).toBe(actual.sql);
  });

  it('produces the same update statement as writeTable', async () => {
    const actual = await writeTable<{ id: string }>({
      executor: env.DB,
      catalogue,
      registry,
      auth: ANN,
      table: 'posts',
      search: new URLSearchParams(WRITE_FILTER),
      operation: 'update',
      body: { title: 'measured' },
    });

    expect(buildWriteStatement()).toBe(actual.sql);
  });
});

describe('cost of building a checked statement', () => {
  it('stays far inside the free plan CPU budget', () => {
    const read = measure(buildReadStatement);
    const write = measure(buildWriteStatement);

    console.log('');
    report('read, select with policy', read);
    report('write, update with check', write);
    console.log(
      `  ${'write / read'.padEnd(28)} ${(write.medianMs / read.medianMs).toFixed(2)}x  ` +
        '(the write path compiles the check as well)',
    );
    console.log('');

    // A regression guard, not a target. The expectation is roughly two orders
    // of magnitude below this; the ceiling exists so that a change which makes
    // compilation dramatically more expensive fails here rather than in
    // somebody's production account.
    expect(read.medianMs).toBeLessThan(2);
    expect(write.medianMs).toBeLessThan(2);
  });

  it('builds the catalogue and registry cheaply enough for a cold isolate', async () => {
    // The other number that matters. Per-request cost is paid on every call,
    // but this is paid once per isolate, and it is paid inside `fetch` rather
    // than at module scope precisely because global scope only gets one second
    // of CPU (rules/02 section A). Unlike the figures above this includes D1
    // reads, so it is a wall-clock number, not a pure CPU one.
    const runs = 15;
    const started = performance.now();
    for (let i = 0; i < runs; i += 1) {
      resetCatalogue();
      resetRegistry();
      await getCatalogue(env.DB);
      await getRegistry(env.DB);
    }
    const perBuild = (performance.now() - started) / runs;

    console.log(
      `  ${'cold isolate setup'.padEnd(28)} ${perBuild.toFixed(3)} ms per build, ` +
        'including the D1 reads it needs',
    );
    console.log('');

    // Rebuild once more so later tests in this file, and the memoised state the
    // rest of the suite may rely on, are left populated rather than cleared.
    catalogue = await getCatalogue(env.DB);
    registry = await getRegistry(env.DB);

    // The startup budget is a full second. Anything approaching a tenth of it
    // would mean cold starts are worth designing around.
    expect(perBuild).toBeLessThan(100);
  });
});
