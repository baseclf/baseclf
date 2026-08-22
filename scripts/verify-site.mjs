/**
 * Check what the site actually serves, by reading its bundle rather than its
 * version number.
 *
 * A site deploy reports a new Version ID immediately and then takes one to four
 * minutes to reach every edge, measured repeatedly on 2026-08-21. During that
 * window a `wrangler deployments` listing and a browser disagree, and both are
 * telling the truth about different things. `rules/02` section C2c records two
 * wrong conclusions drawn in a single day from that gap:
 *
 *   1. A reload inside the window served the old HTML, and the reader concluded
 *      the deploy had not happened.
 *   2. A poll looked for the new string in the wrong file, because the bundler
 *      had split that code into a chunk the poll never fetched. Six minutes of
 *      blind polling looked exactly like "not propagated yet".
 *
 * The second is the reason this exists as a script rather than a one-liner. The
 * page references its chunks by path, so the only honest way to ask "is the new
 * code being served" is to follow every reference the page actually makes and
 * look inside each one. Guessing a filename pattern is how failure two happened:
 * the guess was `/assets/`, and this site emits `/_next/static/chunks/`.
 *
 * Exits 0 when the needle is being served and 1 when it is not, so it can be
 * polled without reading the prose:
 *
 *   node scripts/verify-site.mjs "identity tables are reserved names"
 *   node scripts/verify-site.mjs "some copy" --path /studio --origin https://baseclf.dev
 */

const args = process.argv.slice(2);
const needle = args.find((entry) => !entry.startsWith('--'));
const optionOf = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};

if (needle === undefined) {
  console.error('verify-site: needs a string to look for.');
  console.error(
    '  node scripts/verify-site.mjs "some copy" [--path /studio] [--origin https://baseclf.dev]',
  );
  process.exit(2);
}

const origin = optionOf('origin', 'https://baseclf.dev');
const givenPath = optionOf('path', '/studio');

// Git Bash on Windows rewrites an argument that looks like a unix absolute path
// into a Windows one, so `--path /docs` arrives as `C:/Program Files/Git/docs`.
// Glued to the origin that becomes the hostname `baseclf.devc`, and the failure
// surfaces as a DNS error about a host nobody typed. That is the third shell to
// break a measurement in this project rather than the thing being measured
// (rules/01 G10, rules/02 C1), so it gets named here instead of debugged again.
if (/^[A-Za-z]:[\\/]/.test(givenPath)) {
  console.error(
    `verify-site: --path arrived as ${givenPath}, which is a Windows path, not a site path.`,
  );
  console.error('Git Bash rewrote it. Pass it without the leading slash: --path docs');
  process.exit(2);
}
const path = givenPath.startsWith('/') ? givenPath : `/${givenPath}`;

/** Every script the page asks for, in the order it asks. */
function scriptsReferencedBy(html) {
  const sources = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(([, src]) => src);
  // Modulepreload counts: the browser fetches those too, and a bundler is free
  // to put the new code behind one. Missing them is how a poll goes blind.
  const preloads = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)].map(
    ([, href]) => href,
  );
  return [...new Set([...sources, ...preloads])];
}

/**
 * Everything past the first fetch sets `process.exitCode` and returns rather
 * than calling `process.exit`.
 *
 * ⚠️ Not a style choice. `process.exit` while undici still holds a keep-alive
 * socket aborts the process on Windows with `Assertion failed:
 * !(handle->flags & UV_HANDLE_CLOSING)` and an exit code of **127**, after
 * having already printed the correct answer. A poller reads 127, not the 0 that
 * was meant, so the script reports success and exits failure in the same
 * breath. Measured here on the run that found it.
 */
async function main() {
  const pageUrl = `${origin}${path}`;
  const page = await fetch(pageUrl, { headers: { accept: 'text/html' } });
  if (!page.ok) {
    console.error(`verify-site: ${pageUrl} answered ${page.status}.`);
    return 1;
  }
  const html = await page.text();

  // The needle may be server-rendered rather than shipped in a chunk, so the
  // HTML itself is the first place to look and counts as a hit.
  if (html.includes(needle)) {
    console.log(`serving it: the string is in the HTML of ${path}.`);
    return 0;
  }

  const references = scriptsReferencedBy(html);
  if (references.length === 0) {
    // Not a negative result. A page that references nothing means the
    // extraction is wrong, which is exactly failure two, so it must never read
    // as "absent".
    console.error(`verify-site: ${path} references no scripts, which is not believable.`);
    console.error(
      'The extraction is probably wrong. Look at the HTML before trusting any answer here.',
    );
    return 2;
  }

  const hits = [];
  let unreadable = 0;
  for (const reference of references) {
    // Resolved against the page, not concatenated onto the origin. A reference
    // that does not begin with a slash is legal and common, and gluing it to
    // the origin produced `baseclf.dev` + `c...` here: a DNS failure for a
    // hostname that never existed, thrown from a script whose whole job is to
    // not draw the wrong conclusion from a failed fetch.
    const response = await fetch(new URL(reference, pageUrl));
    if (!response.ok) {
      unreadable += 1;
      continue;
    }
    if ((await response.text()).includes(needle)) hits.push(reference);
  }

  console.log(
    `checked ${references.length} file(s) referenced by ${path}${unreadable > 0 ? `, ${unreadable} unreadable` : ''}.`,
  );
  if (hits.length > 0) {
    for (const hit of hits) console.log(`  serving it: ${hit}`);
    return 0;
  }
  console.log(
    '  not serving it yet. A fresh deploy needs one to four minutes to reach every edge.',
  );
  return 1;
}

process.exitCode = await main();
