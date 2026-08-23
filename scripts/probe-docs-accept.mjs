/**
 * What does the documentation site hand an agent that asks for markdown?
 *
 * Every documentation page exists twice: a rendered page at `/docs/quickstart` and
 * a markdown twin at `/docs/quickstart.md`, and `llms.txt` lists the twins. That
 * covers a reader who fetches `llms.txt` first. It does not cover the standard
 * mechanism, which is to ask for the page by its own URL and say what you can read.
 *
 * This measures both halves rather than assuming either:
 *
 *   1. the page URL with no `Accept` header       — what a browser gets
 *   2. the page URL with `Accept: text/markdown`  — what an agent should get
 *   3. the `.md` twin                             — the fallback that already works
 *
 * ⚠️ Calibrated in both directions on purpose. A probe that only checks case 2 will
 * report "html" whether the negotiation is missing or the whole site is down, and
 * those need different responses. Case 3 is the control: if the twin does not
 * answer either, the site is the problem and case 2 says nothing.
 *
 * Reads only. No credential, no header that names this project.
 *
 *   node scripts/probe-docs-accept.mjs [origin]
 */

const ORIGIN = (process.argv[2] ?? 'https://baseclf.dev').replace(/\/$/, '');

const PAGES = ['/docs', '/docs/quickstart', '/docs/policies', '/docs/compatibility'];

/** The twin of a page URL, matching how `llms.txt` spells them. */
function twinOf(page) {
  return page === '/docs' ? '/docs/index.md' : `${page}.md`;
}

/**
 * One request, one connection.
 *
 * Reusing a connection across cases is how a probe in this project once reported a
 * 400 for a request it never sent (rules/01 section F1). Nothing here writes, so the
 * stakes are lower, but the habit is cheap.
 */
async function measure(url, accept) {
  const headers = accept === null ? {} : { accept };
  try {
    const response = await fetch(url, { headers, redirect: 'manual' });
    const type = response.headers.get('content-type') ?? '(none)';
    const body = await response.text();
    return { status: response.status, type, bytes: body.length, head: body.slice(0, 60) };
  } catch (error) {
    return { status: 0, type: `(request failed: ${error.message})`, bytes: 0, head: '' };
  }
}

/** Markdown means the body is markdown, not that the header says so. */
function looksLikeMarkdown(result) {
  return result.type.includes('text/markdown') && !result.head.trimStart().startsWith('<');
}

const rows = [];

for (const page of PAGES) {
  const plain = await measure(`${ORIGIN}${page}`, null);
  const asked = await measure(`${ORIGIN}${page}`, 'text/markdown');
  const twin = await measure(`${ORIGIN}${twinOf(page)}`, null);
  rows.push({ page, plain, asked, twin });
}

console.log(`origin: ${ORIGIN}\n`);

for (const row of rows) {
  console.log(row.page);
  console.log(
    `  no accept header      ${row.plain.status} ${row.plain.type} (${row.plain.bytes} bytes)`,
  );
  console.log(
    `  accept text/markdown  ${row.asked.status} ${row.asked.type} (${row.asked.bytes} bytes)`,
  );
  console.log(
    `  ${twinOf(row.page).padEnd(22)}${row.twin.status} ${row.twin.type} (${row.twin.bytes} bytes)`,
  );
  console.log('');
}

const twinsAnswer = rows.every((row) => looksLikeMarkdown(row.twin));
const pagesNegotiate = rows.every((row) => looksLikeMarkdown(row.asked));

if (!twinsAnswer) {
  console.log('The markdown twins do not answer with markdown.');
  console.log('That makes the negotiation column meaningless: fix the twins first.');
} else if (pagesNegotiate) {
  console.log('Every page answers markdown when asked for markdown, and the twins still work.');
} else {
  console.log('The twins answer markdown; the page URLs ignore the Accept header.');
  console.log('An agent that did not read llms.txt first gets html and has no way to know');
  console.log('a markdown copy exists.');
}
