/**
 * The ship order check, held to the thing it exists for.
 *
 * Its whole subject is a failure that looked clean: a page called a bridge route npm
 * did not serve, four times, and the fourth was found by downloading the tarball and
 * grepping it by hand. So the tests that matter most here are not the ones proving it
 * reads a route correctly. They are the ones proving it refuses when it cannot.
 *
 * The calibration in `callsIn` carries most of that weight. Without it, a call written
 * in a shape the parser does not recognise is skipped, the counts still balance
 * against each other, and the run reports a coverage it does not have. That is the
 * exact false negative the check was written against, so it is asserted directly:
 * given a body where one call is unreadable, the refusal must name it.
 */

import { describe, expect, it } from 'vitest';

import {
  bridgeIdentifierIn,
  bridgeOriginIn,
  callsIn,
  identifierReferenceProblems,
  key,
  missingRoutes,
  publishedRoutesIn,
  scriptsReferencedBy,
} from './ship-order.mjs';

/**
 * The template head a call begins with in the site's own source.
 *
 * Escaped rather than quoted throughout this file, so every fixture below is the
 * literal text a reader would find in the file, and not a placeholder anybody has to
 * read twice. The script builds the same mention the same way.
 */
const MENTION = `\${BRIDGE_URL}`;

describe('the bridge address, read from the site rather than repeated', () => {
  it('finds the address the site declares', () => {
    const source = "const BRIDGE_URL = 'http://127.0.0.1:4000';\n";

    expect(bridgeOriginIn(source, 'studio.ts')).toEqual({
      origin: 'http://127.0.0.1:4000',
      problems: [],
    });
  });

  it('refuses when the site declares no bridge address', () => {
    // Silence here would be the worst answer available: with no address, every reader
    // downstream finds nothing, and finding nothing is indistinguishable from a page
    // that calls nothing.
    const found = bridgeOriginIn('export const rows = () => fetch("/rows");\n', 'studio.ts');

    expect(found.origin).toBeNull();
    expect(found.problems).toEqual([
      'no BRIDGE_URL declaration in studio.ts, so there is nothing to look for',
    ]);
  });
});

describe('the bridge calls in a body of JavaScript', () => {
  it('reads the method and the path of every call', () => {
    const body = [
      `export const rows = () => fetch(\`\${BRIDGE_URL}/rows\`);`,
      `export const edit = () => fetch(\`\${BRIDGE_URL}/row\`, { method: "PATCH" });`,
    ].join('\n');

    const found = callsIn(body, MENTION, 'studio.ts');

    expect(found.problems).toEqual([]);
    expect(found.calls).toEqual([
      { method: 'GET', path: '/rows' },
      { method: 'PATCH', path: '/row' },
    ]);
  });

  it('reads a call with no method option as a GET, which is what fetch does', () => {
    const body = `export const usage = () => fetch(\`\${BRIDGE_URL}/usage\`, { headers: h });`;

    expect(callsIn(body, MENTION, 'studio.ts').calls).toEqual([{ method: 'GET', path: '/usage' }]);
  });

  it('does not read the method of the next call as the method of this one', () => {
    // A window that ran to the end of the file would find the `DELETE` below and hand
    // it to `/rows`, which then compares against a route the bridge does serve. The
    // wrong answer would be a clean one.
    const body = [
      `export const rows = () => fetch(\`\${BRIDGE_URL}/rows\`);`,
      `export const drop = () => fetch(\`\${BRIDGE_URL}/row\`, { method: "DELETE" });`,
    ].join('\n');

    expect(callsIn(body, MENTION, 'studio.ts').calls).toEqual([
      { method: 'GET', path: '/rows' },
      { method: 'DELETE', path: '/row' },
    ]);
  });

  it('refuses when a call is written in a shape it cannot read', () => {
    // Two mentions of the bridge, one of them not followed by a path this parses.
    // Without the count, the second is skipped in silence and the run says clean.
    const body = [
      `export const rows = () => fetch(\`\${BRIDGE_URL}/rows\`);`,
      `export const usage = () => fetch(\`\${BRIDGE_URL}?since=\${from}\`);`,
    ].join('\n');

    const found = callsIn(body, MENTION, 'studio.ts');

    expect(found.calls).toHaveLength(1);
    expect(found.problems).toEqual([
      'studio.ts mentions the bridge 2 times but only 1 parsed as a route, so at least one ' +
        'call is written in a shape this check does not read',
    ]);
  });

  it('is quiet when every mention of the bridge came back out as a route', () => {
    const body = `fetch(\`\${BRIDGE_URL}/rows\`); fetch(\`\${BRIDGE_URL}/usage\`);`;

    expect(callsIn(body, MENTION, 'studio.ts').problems).toEqual([]);
  });

  it('reads a built chunk through whatever name the minifier gave the bridge', () => {
    // The identifier is per chunk and per build, so the same reader has to work on a
    // mention it was told about rather than one it knows.
    const body = `var w="http://127.0.0.1:4000";f(\`\${w}/rows\`),f(\`\${w}/row\`,{method:"PATCH"})`;
    const identifier = bridgeIdentifierIn(body, 'http://127.0.0.1:4000');

    const found = callsIn(body, `\${${identifier}}`, 'chunk');

    expect(found.problems).toEqual([]);
    expect(found.calls).toEqual([
      { method: 'GET', path: '/rows' },
      { method: 'PATCH', path: '/row' },
    ]);
  });
});

describe('the bridge constant in a built chunk', () => {
  it('finds the name the minifier bound the address to', () => {
    expect(bridgeIdentifierIn('let w=`http://127.0.0.1:4000`,x=1', 'http://127.0.0.1:4000')).toBe(
      'w',
    );
  });

  it('reads the address out of any quoting a bundler emits', () => {
    for (const quote of ['"', "'", '`']) {
      const body = `const q=${quote}http://127.0.0.1:4000${quote}`;
      expect(bridgeIdentifierIn(body, 'http://127.0.0.1:4000')).toBe('q');
    }
  });

  it('says so plainly when a chunk does not declare the bridge', () => {
    expect(bridgeIdentifierIn('var a=1;console.log(a)', 'http://127.0.0.1:4000')).toBeNull();
  });

  it('does not mistake a different address for the bridge', () => {
    // The dots in an address are regular expression wildcards until they are escaped,
    // and an unescaped read here would bind to a host nobody deployed and then report
    // that chunk's calls as the site's.
    const body = 'var w="http://127a0b0c1:4000"';

    expect(bridgeIdentifierIn(body, 'http://127.0.0.1:4000')).toBeNull();
  });
});

describe('the scripts a deployed page loads', () => {
  it('counts modulepreload, because the browser fetches those too', () => {
    // A reader that took only `<script src>` would miss the chunk carrying the calls
    // and report a page that calls nothing, which reads as agreement.
    const html = [
      '<link rel="modulepreload" href="/_next/static/chunks/bridge.js"/>',
      '<script src="/_next/static/chunks/main.js" async=""></script>',
    ].join('');

    expect(scriptsReferencedBy(html)).toEqual([
      '/_next/static/chunks/main.js',
      '/_next/static/chunks/bridge.js',
    ]);
  });

  it('names a script once however many times the page references it', () => {
    const html = [
      '<link rel="modulepreload" href="/chunks/a.js"/>',
      '<script src="/chunks/a.js"></script>',
    ].join('');

    expect(scriptsReferencedBy(html)).toEqual(['/chunks/a.js']);
  });

  it('finds a preload whatever order the bundler writes its attributes in', () => {
    // Attribute order is the bundler's to change, and unlike the calls there is no
    // count here that would notice half the preloads going missing: the only backstop
    // is every bridge-carrying chunk being missed at once, and today exactly one
    // chunk carries it.
    const html = [
      '<link href="/chunks/before.js" rel="modulepreload"/>',
      '<link rel="modulepreload" href="/chunks/after.js"/>',
    ].join('');

    expect(scriptsReferencedBy(html)).toEqual(['/chunks/before.js', '/chunks/after.js']);
  });

  it('does not read some other preloaded thing as a script', () => {
    const html = '<link rel="preload" as="font" href="/fonts/mono.woff2"/>';

    expect(scriptsReferencedBy(html)).toEqual([]);
  });
});

describe('the calls that use the bridge constant without the template head', () => {
  // The hole this closes had the same shape as the bug the whole check is about: a
  // call written by concatenation moves neither of the counts in `callsIn`, so the
  // run reported clean while a route went unchecked. Measured on a real client before
  // the fix, not reasoned about.
  const declaration = "export const BRIDGE_URL = 'http://127.0.0.1:4000';\n";

  it('refuses when the constant is used more often than calls were parsed', () => {
    const source = `${declaration}fetch(\`${MENTION}/rows\`);\nfetch(BRIDGE_URL + '/usage');\n`;

    expect(identifierReferenceProblems(source, 'BRIDGE_URL', 1, 'client.ts')).toEqual([
      'client.ts uses BRIDGE_URL 2 times outside its declaration but only 1 parsed as a ' +
        'route, so at least one call is written in a shape this check does not read',
    ]);
  });

  it('is quiet when every use of the constant was parsed as a route', () => {
    const source = `${declaration}fetch(\`${MENTION}/rows\`);\nfetch(\`${MENTION}/usage\`);\n`;

    expect(identifierReferenceProblems(source, 'BRIDGE_URL', 2, 'client.ts')).toEqual([]);
  });

  it('does not count the declaration as a use of the constant', () => {
    expect(identifierReferenceProblems(declaration, 'BRIDGE_URL', 0, 'client.ts')).toEqual([]);
  });

  it('does not mistake a longer name that contains this one for a use', () => {
    const source = `${declaration}const BRIDGE_URL_FALLBACK = 'x';\n`;

    expect(identifierReferenceProblems(source, 'BRIDGE_URL', 0, 'client.ts')).toEqual([]);
  });
});

describe('the route table of the published bridge', () => {
  it('reads every route the published bundle declares', () => {
    const bundle =
      'var R=[{method:"GET",path:"/rows"},{method:"PATCH",path:"/row"},' +
      "{ method: 'GET', path: '/usage' }];";

    const found = publishedRoutesIn(bundle, 'baseclf@0.4.16');

    expect(found.problems).toEqual([]);
    expect(found.routes.map(key)).toEqual(['GET /rows', 'PATCH /row', 'GET /usage']);
  });

  it('refuses when the published bundle has no route table it can read', () => {
    // Reading nothing must never mean "serves nothing", which would make the
    // comparison below fail loudly for the wrong reason, or pass for no reason at all.
    const found = publishedRoutesIn('var R=[{verb:"GET",url:"/rows"}];', 'baseclf@0.4.16');

    expect(found.routes).toEqual([]);
    expect(found.problems).toEqual([
      'no route table found in baseclf@0.4.16, so either the bridge stopped declaring one ' +
        'or its shape changed and this check can no longer read it',
    ]);
  });

  it('does not read a method with no path beside it as a route', () => {
    const found = publishedRoutesIn('fetch(u,{method:"POST"});var p={path:"/rows"};', 'spec');

    expect(found.routes).toEqual([]);
  });
});

describe('what is called against what npm serves', () => {
  const served = [
    { method: 'GET', path: '/rows' },
    { method: 'PATCH', path: '/row' },
  ];

  it('is silent when the published bridge serves every call', () => {
    expect(missingRoutes([{ method: 'GET', path: '/rows' }], served)).toEqual([]);
  });

  it('names a route that is called and not served', () => {
    const calls = [
      { method: 'GET', path: '/rows' },
      { method: 'GET', path: '/usage' },
    ];

    expect(missingRoutes(calls, served)).toEqual(['GET /usage']);
  });

  it('names a route once however many times it is called', () => {
    // Two reads of `/usage` are one missing route. Naming it twice would read as two
    // problems and put a number in the refusal that means nothing.
    const calls = [
      { method: 'GET', path: '/usage' },
      { method: 'GET', path: '/usage' },
    ];

    expect(missingRoutes(calls, served)).toEqual(['GET /usage']);
  });

  it('counts a method the bridge does not serve on a path it does', () => {
    // `/rows` is served, but not for writing. A comparison on paths alone would call
    // this clean and ship the screen that 404s.
    expect(missingRoutes([{ method: 'POST', path: '/rows' }], served)).toEqual(['POST /rows']);
  });
});
