/**
 * Serve the markdown copy of a documentation page to a reader that asks for markdown.
 *
 * Every documentation page already exists twice: the rendered page at `/docs/quickstart`
 * and a markdown condensation at `/docs/quickstart.md`, which `llms.txt` lists. That
 * serves a reader who fetches `llms.txt` first. It does nothing for the ordinary case,
 * which is a client fetching the page by its own URL and stating what it can read.
 * Measured on the deployed site before this existed: all four pages answered
 * `text/html` no matter what `Accept` said.
 */

/**
 * Which pages have a markdown twin, spelled out rather than derived.
 *
 * A rule like "append .md" would answer for paths that have no twin, and the failure
 * would be a 404 handed to somebody who asked a reasonable question. A closed table
 * can be checked against the files on disk, and the contract test does exactly that.
 */
const MARKDOWN_TWIN: ReadonlyMap<string, string> = new Map([
  ["/docs", "/docs/index.md"],
  ["/docs/quickstart", "/docs/quickstart.md"],
  ["/docs/policies", "/docs/policies.md"],
  ["/docs/compatibility", "/docs/compatibility.md"],
]);

/** `/docs/` and `/docs` are the same page. The root is never in the table. */
function normalize(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

interface AcceptEntry {
  readonly type: string;
  readonly quality: number;
}

/** `text/markdown;q=0.9, text/html` into entries, lowercased, q defaulting to 1. */
function parseAccept(header: string): readonly AcceptEntry[] {
  const entries: AcceptEntry[] = [];

  for (const part of header.split(",")) {
    const [rawType, ...parameters] = part.split(";");
    const type = rawType.trim().toLowerCase();
    if (type === "") continue;

    let quality = 1;
    for (const parameter of parameters) {
      const [name, value] = parameter.split("=");
      if (name?.trim().toLowerCase() !== "q") continue;
      const parsed = Number.parseFloat(value ?? "");
      // A q that does not parse is a malformed header, not a request for nothing.
      // Leaving the default alone keeps a typo from silently reordering the answer.
      if (Number.isFinite(parsed)) quality = parsed;
    }

    entries.push({ type, quality });
  }

  return entries;
}

/**
 * Does this reader want markdown more than it wants the page?
 *
 * Markdown has to be named. A wildcard does not count, and that is the whole reason
 * this is a comparison rather than a substring check: a browser ends its Accept header
 * with a low-weighted match-anything entry and curl sends nothing but one, so treating
 * a wildcard as consent would hand markdown to every ordinary visitor.
 *
 * A tie goes to markdown. Nothing sends `text/markdown` by accident, so a client that
 * lists it level with html has gone out of its way to say either will do, and this is
 * the copy written for a machine to read.
 */
function prefersMarkdown(header: string | null): boolean {
  if (header === null) return false;

  const entries = parseAccept(header);
  const markdown = entries.find((entry) => entry.type === "text/markdown");
  if (markdown === undefined || markdown.quality <= 0) return false;

  const htmlQuality = entries
    .filter((entry) => entry.type === "text/html" || entry.type === "text/*" || entry.type === "*/*")
    .reduce((best, entry) => Math.max(best, entry.quality), 0);

  return markdown.quality >= htmlQuality;
}

/** Whether the answer for this path depends on `Accept`, and so must say so to caches. */
export function negotiatesMarkdown(pathname: string): boolean {
  return MARKDOWN_TWIN.has(normalize(pathname));
}

/**
 * Add `Accept` to whatever a response already varies by.
 *
 * 🔴 Written as a plain `set` first, and the contract test caught it. The framework
 * ships its own `Vary` on every rendered page (`RSC`, `Next-Router-State-Tree`, and
 * the rest), which is how a cache tells a client-side navigation payload apart from a
 * full page. Overwriting that list would have let a cache answer one with the other,
 * and nothing about the documentation pages would have looked wrong while it happened.
 */
function varyingOnAccept(source: Headers): Headers {
  const headers = new Headers(source);
  const current = headers.get("vary");

  if (current === null || current.trim() === "") {
    headers.set("vary", "Accept");
    return headers;
  }

  const listed = current.split(",").map((entry) => entry.trim().toLowerCase());
  if (listed.includes("accept") || listed.includes("*")) return headers;

  headers.set("vary", `${current}, Accept`);
  return headers;
}

/** The page's own answer, marked as depending on `Accept`. */
export function markPageVaries(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: varyingOnAccept(response.headers),
  });
}

/**
 * The markdown answer for this request, or null to let the page render.
 *
 * Returning null on a missing or failed asset is deliberate. The alternative is
 * handing back the asset's 404, which would replace a page that works with an error
 * for somebody whose only mistake was stating a preference. The contract test is what
 * keeps a missing twin from going unnoticed, rather than a runtime failure.
 */
export async function markdownFor(
  request: Request,
  assets: { fetch(request: Request): Promise<Response> },
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const url = new URL(request.url);
  const twin = MARKDOWN_TWIN.get(normalize(url.pathname));
  if (twin === undefined) return null;
  if (!prefersMarkdown(request.headers.get("accept"))) return null;

  let response: Response;
  try {
    response = await assets.fetch(new Request(new URL(twin, url), { method: request.method }));
  } catch {
    return null;
  }

  if (!response.ok) return null;

  // Rebuilt rather than passed through so the two branches cannot disagree about the
  // content type, and so `Vary` is on the response a cache actually stores.
  const headers = varyingOnAccept(response.headers);
  headers.set("content-type", "text/markdown; charset=utf-8");
  headers.set("content-location", twin);

  return new Response(response.body, { status: response.status, headers });
}
