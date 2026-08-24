/**
 * The reading and the comparing that `check-ship-order.mjs` does, with the file
 * system, the network and the registry left out.
 *
 * The check exists because a failure looked clean four times. Everything that could
 * make it look clean again lives here: a parser that skips a call it does not
 * recognise, an extraction that finds half a page's scripts, a route table that
 * stopped matching its own pattern. Those are the parts worth a test, and they are
 * the parts that need nothing from outside the process to exercise.
 *
 * ⚠️ Nothing in this file may import from `node:`. The suite runs inside workerd
 * (`vitest.config.ts`), which has no `node:fs` and no `node:child_process`, so an
 * import of either would take these behaviours back out of the runner. That is the
 * same reason `cli/` keeps its core free of them, stated in `tsconfig.json`.
 *
 * Every refusal is returned rather than thrown or logged, so the script keeps its
 * habit of collecting all of them and reporting one run's worth at once.
 */

/** One route named one way, so that two reads of `/rows` compare as the same route. */
export const key = (route) => `${route.method} ${route.path}`;

/** The characters a regular expression reads as instructions, made to mean themselves. */
const literally = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const METHOD = /method:\s*['"`]([A-Z]+)['"`]/;

/**
 * The route table of a published bridge, as it survives bundling.
 *
 * Measured on `baseclf@0.4.15`: the entries survive as object literals, five of them
 * in `dist-cli/baseclf.mjs`, and no other pair of these two keys appears anywhere in
 * that file, so this pattern has no false positive to filter.
 */
const PUBLISHED_ROUTE = /\{\s*method:\s*['"`]([A-Z]+)['"`],\s*path:\s*['"`](\/[^'"`]*)['"`]/g;

/**
 * The address the bridge listens on, taken from the site rather than repeated.
 *
 * Repeating it would create two constants that have to agree, and the lesson written
 * into `AGENTS.md` section 8 after the preflight table drifted is that two things
 * which must match should be one thing rather than two things with a test between
 * them. If the site moves the bridge, every reader below follows it.
 */
export function bridgeOriginIn(source, label) {
  const declared = /BRIDGE_URL\s*=\s*['"`]([^'"`]+)['"`]/.exec(source);
  if (declared === null) {
    return {
      origin: null,
      problems: [`no BRIDGE_URL declaration in ${label}, so there is nothing to look for`],
    };
  }

  return { origin: declared[1], problems: [] };
}

/**
 * Pull `(method, path)` out of every bridge call in one body of JavaScript.
 *
 * `mention` is the exact text a call begins with: the template head in source, or the
 * minified identifier in a built chunk. Every occurrence of it must come back out as
 * a route, which is the calibration: a call written in an unrecognised shape shows up
 * as a count that does not add up, rather than as silence.
 */
export function callsIn(body, mention, label) {
  const escaped = literally(mention);
  const call = new RegExp(`${escaped}(/[A-Za-z0-9._-]*)`, 'g');
  const mentions = [...body.matchAll(new RegExp(escaped, 'g'))].length;
  const matches = [...body.matchAll(call)];

  const calls = matches.map((match, index) => {
    // The window ends where the next call begins, so a `method` belonging to the next
    // fetch cannot be read as this one's. A call with no `method` is a GET, which is
    // what fetch itself does with the option absent.
    const from = match.index + match[0].length;
    const to = index + 1 < matches.length ? matches[index + 1].index : body.length;
    const method = METHOD.exec(body.slice(from, to));
    return { method: method === null ? 'GET' : method[1], path: match[1] };
  });

  const problems = [];
  if (mentions !== calls.length) {
    problems.push(
      `${label} mentions the bridge ${mentions} times but only ${calls.length} parsed as a ` +
        'route, so at least one call is written in a shape this check does not read',
    );
  }

  return { calls, problems };
}

/**
 * The second half of the calibration, and it exists because the first half had a hole
 * of exactly the shape this whole check is about.
 *
 * `callsIn` counts the template head, `${BRIDGE_URL}`. A call written
 * `fetch(BRIDGE_URL + '/usage')` uses the constant without that head, so it moves
 * neither counter: measured, such a body parses to the same number of calls with zero
 * problems, and the run reports clean while a route goes unchecked. That is the
 * failure looking clean again, one level up.
 *
 * Counting the identifier closes it. Every mention of the name outside its own
 * declaration has to be a call this parser understood. Measured on the client today:
 * seven mentions, one declaration, six calls.
 *
 * ⚠️ Source only. In a built chunk the constant is renamed to something like `w`, and
 * a word-boundary count of `w` would match half the file. The bundle keeps only the
 * template count, so this stronger guard is the one that has to hold, and it holds
 * where the code is written rather than where it is emitted.
 */
export function identifierReferenceProblems(source, identifier, parsedCount, label) {
  const name = literally(identifier);
  const mentions = [...source.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;
  // A declaration is the name with an `=` after it. Anything else is a use.
  const declarations = [...source.matchAll(new RegExp(`\\b${name}\\b\\s*=[^=]`, 'g'))].length;
  const references = mentions - declarations;

  if (references === parsedCount) return [];

  return [
    `${label} uses ${identifier} ${references} times outside its declaration but only ` +
      `${parsedCount} parsed as a route, so at least one call is written in a shape this ` +
      'check does not read',
  ];
}

/** Every script the page asks for. Modulepreload counts: the browser fetches those. */
export function scriptsReferencedBy(html) {
  const sources = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(([, src]) => src);

  // Each `<link>` read whole and then asked what it is, rather than matched by a
  // pattern that fixes the order of its attributes. `rel` before `href` is what the
  // bundler emits today, measured, but attribute order is the bundler's to change and
  // there is no count here that would notice half the preloads going missing: the
  // only backstop is every bridge-carrying chunk being missed at once.
  const preloads = [...html.matchAll(/<link\b[^>]*>/g)]
    .map(([tag]) => tag)
    .filter((tag) => /\brel="modulepreload"/.test(tag))
    .map((tag) => /\bhref="([^"]+)"/.exec(tag))
    .filter((href) => href !== null)
    .map(([, href]) => href);

  return [...new Set([...sources, ...preloads])];
}

/**
 * The name the minifier gave the bridge constant in one chunk.
 *
 * Measured on a real build: `w=\`http://127.0.0.1:4000\``, and `${w}` then appears
 * once per call. The identifier is per chunk and per build, so it is read rather
 * than remembered.
 */
export function bridgeIdentifierIn(body, bridgeOrigin) {
  const bound = new RegExp(
    `([A-Za-z_$][\\w$]*)\\s*=\\s*['"\`]${literally(bridgeOrigin)}['"\`]`,
  ).exec(body);
  return bound === null ? null : bound[1];
}

/**
 * The bridge's route table, read out of the bytes the registry hands out.
 *
 * An empty read is a refusal rather than an answer. Reading no routes out of a
 * published bundle would make every call look unserved, or, ahead of the comparison,
 * make a run look like it had checked something.
 */
export function publishedRoutesIn(bundle, label) {
  const routes = [...bundle.matchAll(PUBLISHED_ROUTE)].map((match) => ({
    method: match[1],
    path: match[2],
  }));

  const problems = [];
  if (routes.length === 0) {
    problems.push(
      `no route table found in ${label}, so either the bridge stopped declaring one ` +
        'or its shape changed and this check can no longer read it',
    );
  }

  return { routes, problems };
}

/**
 * The routes something calls that the published bridge does not answer.
 *
 * Deduplicated because two reads of `/rows` are one route, and naming it twice in a
 * refusal would read as two problems.
 */
export function missingRoutes(calls, served) {
  const servedKeys = new Set(served.map(key));
  return [...new Set(calls.filter((call) => !servedKeys.has(key(call))).map(key))];
}
