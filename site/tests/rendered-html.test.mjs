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
    ["/studio/functions", /Run app logic/i],
    ["/studio/sql", /Ask the database directly/i],
    ["/studio/migrations", /Move the database forward/i],
    ["/studio/backups", /Go back to a known moment/i],
    ["/studio/webhooks", /Send the signal now/i],
    ["/studio/deployments", /A version is a snapshot/i],
    ["/studio/team", /Give people the work they need/i],
    ["/studio/api-keys", /Know which key exists/i],
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

test("keeps unfinished product contracts explicit", async () => {
  const [usage, realtime, keys] = await Promise.all([
    render("/studio/usage").then((response) => response.text()),
    render("/studio/realtime").then((response) => response.text()),
    render("/studio/api-keys").then((response) => response.text()),
  ]);

  assert.match(usage, /Illustrative numbers only/i);
  assert.match(realtime, /Planned — not enabled/i);
  assert.match(keys, /No usable credential/i);
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

  assert.match(home, /The operational suite/);
  assert.match(home, /name="overview"/);
  assert.match(home, /name="functions"/);
  assert.match(home, /name="deployments"/);
  assert.match(home, /name="backups"/);
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

  const shotNames = ["overview", "policy-studio", "sql-editor", "new-project", "provisioning", "api-explorer", "request-logs", "functions", "deployments", "backups"];
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
