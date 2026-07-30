import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { resetCatalogue } from './db/index.js';
import worker from './index.js';

const call = (path: string) => worker.fetch(new Request(`https://baseclf.test${path}`), env);

beforeAll(async () => {
  resetCatalogue();
  await env.DB.prepare('DROP TABLE IF EXISTS widgets').run();
  await env.DB.prepare('DROP TABLE IF EXISTS _internal').run();
  await env.DB.prepare(
    'CREATE TABLE widgets (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL)',
  ).run();
  await env.DB.prepare('CREATE TABLE _internal (id TEXT PRIMARY KEY NOT NULL)').run();
});

describe('worker', () => {
  it('answers /health without touching the database', async () => {
    const response = await call('/health');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
  });

  it('describes user tables at /_schema', async () => {
    const response = await call('/_schema');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { tables: { name: string; columns: number }[] };
    expect(body.tables.find((t) => t.name === 'widgets')).toMatchObject({ columns: 2 });
  });

  it('never lists a system table', async () => {
    // Rule 00 invariant I8. A table whose name starts with an underscore is
    // ours, and it must not be visible through any public surface.
    const response = await call('/_schema');
    const body = (await response.json()) as { tables: { name: string }[] };
    expect(body.tables.some((t) => t.name.startsWith('_'))).toBe(false);
  });

  it('returns 404 for an unknown path', async () => {
    const response = await call('/nope');
    expect(response.status).toBe(404);
  });
});
