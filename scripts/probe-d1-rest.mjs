/**
 * A small D1 REST client, for probing the real database from a developer machine.
 *
 * Temporary: this exists to run `baseclf policy` against live infrastructure and
 * check the result from the other side. It prints nothing on its own, and in
 * particular never an account id and never a token.
 *
 * ⚠️ Not a data plane, for the reasons in `rules/01` section E. One administrator,
 * on their own machine, looking at their own database.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';

const BASE = 'https://api.cloudflare.com/client/v4';

function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const text = readFileSync('.env', 'utf8');
  const line = text.split(/\r?\n/).find((l) => l.startsWith('CLOUDFLARE_API_TOKEN='));
  if (!line) throw new Error('no CLOUDFLARE_API_TOKEN in .env');
  return line
    .slice('CLOUDFLARE_API_TOKEN='.length)
    .trim()
    .replace(/^["']|["']$/g, '');
}

export async function open(project = 'baseclf') {
  const auth = { authorization: `Bearer ${token()}` };

  const accounts = await (await fetch(`${BASE}/accounts`, { headers: auth })).json();
  const account = accounts.result?.[0];
  if (!account) throw new Error(`no account: ${JSON.stringify(accounts.errors)}`);

  const dbs = await (
    await fetch(`${BASE}/accounts/${account.id}/d1/database?name=${encodeURIComponent(project)}`, {
      headers: auth,
    })
  ).json();
  const db = (dbs.result ?? []).find((d) => d.name === project);
  if (!db) throw new Error(`no database called "${project}"`);

  const url = `${BASE}/accounts/${account.id}/d1/database/${db.uuid}/query`;

  return {
    async query(sql) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ sql }),
      });
      const envelope = await response.json();
      if (!envelope.success) throw new Error(JSON.stringify(envelope.errors));
      return envelope.result ?? [];
    },
    async rows(sql) {
      return (await this.query(sql))[0]?.results ?? [];
    },
  };
}
