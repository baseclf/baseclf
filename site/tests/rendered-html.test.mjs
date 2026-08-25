import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders every BaseCLF product surface", async () => {
  const cases = [
    ["/", /The backend you know/],
    ["/studio", /Generated SQL/i],
    ["/studio/new-project", /Choose what you need/i],
    ["/studio/provisioning", /Building inside your Cloudflare account/i],
    ["/studio/overview", /Ready to connect/i],
    ["/studio/api", /Try the API before writing app code/i],
    ["/studio/logs", /Find what happened/i],
    ["/studio/sql", /Ask the database directly/i],
    ["/studio/migrations", /Move the database forward/i],
    ["/studio/backups", /Go back to a known moment/i],
    ["/studio/webhooks", /Send the signal now/i],
    ["/studio/deployments", /A version is a snapshot/i],
    ["/studio/usage", /See what your app uses/i],
    ["/studio/realtime", /Understand the channel/i],
    ["/studio/settings", /without exposing its secrets/i],
    ["/docs", /BaseCLF documentation/i],
    ["/docs/quickstart", /empty Cloudflare account/i],
    ["/docs/policies", /Policy rules/i],
    ["/docs/compatibility", /what carries over/i],
    ["/example", /One query/i],
  ];

  for (const [path, content] of cases) {
    const response = await render(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i, path);
    const html = await response.text();
    assert.match(html, /<html[^>]*data-theme="light"/i, path);
    assert.match(html, content, path);
  }
});

test("keeps fixture surfaces labeled and the example wired to a real deployment", async () => {
  const [layout, themeToggle, studio, example] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ThemeToggle.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/studio/StudioApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/example/ExampleApp.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /data-theme="light"/);
  assert.doesNotMatch(themeToggle, /prefers-color-scheme|matchMedia/);
  assert.match(themeToggle, /localStorage/);
  assert.match(studio, /Mock data/);
  assert.match(studio, /Fixture-backed preview/);
  // The example talks to a real deployment through the published client. The
  // address comes from the environment only: a hard-coded deployment URL in the
  // public site is exactly what decision Q8 forbids.
  assert.match(example, /VITE_BASECLF_URL/);
  assert.match(example, /signInWithOAuth/);
  assert.match(example, /client\.from\(/);
  assert.doesNotMatch(example, /workers\.dev/);
  assert.doesNotMatch(example, /mockExamplePosts/);
});

test("keeps the matched studio screens on the deployment, not on fixtures", async () => {
  const [overview, explorer, studio, client, deployment] = await Promise.all([
    readFile(new URL("../app/studio/overview/OverviewApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/studio/api/ApiExplorerApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/studio/StudioApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/api/studio.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/api/deployment.ts", import.meta.url), "utf8"),
  ]);

  // Overview composes the three public surfaces and imports no fixture.
  assert.doesNotMatch(overview, /mock-data/);
  assert.match(deployment, /\/health/);
  assert.match(deployment, /_diagnose/);
  assert.match(deployment, /_schema/);

  // The explorer sends real anonymous requests and shows what D1 actually
  // scanned. Reads only: the method select never offers a write.
  assert.doesNotMatch(explorer, /mock-data/);
  assert.match(deployment, /x-baseclf-rows-read/);
  assert.match(deployment, /x-d1-bookmark/);
  assert.doesNotMatch(explorer, /<option>POST<\/option>|<option>PATCH<\/option>|<option>DELETE<\/option>/);

  // The live Tables screen reads names and shapes from the deployment's own
  // schema tools, and never claims a row count it would have to scan for.
  assert.match(studio, /LiveTablesScreen/);
  assert.match(client, /schema_list/);
  assert.match(client, /schema_describe/);

  // The live Auth screen reads the deployment's own diagnostic, which reports
  // presence and never a value, and it renders no user list: `user`, `session`,
  // `account`, `verification`, and `jwks` are reserved names that the
  // catalogue, the REST router, and the bridge each refuse. A screen that drew
  // an empty table there would read as "no users" instead of "not readable".
  assert.match(studio, /LiveAuthScreen/);
  assert.match(deployment, /readDiagnose/);
  const liveAuth = studio.slice(studio.indexOf("function LiveAuthScreen"), studio.indexOf("function AuthScreen"));
  assert.doesNotMatch(liveAuth, /mockUsers/);
  assert.doesNotMatch(liveAuth, /rest\/v1\/user|from\(["'`]user/);
  assert.match(liveAuth, /reserved names/);

  // The shared connection carries the origin only: one string key in
  // sessionStorage, no client object, no credential field. The admin token
  // stays in the Studio page's memory.
  const connection = await readFile(new URL("../app/studio/connection.ts", import.meta.url), "utf8");
  assert.match(connection, /sessionStorage/);
  assert.doesNotMatch(connection, /StudioClient|#token|authorization|Bearer/);
  assert.doesNotMatch(studio, /setSharedOrigin\([^n)]*token/i);

  // Disconnecting replaces the notice along with everything else the
  // connection owned. A failure about a deployment used to outlive it and
  // follow the person onto the fixture screen, where it read as a statement
  // about the fixture; watched that happen before pinning it.
  const disconnect = studio.slice(studio.indexOf("const disconnect ="), studio.indexOf("const disconnect =") + 700);
  assert.match(disconnect, /clearStoredSession\(\)/);
  assert.match(disconnect, /setNotice\(/);

  // Real-data hardening: engine timestamps are unix seconds and any TEXT
  // column can be 500 characters, so cells go through one formatter; a 429
  // becomes a ticking cooldown from the deployment's own Retry-After, and
  // never an automatic retry.
  const format = await readFile(new URL("../app/lib/format.ts", import.meta.url), "utf8");
  assert.match(format, /toISOString/);
  assert.match(format, /MAX_CELL_CHARS/);
  assert.match(studio, /formatCell/);
  assert.match(studio, /retryAfterSeconds/);
  assert.match(studio, /useOverlayFocus/);
  assert.match(client, /retry-after/);
  assert.doesNotMatch(client, /setTimeout[^\n]*#rpc|retry\(/);
});

test("keeps unfinished product contracts explicit", async () => {
  const [usage, realtime, settings] = await Promise.all([
    render("/studio/usage").then((response) => response.text()),
    render("/studio/realtime").then((response) => response.text()),
    readFile(new URL("../app/studio/settings/SettingsApp.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(usage, /Illustrative numbers only/i);
  assert.match(realtime, /Planned — not enabled/i);
  // The API Keys screen collapsed into a Settings section: the product's one
  // admin credential is the MCP_TOKEN secret, set with the CLI's own command,
  // never typed here. Read from the source because the tab renders on selection.
  assert.match(settings, /Admin token/);
  assert.match(settings, /MCP_TOKEN/);
  assert.match(settings, /baseclf secret set/);
  assert.doesNotMatch(settings, /mockEnvironments/);
});

test("a screen without a backend says COMING SOON and disables everything below it", async () => {
  // Every Q4 "coming soon" verdict, as rendered output: the banner is present
  // and the preview below it is inert, which is what ended the fake toasts.
  const surfaces = [
    "/studio/logs",
    "/studio/sql",
    "/studio/migrations",
    "/studio/backups",
    "/studio/webhooks",
    "/studio/deployments",
    "/studio/usage",
    "/studio/new-project",
    "/studio/provisioning",
  ];
  for (const path of surfaces) {
    const html = await render(path).then((response) => response.text());
    assert.match(html, /COMING SOON/, path);
    assert.match(html, /planned-scope/, path);
    assert.match(html, /inert/, path);
  }

  // The removed screens are gone from the product, not merely unlinked.
  for (const path of ["/studio/team", "/studio/api-keys", "/studio/functions"]) {
    const response = await render(path);
    assert.notEqual(response.status, 200, path);
  }

  // And the sidebar no longer offers them anywhere.
  const anySuitePage = await render("/studio/logs").then((response) => response.text());
  assert.doesNotMatch(anySuitePage, /studio\/(team|api-keys|functions)/);
});

test("ships the guided motion system and real product captures", async () => {
  const [home, motion, landingMotion, policyDemo, themeToggle, llms, globals] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ExperienceMotion.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/MotionEffects.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/PolicyDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ThemeToggle.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/llms.txt", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // The funnel has both doors: view the demo, or connect a real deployment,
  // which deep-links straight into the connect screen with its setup guide.
  // The connect door lives in its own client component so it can read this
  // tab's saved session and swap to "Dashboard" once the person is signed in.
  assert.match(home, /View demo/);
  assert.match(home, /<NavCta \/>/);
  const navCta = await readFile(new URL("../app/NavCta.tsx", import.meta.url), "utf8");
  assert.match(navCta, /Connect live/);
  assert.match(navCta, /Dashboard/);
  assert.match(navCta, /\/studio\?connect=1/);
  assert.match(navCta, /onSessionChange/);
  // The docs topbar makes the same offer: its Studio link reads the browser's
  // saved session after hydration and swaps to Dashboard, so a reader who
  // already connected is not routed through the connect flow again.
  const docsShell = await readFile(new URL("../app/docs/DocsShell.tsx", import.meta.url), "utf8");
  assert.match(docsShell, /Open Studio/);
  assert.match(docsShell, /Dashboard/);
  assert.match(docsShell, /onSessionChange/);
  const studioApp = await readFile(new URL("../app/studio/StudioApp.tsx", import.meta.url), "utf8");
  assert.match(studioApp, /First deployment\?/);
  assert.match(studioApp, /npx create-baseclf/);
  // The Tables screen's row browse: the panel names what it is (the operator's
  // view, not a caller's), rows load only on a click, and pages are numbered
  // rather than counted, so no scan runs that nobody asked for.
  assert.match(studioApp, /operator view, no policy applied/);
  assert.match(studioApp, /Load latest rows/);
  assert.match(studioApp, /browseOnBridge/);
  // Four findings from the first real walkthrough, pinned: the guide bar
  // speaks live copy on a live connection instead of the fixture's, the fake
  // setup counter stays with the fixture, a reload shows a reconnecting state
  // rather than a flash of mock screens, and a token refused right after
  // secret set explains the propagation window instead of inviting a re-set.
  // ⚠️ This used to look for the string "fixture preview", which was a MARKER for
  // the property rather than the property: the guide bar reading live copy on a
  // live connection. Storage was the last screen carrying that phrase, and when it
  // went live the marker vanished while the behaviour stayed. Pinned to the choice
  // itself now, which is the thing that would actually be wrong if somebody
  // rendered the fixture line to a connected deployment.
  assert.match(studioApp, /mode === "live" \? guidance\[screen\]\.live : guidance\[screen\]\.demo/);
  assert.match(studioApp, /mode !== "live" && <div className="studio-project-progress">/);
  assert.match(studioApp, /Reconnecting to your saved deployment/);
  assert.match(studioApp, /take a minute or two to reach the version that answers/);
  // A failed live read is surfaced, never rendered as an empty database: the
  // Tables screen says the read failed and offers to read again, instead of
  // sending a rate-limited person into more refreshes.
  assert.match(studioApp, /Could not read the deployment/);
  assert.match(studioApp, /problem,\n/);
  // The wizard's promise, pinned: every check mark is a real round trip, the
  // token stays out of the downloaded notes unless explicitly included, and
  // the flow ends in a download plus a connect that reuses the proven client.
  assert.match(studioApp, /Step 1 of 4/);
  assert.match(studioApp, /Step 4 of 4/);
  assert.match(studioApp, /Download setup notes/);
  assert.match(studioApp, /includeToken \? wizard\.token : /);
  // The account prerequisites come before the first command, and Next stays
  // dark until both are confirmed: a Cloudflare login on the machine, and R2
  // turned on in the account. The page cannot see either, so they are the two
  // checks the person makes rather than round trips the page proves.
  assert.match(studioApp, /npx wrangler whoami/);
  assert.match(studioApp, /npx wrangler login/);
  assert.match(studioApp, /Authorization granted to Wrangler/);
  // The token step teaches the CLI's own secret command, whose terminal shot
  // carries the Enter-to-generate default and the clipboard line.
  assert.match(studioApp, /baseclf secret set MCP_TOKEN --script/);
  assert.match(studioApp, /Generated a strong value/);
  assert.match(studioApp, /in your clipboard/);
  assert.match(studioApp, /disabled=\{!authReady \|\| !r2Ready\}/);
  assert.match(studioApp, /R2 Object Storage/);

  assert.match(home, /The operational suite/);
  assert.match(home, /name="overview"/);
  assert.match(home, /name="request-logs"/);
  assert.match(home, /name="deployments"/);
  assert.match(home, /name="backups"/);
  // The landing tour only points at screens that exist. Functions was removed
  // by decision Q4: the customer owns the Worker, so "deploy a function" is
  // not this product.
  assert.doesNotMatch(home, /studio\/(functions|team|api-keys)/);
  assert.match(home, /srcSet=/);
  assert.match(home, /Three clear steps/);
  assert.match(home, /A calmer way to run it/);
  assert.match(home, /Know exactly where protection applies/);
  assert.doesNotMatch(home, /Actual interface · mock data|Studio walkthrough|Fixture-backed preview|Real product screen/);
  assert.match(policyDemo, /aria-pressed/);
  assert.match(policyDemo, /aria-live="polite"/);
  assert.match(policyDemo, /useState<User>/);
  assert.match(motion, /prefers-reduced-motion/);
  assert.match(landingMotion, /getBoundingClientRect/);
  const measurementsIndex = landingMotion.indexOf("parallaxMeasurements");
  assert.ok(measurementsIndex > -1);
  assert.ok(measurementsIndex < landingMotion.indexOf('root.style.setProperty("--page-progress"', measurementsIndex));
  assert.match(themeToggle, /\$\{currentLabel\} theme; switch to/);
  assert.match(llms, /\[Documentation\]\(\/docs\/index\.md\)/);
  assert.match(globals, /--ease-standard/);
  assert.match(globals, /hero-copy > h1:nth-child\(2\).*hero-headline-enter/);
  assert.match(globals, /@keyframes hero-headline-enter \{ from \{ transform:/);
  assert.match(globals, /route-content-enter/);
  assert.match(globals, /object-fit:contain/);

  // Only shots a page actually renders. "functions" left with its screen
  // (decision Q4); "sql-editor" was captured but never displayed anywhere.
  const shotNames = ["overview", "policy-studio", "new-project", "provisioning", "api-explorer", "request-logs", "deployments", "backups"];
  const pairs = await Promise.all(shotNames.map(async (name) => ({
    png: await stat(new URL(`../public/product-shots/${name}.png`, import.meta.url)),
    webp: await stat(new URL(`../public/product-shots/${name}.webp`, import.meta.url)),
    responsive: await Promise.all([640, 1080, 1200].map((width) =>
      stat(new URL(`../public/product-shots/${name}-${width}.webp`, import.meta.url))
    )),
  })));
  for (const { png, webp, responsive } of pairs) {
    assert.ok(png.size > 50_000);
    assert.ok(webp.size > 20_000);
    assert.ok(webp.size < png.size);
    for (const variant of responsive) {
      assert.ok(variant.size > 5_000);
      assert.ok(variant.size < webp.size);
    }
  }
});

// Three surfaces describe Studio to a reader who cannot see it: the docs page,
// its markdown twin, and llms.txt. All three said Studio ran on fixture data,
// and all three were still saying it after the Simulator, Policies, and Tables
// screens started reading a real deployment. Nothing checked prose, so the
// claim went stale in place and only a person reading it would notice.
//
// This does not pin wording. It pins the part that went wrong: a surface that
// mentions fixtures must also name the screens that are live, so promoting a
// fourth screen fails here until every copy is updated.
test("keeps every written claim about Studio in step with what Studio does", async () => {
  const [page, markdown, llms, studio] = await Promise.all([
    readFile(new URL("../app/docs/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/docs/index.md", import.meta.url), "utf8"),
    readFile(new URL("../public/llms.txt", import.meta.url), "utf8"),
    readFile(new URL("../app/studio/StudioApp.tsx", import.meta.url), "utf8"),
  ]);

  // The screens the guidance table still calls a fixture preview, and the ones
  // it does not. Read from the component so the source of truth is the code.
  const previews = [...studio.matchAll(/^ {2}(\w+): \{ label:.*?fixture preview/gm)].map(([, name]) => name);
  // Empty since 2026-08-24. Storage was the last one, and it went live on the RULES
  // rather than on the objects, which is a distinction every surface below has to
  // carry: a screen described as live that then lists no files would read as broken,
  // and one described as listing files would be a promise nothing can keep, because a
  // directory belongs to a caller and Studio holds a credential rather than an
  // identity.
  assert.deepEqual(previews, []);

  for (const [surface, text] of [["docs page", page], ["markdown twin", markdown], ["llms.txt", llms]]) {
    assert.match(text, /fixture/i, surface);
    assert.match(text, /Simulator, Policies, Tables, Auth, Storage, and Health/, surface);
    // The sentence that went stale: fixtures with no mention of a live screen.
    assert.doesNotMatch(text, /screens in (the|this) preview (still )?run on fixture data/i, surface);
    // 🔴 The regex this replaces let a false claim ride for two days. It accepted
    // any one of three alternatives, so "are not read there" kept passing after
    // the Health screen grew a button that reads exactly those numbers through
    // the bridge (2026-08-23). The property now is two-sided: the true half must
    // be present, and the disproven claim must be absent.
    assert.match(text, /recorded against your Cloudflare account/i, surface);
    assert.doesNotMatch(text, /not read (?:there|here)/i, surface);
  }
});

// The half of Health that has a source without the operator's Cloudflare
// credential is real; the half that does not is absent rather than mocked. The
// distinction the screen turns on is that nothing-wrong and could-not-look are
// different answers: an empty warning list drawn for a failed read is the
// interface version of failing open.
test("Health reports what the deployment can check and declines the rest", async () => {
  const studio = await readFile(new URL("../app/studio/StudioApp.tsx", import.meta.url), "utf8");
  const start = studio.indexOf("function LiveHealthScreen");
  assert.ok(start > 0, "expected a live Health screen");
  const health = studio.slice(start, studio.indexOf("function HealthScreen"));

  // Both real sources, and no fixture.
  assert.match(health, /readDiagnose/);
  assert.match(health, /live\.findings/);
  assert.doesNotMatch(health, /mockHealth|mock-badge|mock-chart/);

  // A failed read is said out loud, separately from a clean result.
  assert.match(health, /were not read/i);
  assert.match(health, /Nothing to report/i);

  // 🔴 The two assertions above are not enough, and a canary proved it: changing
  // the unreadable case from `undefined` to `[]` left both strings in the file
  // and every test green, while the screen quietly reported "nothing wrong" for
  // a read that never happened. The harness renders pages server-side and a
  // connected Studio only exists in the browser, so there is no way to drive
  // that state here. Pinning the decision itself is what is left: both sources
  // must carry `undefined` for "could not look", which is what keeps it distinct
  // from an empty list. Changing these two lines has to be a deliberate act.
  assert.match(health, /const configWarnings = diagnose\?\.warnings;/);
  assert.match(health, /const indexFindings = live\?\.problem === "" \? live\.findings : undefined;/);
  // And the count must follow that distinction rather than treating absent as zero.
  assert.match(health, /readable\s*\?\s*`\$\{total\}\s*item/);
  assert.match(health, /:\s*"partly readable"/);

  // The numbers come from the account through the bridge, never from this page:
  // the credential that reads them is the operator's and lives on their machine.
  assert.match(health, /usageOnBridge/);
  assert.match(health, /bridgeKey/);
  assert.match(health, /Cloudflare/);
  assert.doesNotMatch(health, /mock-chart/);

  // Four states for the numbers, not two. A refusal is Cloudflare declining to
  // answer, which is not the same as a deployment with no traffic, and the
  // permission list `create-baseclf` prints does not include the one this needs,
  // so a refusal is the expected outcome rather than a rare one.
  assert.match(health, /kind: "said"/);
  assert.match(health, /were not readable/i);
  assert.match(health, /npx baseclf studio/);

  // The numbers are labelled with the Worker they belong to. An unfiltered read
  // would report every Worker on the account under one deployment's name.
  assert.match(health, /scriptName/);
  assert.match(health, /not for the whole account/i);

  // An error count that is not split by kind puts two unrelated situations under
  // one number: code that threw, and a request the platform stopped. Whoever
  // reads this does different work for each, so the screen names both.
  assert.match(health, /exceededResources/);
  assert.match(health, /scriptThrewException/);

  // 🔴 Absent and empty again, the same distinction this file already pins for
  // warnings, on a field that arrives from a separately released bridge. An older
  // bridge sends no kinds at all, and treating that as "nothing failed" would
  // report a clean split for a read that never happened.
  assert.match(health, /failures === undefined/);
  assert.match(health, /failures !== undefined && usage\.numbers\.failures\.length > 0/);

  // Measured 2026-08-25: the dataset samples, and driving a known number of
  // requests came back both low and high. A screen printing an exact figure
  // beside the word "requests" is presenting an estimate as a count.
  assert.match(health, /sampled rather than counted/i);

  // The fixture screen keeps its chart: disconnected Studio is still a demo.
  const fixture = studio.slice(studio.indexOf("function HealthScreen"), studio.indexOf("function StateGallery"));
  assert.match(fixture, /mock-chart/);
});

// Found by the 2026-08-25 audit, not by a failing test, which is why these pins
// exist now. Two surfaces were quietly out of step with decisions already made:
// the landing's primary calls to action sent a visitor to a screen whose first
// line says "not in this build" while the real path has been on npm for weeks,
// and the Settings screen still carried the one fake save toast that outlived
// decision Q4 — with fail-closed drawn as a checked TOGGLE, which reads as
// optional and is the opposite of what makes it an invariant.
test("the landing promises land on real paths, and Settings stops pretending", async () => {
  const landing = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  // The two conversion actions go to the quickstart, which is real, rather than
  // to a disabled preview. The preview links still exist and say what they are.
  assert.match(landing, /href="\/docs\/quickstart">Start building/);
  assert.match(landing, /href="\/docs\/quickstart">Create a project/);
  assert.doesNotMatch(landing, /Open Request Logs|Open Deployments|Open Backups|Try the guided setup/);
  assert.match(landing, /Preview Request Logs/);

  const settings = await readFile(new URL("../app/studio/settings/SettingsApp.tsx", import.meta.url), "utf8");

  // No control that saves nothing, and no toggle on an invariant. The engine's
  // guarantees appear as statements; the only buttons that act are the ones that
  // copy a real CLI command.
  assert.doesNotMatch(settings, /Mock project details saved/);
  assert.doesNotMatch(settings, /checkbox/);
  assert.match(settings, /Fail-closed is how the engine is built/);
  assert.match(settings, /<button type="button" disabled>Disconnect<\/button>/);
});

// llms.txt points a reader that cannot run JavaScript at the markdown twins,
// so those are the copies an agent quotes back to somebody. The compatibility
// twin listed a status of "planned" while the legend defining it lived only on
// the HTML page, and "planned" read alone is heard as "arriving", which is the
// one reading the page exists to prevent.
test("the markdown a bot reads defines the status words it uses", async () => {
  const markdown = await readFile(new URL("../public/docs/compatibility.md", import.meta.url), "utf8");

  for (const status of ["supported", "off by default", "planned", "not applicable"]) {
    assert.match(markdown, new RegExp(status, "i"), status);
  }
  assert.match(markdown, /Planned is roadmap language, not an available production feature/i);
  assert.match(markdown, /source of truth/i);
});

// A client that fetched llms.txt first finds the markdown twins listed there.
// A client that just asks for the page and states what it reads used to get
// html regardless, measured on the deployed site before this existed. The
// negotiation answers that case, and the risk it carries is the opposite one:
// handing markdown to an ordinary browser, which sends a match-anything entry
// at the end of every Accept header.
async function fetchDocs(path, accept) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}`);
  const { default: worker } = await import(workerUrl.href);

  // ASSETS reads dist/client, which is what the deployed binding serves. Reading
  // public/ instead would be a harness that proves the build copies nothing.
  const assets = {
    async fetch(request) {
      const name = new URL(request.url).pathname;
      try {
        const body = await readFile(new URL(`../dist/client${name}`, import.meta.url), "utf8");
        return new Response(body, { status: 200, headers: { "content-type": "text/markdown" } });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  };

  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: accept === null ? {} : { accept } }),
    { ASSETS: assets },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("hands a documentation page to whichever reader asked, and says the answer varies", async () => {
  const source = await readFile(new URL("../worker/docs-markdown.ts", import.meta.url), "utf8");
  const tableStart = source.indexOf("const MARKDOWN_TWIN");
  const table = source.slice(tableStart, source.indexOf("]);", tableStart));
  const pairs = [...table.matchAll(/\["(\/[^"]*)",\s*"(\/[^"]*)"\]/g)].map((m) => [m[1], m[2]]);

  // The table is closed, so it can be checked. Every page it claims to answer
  // for has to be a page, and every twin has to be a file the build shipped:
  // a missing twin makes the worker fall back to html silently, and this is
  // what makes that visible instead.
  assert.equal(pairs.length, 4, "expected four documentation pages");
  for (const [page, twin] of pairs) {
    await stat(new URL(`../dist/client${twin}`, import.meta.url));
    const asked = await fetchDocs(page, "text/markdown");
    assert.equal(asked.status, 200, page);
    assert.match(asked.headers.get("content-type") ?? "", /^text\/markdown\b/, page);
    assert.equal(asked.headers.get("vary"), "Accept", page);
    const body = await asked.text();
    assert.doesNotMatch(body, /^\s*</, `${page} answered html under a markdown content type`);
    assert.match(body, /^#\s/, page);
  }

  // The other direction. Each of these is a header a real client sends, and
  // each one has to keep getting the page.
  const browser = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
  const staysHtml = [
    [null, "no accept header"],
    ["*/*", "curl"],
    [browser, "a browser"],
    ["text/*", "any text type, which does not name markdown"],
    ["text/html, text/markdown;q=0.1", "markdown named but ranked below html"],
    ["text/markdown;q=0", "markdown named as unacceptable"],
  ];

  // The framework ships its own Vary list, which is how a cache tells a
  // client-side navigation payload from a full page. Adding Accept must not
  // cost those: the first version of this replaced the header outright, and
  // this is the assertion that caught it.
  const framework = (await fetchDocs("/studio", null)).headers.get("vary") ?? "";
  assert.match(framework, /RSC/, "expected the framework to vary on its own headers");

  for (const [accept, reason] of staysHtml) {
    const response = await fetchDocs("/docs/quickstart", accept);
    assert.equal(response.status, 200, reason);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/, reason);
    // Still varies: a cache that stored this must not replay it to the agent.
    const vary = response.headers.get("vary") ?? "";
    assert.match(vary, /\bAccept\b/, reason);
    for (const entry of framework.split(",").map((part) => part.trim())) {
      assert.ok(vary.includes(entry), `${reason} dropped ${entry} from Vary`);
    }
  }

  // Trailing slash is the same page; a path with no twin is not negotiated at
  // all, so it neither answers markdown nor claims to vary on Accept.
  const slashed = await fetchDocs("/docs/", "text/markdown");
  assert.match(slashed.headers.get("content-type") ?? "", /^text\/markdown\b/);

  const elsewhere = await fetchDocs("/studio", "text/markdown");
  assert.match(elsewhere.headers.get("content-type") ?? "", /^text\/html\b/);
  assert.doesNotMatch(elsewhere.headers.get("vary") ?? "", /\bAccept\b/);
});
