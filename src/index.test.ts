import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { version } from '../package.json';
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

  it('reports the published version at /health, not a literal', async () => {
    // ⚠️ The check above passes for every version, including the literal 0.0.0 this
    // answered with until 2026-08-14. `status: ok` is true of a deployment carrying
    // a hole and of the one that patched it, so the version is the only thing here
    // that answers "am I running the fixed build", and for months it answered
    // nothing. Found by curling a deployment, not by a test.
    const body = (await (await call('/health')).json()) as { version: string };

    expect(body.version).toBe(version);
    expect(body.version).not.toBe('0.0.0');
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

describe('the storage path is rate limited, which it was not', () => {
  // 🔴 Debt 70. Storage had no limit of any kind: anybody holding a session could
  // upload in a loop, and an upload is an R2 write plus a row in D1 whose object
  // goes on costing after the request ends.
  //
  // Driven through `worker.fetch` rather than by calling the limiter, because what
  // was missing was the wiring rather than the limiter. A test that called
  // `checkRateLimit` would have passed on the day the hole was open.

  // ⚠️ Auth has to be configured even though every request here is anonymous.
  // `identify` refuses outright on a deployment with no signing secret, so
  // without this the whole path answers 500 and the test would be measuring a
  // misconfiguration rather than a limit. Found by probing the 500 rather than
  // by assuming which layer produced it.
  const configured = {
    ...env,
    BETTER_AUTH_SECRET: 'test-secret-not-used-to-sign-anything-real',
    BETTER_AUTH_URL: 'https://baseclf.test',
  };

  const storage = (path: string, method: string, ip: string): Promise<Response> =>
    worker.fetch(
      new Request(`https://baseclf.test${path}`, {
        method,
        headers: { 'CF-Connecting-IP': ip },
      }),
      configured,
    );

  beforeAll(async () => {
    await env.DB.prepare('DELETE FROM _rate_limit')
      .run()
      .catch(() => undefined);
  });

  it('refuses a caller who keeps deleting, before the policy is ever consulted', async () => {
    // ⚠️ The bucket does not exist, so every one of these is a 404 on its merits.
    // That is the point: the limit has to come first, or somebody probing for
    // objects they may not have probes for free behind the refusal.
    const ip = '203.0.113.70';
    let limited: Response | null = null;

    for (let attempt = 0; attempt < 70; attempt += 1) {
      const response = await storage('/storage/v1/nosuch/file.png', 'DELETE', ip);
      if (response.status === 429) {
        limited = response;
        break;
      }
      expect(response.status).toBe(404);
    }

    expect(limited).not.toBeNull();
    expect(limited?.headers.get('retry-after')).toMatch(/^\d+$/);
    await expect(limited?.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('does not spend the read budget on writes', async () => {
    // Separate buckets, because the two costs are not alike. A client that has
    // exhausted its uploads can still read what it already has.
    const ip = '203.0.113.71';

    for (let attempt = 0; attempt < 70; attempt += 1) {
      await storage('/storage/v1/nosuch/file.png', 'DELETE', ip);
    }

    const read = await storage('/storage/v1/nosuch/file.png', 'GET', ip);
    expect(read.status).toBe(404);
  });
});
