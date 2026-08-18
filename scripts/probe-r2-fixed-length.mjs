/**
 * What R2 actually does when the declared length and the body disagree.
 *
 * `rules/01` section F1 records eleven measurements of `R2Bucket.put()` and the whole
 * upload path is built on them: the size limit is enforced by declaring a length,
 * opening a `FixedLengthStream` for exactly that many bytes, and letting the runtime
 * refuse anything else. The alternative, counting bytes through a `TransformStream`,
 * is impossible because `put` rejects a stream whose length it does not know.
 *
 * 🔴 All eleven were taken in miniflare. The caveat has been open since 2026-08-11 and
 * it is the last one left: `NULLS FIRST/LAST`, `unixepoch()` and `STRICT` affinity
 * have all since been confirmed against the real thing. This closes the fourth, and
 * it matters more than the other three because it is the only one holding up a limit.
 *
 * Raw `node:https` rather than `fetch`, because the point is to send a
 * `content-length` that disagrees with the bytes, and every high level client either
 * computes the header or refuses. Nothing else can ask this question.
 *
 *   node scripts/probe-r2-fixed-length.mjs https://your-worker.workers.dev
 *
 * ⚠️ Writes to a real bucket, through a bucket named `probe` that an operator has to
 * create first. It deletes what it makes. Read the seed and the cleanup at the bottom
 * before running it against anything that matters.
 */

import { request } from 'node:https';
import { URL } from 'node:url';

const BASE = process.argv[2];
if (BASE === undefined) {
  console.error('usage: node scripts/probe-r2-fixed-length.mjs <deployment-url>');
  process.exit(2);
}

const TIMEOUT_MS = 15_000;

/**
 * One request, with the headers exactly as given and the body exactly as given.
 *
 * ⚠️ `content-length` is passed through untouched. That is the entire reason this
 * uses the raw client: it is the disagreement being measured.
 */
function send({ method, path, headers = {}, body = null }) {
  return new Promise((resolve) => {
    const target = new URL(path, BASE);
    const req = request(
      {
        method,
        hostname: target.hostname,
        path: target.pathname + target.search,
        // ⚠️ A fresh connection every time, and closed after. The first version of
        // this reused one, and a body longer than its declared length leaves the
        // extra bytes in the socket where the server reads them as the start of the
        // next request. The following probe then answered 400 about a request it
        // never made, and that 400 was very nearly written down as a finding.
        headers: { ...headers, connection: 'close' },
        agent: false,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            // What the body actually is, which is the question for a stored object.
            bytes: res.headers['content-length'] ?? String(Buffer.byteLength(text)),
            body: text.slice(0, 120),
          }),
        );
      },
    );

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      // A stall is a result rather than a crash: it says the server is still waiting
      // for bytes that are never coming, which is one of the answers this asks for.
      resolve({ status: 'timed out waiting', body: '' });
    });
    req.on('error', (error) =>
      resolve({ status: `connection ${error.code ?? 'error'}`, body: '' }),
    );

    if (body !== null) req.write(body);
    req.end();
  });
}

const results = [];
const note = (what, outcome) => {
  results.push({ what, outcome });
  const size = outcome.bytes === undefined ? '' : `  ${outcome.bytes} bytes`;
  console.log(`${String(outcome.status).padEnd(20)}${size.padEnd(14)} ${what}`);
};

console.log(`probing ${BASE}\n`);

/* ---------------------------------------------------------------- honest --- */

note(
  'a length that matches the body',
  await send({
    method: 'PUT',
    path: '/storage/v1/probe/honest.txt',
    headers: { 'content-type': 'text/plain', 'content-length': '5' },
    body: 'hello',
  }),
);

/* ------------------------------------------------------- declared > sent --- */

const short = await send({
  method: 'PUT',
  path: '/storage/v1/probe/short.txt',
  headers: { 'content-type': 'text/plain', 'content-length': '64' },
  body: 'hello',
});
note('a length larger than the body', short);
note(
  '  and afterwards, is anything stored',
  await send({ method: 'GET', path: '/storage/v1/probe/short.txt' }),
);

/* ------------------------------------------------------- declared < sent --- */

const long = await send({
  method: 'PUT',
  path: '/storage/v1/probe/long.txt',
  headers: { 'content-type': 'text/plain', 'content-length': '2' },
  body: 'hello world, rather more than two bytes',
});
note('a length smaller than the body', long);
note(
  '  and afterwards, is anything stored',
  await send({ method: 'GET', path: '/storage/v1/probe/long.txt' }),
);

/* ------------------------------------------------------------ no length --- */

note(
  'no content-length at all',
  await send({
    method: 'PUT',
    path: '/storage/v1/probe/nolength.txt',
    headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' },
    body: 'hello',
  }),
);

/* -------------------------------------------------------------- deleting --- */

note(
  'deleting a key that never existed',
  await send({ method: 'DELETE', path: '/storage/v1/probe/never-was.txt' }),
);

/* --------------------------------------------------------------- tidy up --- */

console.log('');
note(
  'cleaning up the one object that should exist',
  await send({ method: 'DELETE', path: '/storage/v1/probe/honest.txt' }),
);
note('  and it is gone', await send({ method: 'GET', path: '/storage/v1/probe/honest.txt' }));

console.log('\nread these against rules/01 section F1, which recorded them in miniflare.');
