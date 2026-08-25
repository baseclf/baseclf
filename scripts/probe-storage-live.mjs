/**
 * Drive the storage surface of a live deployment with a real signed-in user.
 *
 * ## The one piece of debt 59 nothing else covers
 *
 * The `list` operation shipped with fifteen workerd tests, the CLI applied and
 * read back real rules on real infrastructure, and the Studio screen was read by
 * eye. What has never happened is the HTTP surface answering a real JWT that a
 * real person got by signing in: upload, list, download, and the refusals, over
 * the network, against real R2 and real D1. This project has once had every test
 * green while the deployed path was broken (the JWKS self-fetch, rules/02
 * section I), which is why "covered in workerd" is not the end of the sentence.
 *
 * ## How the token happens without anybody copying one
 *
 * A JWT belongs to one deployment and lives fifteen minutes, so pasting it
 * around is both fragile and the kind of value that ends up in a screenshot.
 * Instead this script runs the whole exchange itself:
 *
 *   1. It listens on localhost:4000, which the demo deployment already trusts.
 *   2. It asks the deployment to begin a GitHub sign-in with this address as the
 *      callback, and prints the GitHub URL. That URL is the operator's one job.
 *   3. GitHub sends the browser back through the deployment, whose handover puts
 *      the session in the URL fragment (see src/auth/handover.ts for why), and
 *      the page this script serves reads the fragment and posts it back here.
 *   4. The session is exchanged for a JWT the way the SDK does it, and the probe
 *      runs. No token is printed, typed, or pasted anywhere.
 *
 * ## What is asserted
 *
 * The positive path and the refusals both, because a deployment refusing
 * everything scores full marks on refusal tests alone:
 *
 *   - upload into the caller's own prefix answers 2xx
 *   - list answers the caller's own directory, names only, no paths
 *   - the uploaded file is downloadable and byte-identical
 *   - an anonymous list is refused with 404, not 403 (invariants I1 and I5)
 *   - a name that does not exist answers 404, same as one that is forbidden
 *   - delete answers 204, and a second list no longer names the file
 *
 * The version is checked first: `list` shipped in 0.4.16, and running this
 * against an older worker would measure an engine that never had the route.
 *
 * ⚠️ Writes one 70-byte PNG into the caller's own prefix and deletes it at the
 * end. Prints no hostname, no token, and no subject.
 *
 *   node scripts/probe-storage-live.mjs https://<deployment>.workers.dev
 */

import { createServer } from 'node:http';

const origin = process.argv[2];
if (origin === undefined || !/^https:\/\//.test(origin)) {
  console.error('usage: node scripts/probe-storage-live.mjs https://<deployment>');
  process.exit(2);
}

const CALLBACK_PORT = 4000;
const CALLBACK_ORIGIN = `http://localhost:${CALLBACK_PORT}`;
const BUCKET = 'avatars';
const FILE = 'probe.png';

/** A valid 1x1 transparent PNG, well under any sane size cap. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** The page the browser lands on. It moves the fragment here and says so. */
const LANDING = `<!doctype html><meta charset="utf-8"><title>BaseCLF probe</title>
<body style="font-family: system-ui; padding: 2rem">
<p id="say">Handing the session to the probe...</p>
<script>
  const token = new URLSearchParams(location.hash.slice(1)).get("session");
  history.replaceState(null, "", location.pathname);
  fetch("/session", { method: "POST", body: token ?? "" })
    .then(() => { document.getElementById("say").textContent =
      token ? "Done. You can close this tab." : "No session arrived. Close this and check the terminal."; });
</script>`;

console.log('=== 0. Is this worker new enough to have the route? ===\n');

const health = await fetch(`${origin}/health`).then(
  (response) => response.json(),
  () => null,
);

if (health === null || typeof health.version !== 'string') {
  console.error('  the deployment did not answer /health, so nothing below can run.');
  process.exit(1);
}

const [major, minor, patch] = health.version.split('.').map(Number);
const hasList = major > 0 || minor > 4 || (minor === 4 && patch >= 16);
console.log(
  `  version ${health.version}, list ${hasList ? 'should be there' : 'DOES NOT EXIST yet'}.`,
);

if (!hasList) {
  console.error('');
  console.error('  This worker predates the list operation (0.4.16), so running the probe');
  console.error('  would measure an engine that never had the route. Redeploy it first.');
  process.exit(1);
}

console.log('\n=== 1. A real sign-in, with the token never leaving the machines involved ===\n');

const session = await new Promise((resolve, reject) => {
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/session') {
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', () => {
        response.writeHead(204).end();
        if (body.trim() !== '') {
          server.close();
          resolve(body.trim());
        }
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' }).end(LANDING);
  });

  server.listen(CALLBACK_PORT, '127.0.0.1', async () => {
    const begun = await fetch(`${origin}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: CALLBACK_ORIGIN },
      body: JSON.stringify({ provider: 'github', callbackURL: `${CALLBACK_ORIGIN}/` }),
    }).then(
      (response) => response.json(),
      (cause) => ({ failed: String(cause) }),
    );

    if (typeof begun?.url !== 'string') {
      server.close();
      reject(new Error(`the deployment did not begin a sign-in: ${JSON.stringify(begun)}`));
      return;
    }

    console.log('  Open this in a browser and approve GitHub. Ten minutes before this gives up.');
    console.log('');
    console.log(begun.url);
    console.log('');
  });

  setTimeout(
    () => {
      server.close();
      reject(new Error('nobody completed the sign-in in time.'));
    },
    10 * 60 * 1000,
  ).unref();
});

const exchanged = await fetch(`${origin}/api/auth/token`, {
  headers: { authorization: `Bearer ${session}` },
}).then((response) => response.json());

if (typeof exchanged?.token !== 'string') {
  console.error('  the session did not exchange for a JWT. Stopping.');
  process.exit(1);
}

const jwt = exchanged.token;
const claims = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString() || '{}');
console.log(
  `  signed in: role ${JSON.stringify(claims.role)}, subject ${claims.sub === undefined ? 'MISSING' : 'present'}, ` +
    `expires in ${Number(claims.exp ?? 0) - Math.floor(Date.now() / 1000)}s`,
);

console.log('\n=== 2. The storage surface, positive and refusing ===\n');

const results = [];
const record = (name, ok, detail) => {
  results.push(ok);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`        ${detail}`);
};

const call = (path, init = {}, withAuth = true) =>
  fetch(`${origin}/storage/v1/${path}`, {
    ...init,
    headers: {
      ...(withAuth ? { authorization: `Bearer ${jwt}` } : {}),
      ...(init.headers ?? {}),
    },
  });

// Upload first, so the listing has something of this caller's to name.
{
  const response = await call(`${BUCKET}/${FILE}`, {
    method: 'PUT',
    headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
    body: PNG,
  });
  record(
    "upload lands in the caller's own prefix",
    response.status === 200 || response.status === 201,
    `HTTP ${response.status}`,
  );
}

{
  const response = await call(BUCKET);
  const body = response.status === 200 ? await response.json() : null;
  const names = (body?.objects ?? []).map((object) => object.name);
  record(
    'list answers names, and the upload is among them',
    response.status === 200 && names.includes(FILE),
    `HTTP ${response.status}, names [${names.join(', ')}], folders ${body?.folders ?? '?'}, truncated ${body?.truncated ?? '?'}`,
  );
  record(
    'names carry no path separator, so a caller never holds a path',
    names.every((name) => !name.includes('/')),
    'every name is a bare file name',
  );
}

{
  const response = await call(BUCKET, {}, false);
  record(
    'an anonymous list is refused with 404, not 403',
    response.status === 404,
    `HTTP ${response.status} (invariant I1 reaching this surface; I5 keeps it a 404)`,
  );
}

{
  const response = await call(`${BUCKET}/${FILE}`);
  const bytes =
    response.status === 200 ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
  record(
    'the uploaded file downloads byte-identical',
    response.status === 200 && bytes.equals(PNG),
    `HTTP ${response.status}, ${bytes.length} bytes`,
  );
}

{
  const response = await call(`${BUCKET}/never-uploaded.png`);
  record(
    'a name that does not exist answers 404, same as one that is forbidden',
    response.status === 404,
    `HTTP ${response.status}`,
  );
}

{
  const response = await call(`${BUCKET}/${FILE}`, { method: 'DELETE' });
  const after = await call(BUCKET).then((listing) =>
    listing.status === 200 ? listing.json() : null,
  );
  const still = (after?.objects ?? []).some((object) => object.name === FILE);
  record(
    'delete answers 204 and the listing forgets the file',
    response.status === 204 && !still,
    `HTTP ${response.status}, still listed: ${still}`,
  );
}

const failed = results.filter((ok) => !ok).length;
console.log('');
console.log(`${results.length - failed}/${results.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
