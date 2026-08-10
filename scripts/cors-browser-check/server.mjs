/**
 * Serve the CORS check page on two ports, so a browser can run it from an
 * origin that is on the allowlist and from one that is not.
 *
 * The whole point of this harness is that no HTTP client enforces CORS. A
 * request library reads the headers back correctly and then ignores them, so a
 * deployment with a broken allowlist passes every test that is not a browser.
 * Port 3000 is what wrangler.jsonc lists in BETTER_AUTH_TRUSTED_ORIGINS; 3001
 * is deliberately absent from it.
 *
 *   node scripts/cors-browser-check/server.mjs
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, 'index.html'), 'utf8');

/**
 * On the allowlist, and deliberately not on it.
 *
 * 3000 is what wrangler.jsonc ships as a default and is commonly taken by
 * something else already, so this harness uses its own pair and the deployment
 * lists the first of them.
 */
const TRUSTED_PORT = 4321;
const UNTRUSTED_PORT = 4322;
const PORTS = [TRUSTED_PORT, UNTRUSTED_PORT];

for (const port of PORTS) {
  createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // Nothing here should be cached between runs; a stale page would report
      // the previous deployment's behaviour.
      'cache-control': 'no-store',
    });
    response.end(page);
  }).listen(port, () => {
    console.log(`listening on http://localhost:${port}`);
  });
}
