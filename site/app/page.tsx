import type { Metadata } from "next";
import MotionEffects from "./MotionEffects";
import PolicyDemo from "./PolicyDemo";
import ThemeToggle from "./ThemeToggle";

export const metadata: Metadata = {
  title: "BaseCLF | The backend layer for Cloudflare",
  description:
    "Auth, database, storage, instant APIs, and real row-level security for Cloudflare D1.",
};

function ProductShot({
  name,
  alt,
  sizes,
  priority = false,
}: {
  name: string;
  alt: string;
  sizes: string;
  priority?: boolean;
}) {
  return (
    // Vinext currently returns the original image for width-query URLs; these generated files are the responsive optimizer.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/product-shots/${name}-640.webp`}
      srcSet={[
        `/product-shots/${name}-640.webp 640w`,
        `/product-shots/${name}-1080.webp 1080w`,
        `/product-shots/${name}-1200.webp 1200w`,
        `/product-shots/${name}.webp 1600w`,
      ].join(", ")}
      sizes={sizes}
      width={1600}
      height={1000}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"}
      decoding="async"
      alt={alt}
    />
  );
}

export default function Home() {
  return (
    <main>
      <MotionEffects />
      <nav className="site-nav" aria-label="Main navigation">
        <a className="brand" href="#top" aria-label="BaseCLF home">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>baseclf</span>
        </a>
        <div className="nav-links">
          <a href="#product">Product</a>
          <a href="#security">Security</a>
          <a href="/docs">Docs</a>
        </div>
        <div className="nav-actions">
          <ThemeToggle />
          <a className="nav-cta" href="/studio">Open Studio <span aria-hidden="true">↗</span></a>
        </div>
      </nav>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow"><span className="live-dot" /> Backend, already assembled</p>
          <h1>The backend you know.<br />Built for Cloudflare.</h1>
          <p className="hero-lede">
            Auth, database, storage, and instant APIs. Set up in minutes,
            with real row-level security for D1.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="/studio/new-project">Start building <span>↗</span></a>
            <a className="button button-secondary" href="#product">See how it works <span>↓</span></a>
          </div>
          <div className="hero-proof" aria-label="Product advantages">
            <span><b>01</b> The supabase-js query style carries over</span>
            <span><b>02</b> Runs in your Cloudflare account</span>
          </div>
        </div>

        <div className="hero-visual-wrap" id="product" data-parallax>
          <div className="rgb-field" aria-hidden="true" />
          <figure className="product-window product-screenshot-frame">
            <ProductShot name="overview" priority sizes="(max-width: 1100px) calc(100vw - 36px), 56vw" alt="BaseCLF Studio project overview using mock data, showing the next setup step, connected backend services, activity, and quick actions" />
          </figure>
        </div>
      </section>

      <section className="signal-strip" aria-label="BaseCLF value statement">
        <div className="signal-glow" aria-hidden="true" />
        <p>Supabase simplicity.</p>
        <p>Cloudflare ownership.</p>
        <p>Access rules on every request.</p>
      </section>

      <section className="product-tour-section reveal" aria-labelledby="product-tour-title">
        <div className="product-tour-heading">
          <div><p className="section-index">The operational suite</p><h2 id="product-tour-title">See the tools before you need them.</h2></div>
          <p>Functions, releases, and recovery stay approachable when the product grows beyond its first database and API.</p>
        </div>
        <div className="product-tour-grid" data-stagger>
          <a className="tour-card tour-card-wide" href="/studio/functions"><div className="tour-copy"><span>01 · Run app logic</span><h3>Handle a request—or a schedule.</h3><p>Write Worker-native functions, see what triggers them, and understand the last result without configuring a server.</p><b>Open Functions &amp; Cron ↗</b></div><figure><ProductShot name="functions" sizes="(max-width: 1100px) calc(100vw - 36px), 70vw" alt="Rendered BaseCLF Functions and Cron screen using mock data" /></figure></a>
          <a className="tour-card" href="/studio/deployments"><div className="tour-copy"><span>02 · Release safely</span><h3>Know exactly what is serving.</h3><p>Versions, active traffic, and rollback boundaries stay together on one understandable release timeline.</p><b>Open Deployments ↗</b></div><figure><ProductShot name="deployments" sizes="(max-width: 620px) calc(100vw - 36px), 50vw" alt="Rendered BaseCLF Deployments screen using mock data" /></figure></a>
          <a className="tour-card" href="/studio/backups"><div className="tour-copy"><span>03 · Recover deliberately</span><h3>Go back to a known moment.</h3><p>Restore points, imports, and exports make recovery explicit before any destructive action begins.</p><b>Open Backups ↗</b></div><figure><ProductShot name="backups" sizes="(max-width: 620px) calc(100vw - 36px), 50vw" alt="Rendered BaseCLF Backups and data transfer screen using mock data" /></figure></a>
        </div>
      </section>

      <section className="section setup-section reveal" id="start">
        <div className="section-heading split-heading">
          <div>
            <p className="section-index">01 / Quickstart</p>
            <h2>Three clear steps.<br />One working backend.</h2>
          </div>
          <p>No infrastructure vocabulary required. Follow the next action in Studio while BaseCLF assembles everything inside your Cloudflare account.</p>
        </div>

        <div className="setup-storyboard">
          <div className="setup-steps" data-stagger>
            <article className="setup-step is-current">
              <span>01</span><div><h3>Choose what you need</h3><p>Database, login, and file storage are plain choices—not infrastructure chores.</p></div><b>Now</b>
            </article>
            <article className="setup-step">
              <span>02</span><div><h3>Watch it assemble</h3><p>Every Cloudflare resource gets a readable status and a receipt you can keep.</p></div><b>Next</b>
            </article>
            <article className="setup-step">
              <span>03</span><div><h3>Make your first request</h3><p>Copy the familiar client snippet, test the API, and continue building your app.</p></div><b>Ready</b>
            </article>
            <a className="setup-link" href="/studio/new-project">Try the guided setup <span>↗</span></a>
          </div>

          <figure className="setup-stage" data-spotlight>
            <ProductShot name="new-project" sizes="(max-width: 900px) 100vw, 68vw" alt="BaseCLF Studio create project screen using mock data and showing simple backend choices" />
          </figure>
        </div>
        <div className="setup-proof-row"><span><b>01</b> Your Cloudflare account</span><span><b>02</b> Private by default</span><span><b>03</b> Setup receipt included</span></div>
      </section>

      <section className="capabilities-section" id="capabilities">
        <div className="capabilities-aurora" aria-hidden="true" />
        <div className="section-heading capabilities-heading reveal">
          <div>
            <p className="section-index">02 / Product</p>
            <h2>A complete backend.<br />A calmer way to run it.</h2>
          </div>
          <p>Start with the task in front of you. BaseCLF reveals the Cloudflare detail only when it helps—not before.</p>
        </div>

        <div className="capability-showcase reveal" data-stagger>
          <a className="capability-screen capability-screen-api" href="/studio/api" data-spotlight>
            <div className="capability-screen-copy"><span>01 · Build and test</span><h3>Try the API before writing app code.</h3><p>Choose an action, inspect the exact request, see the protected response, then copy the client code.</p><b>Open API Explorer ↗</b></div>
            <figure><ProductShot name="api-explorer" sizes="(max-width: 900px) 100vw, 68vw" alt="Rendered BaseCLF API Explorer with request builder and protected response" /></figure>
          </a>
          <a className="capability-screen capability-screen-logs" href="/studio/logs" data-spotlight>
            <div className="capability-screen-copy"><span>02 · Understand production</span><h3>Find what happened without reading infrastructure logs.</h3><p>Request, policy decision, timing, and trace stay together in one readable view.</p><b>Open Request Logs ↗</b></div>
            <figure><ProductShot name="request-logs" sizes="(max-width: 900px) 100vw, 68vw" alt="Rendered BaseCLF request logs with policy trace and mock metrics" /></figure>
          </a>
        </div>
        <div className="capability-pill-row reveal" data-stagger>
          <span><i>DB</i><b>D1 database</b><small>Instant API included</small></span>
          <span><i>ID</i><b>Authentication</b><small>Google + GitHub sign-in</small></span>
          <span><i>FS</i><b>R2 storage</b><small>Protected file access</small></span>
          <span><i>CLI</i><b>One-command deploy</b><small>create-baseclf provisions it</small></span>
        </div>
        <p className="advanced-line">CLI for repeatable workflows <span>•</span> Studio for guided work <span>•</span> Code remains the source of truth</p>
      </section>

      <section className="section security-section reveal" id="security">
        <div className="security-copy">
          <p className="section-index">03 / The moat</p>
          <h2>Row-level security,<br />even on D1.</h2>
          <p className="security-lede">Write each rule once. BaseCLF applies it to every request, so users only receive the rows they are allowed to see.</p>
          <div className="security-rules" data-stagger>
            <div><span className="rule-icon rule-allow">✓</span><p><b>No policy means no access.</b><small>A forgotten rule cannot expose a table.</small></p></div>
            <div><span className="rule-icon rule-deny">×</span><p><b>Clients cannot widen access.</b><small>Your application filter is always combined with the policy.</small></p></div>
            <div><span className="rule-icon rule-attention">!</span><p><b>Expensive rules are surfaced.</b><small>Missing indexes are reported where you fix them.</small></p></div>
          </div>
          <a className="text-link" href="/docs/policies">Read the security boundary <span>↗</span></a>
        </div>

        <figure className="policy-product-frame" data-spotlight data-parallax>
          <div className="policy-frame-glow" aria-hidden="true" />
          <ProductShot name="policy-studio" sizes="(max-width: 900px) 100vw, 66vw" alt="Rendered BaseCLF Policy Studio using mock data and comparing row access for two users" />
        </figure>
      </section>

      <PolicyDemo />

      <section className="ownership-section reveal" id="ownership" data-stagger>
        <div className="ownership-panel">
          <p className="section-index">04 / Ownership</p>
          <h2>Your infrastructure<br />stays yours.</h2>
          <p>BaseCLF runs inside your Cloudflare account. Your data, resources, and operational path remain visible to you.</p>
          <div className="ownership-map">
            <div className="ownership-node"><span>01</span><b>Your app</b><small>Web or mobile</small></div><i>→</i>
            <div className="ownership-node is-core"><span>02</span><b>Your BaseCLF Worker</b><small>Auth · API · policies</small></div><i>→</i>
            <div className="ownership-node"><span>03</span><b>D1 + R2</b><small>Your Cloudflare account</small></div>
          </div>
          <figure className="ownership-shot"><ProductShot name="provisioning" sizes="(max-width: 900px) 100vw, 50vw" alt="BaseCLF provisioning receipt using mock data and showing resources created inside the user's Cloudflare account" /></figure>
        </div>

        <div className="compat-panel" id="docs">
          <p className="section-index">05 / Compatibility</p>
          <h2>Keep the client<br />you already know.</h2>
          <p>Keep the query style you know. The client is <code>baseclf-js</code>, there is no anonymous key, and no token simply means the anon role.</p>
          <pre aria-label="JavaScript client example"><code><span>import</span> {'{'} createClient {'}'} <span>from</span> <em>&quot;baseclf-js&quot;</em>{"\n\n"}<span>const</span> client = createClient({"\n"}  <em>&quot;https://field-notes.baseclf.workers.dev&quot;</em>{"\n"}){"\n\n"}<span>const</span> {'{'} data {'}'} = <span>await</span> client{"\n"}  .from(<em>&quot;posts&quot;</em>){"\n"}  .select(<em>&quot;*&quot;</em>)</code></pre>
          <div className="compat-diff" aria-label="Compatibility summary">
            <div><span>Change</span><p><b>Package + URL</b><small>Import baseclf-js and point it at your Worker. No anon key exists.</small></p></div>
            <div><span>Keep</span><p><b>Query style</b><small>.from().select(), the filters, inserts, updates, and deletes.</small></p></div>
            <div><span>Gain</span><p><b>Cloudflare ownership</b><small>D1, R2, and Worker resources remain in your account.</small></p></div>
          </div>
        </div>
      </section>

      <section className="boundary-section reveal" id="boundary">
        <div className="boundary-heading">
          <p className="section-index">06 / Honest limits</p>
          <h2>Know exactly where protection applies.</h2>
          <p>BaseCLF is explicit about the boundary, so the safe path is obvious to every person on the team.</p>
        </div>
        <div className="boundary-paths" data-stagger>
          <article className="boundary-path is-protected"><span>Protected path</span><h3>App → BaseCLF API → policy → D1</h3><p>Every user request is checked before rows leave the database.</p><b><i /> Recommended for product access</b></article>
          <article className="boundary-path"><span>Administrative path</span><h3>wrangler d1 execute → D1</h3><p>Direct account-level commands bypass the policy engine by design.</p><b>Use only for trusted operations</b></article>
        </div>
        <div className="boundary-footer"><p><code>Simple rule:</code> application traffic uses the client or API; direct Wrangler access stays an admin tool.</p><a className="text-link" href="/docs/compatibility">Read every caveat <span>↗</span></a></div>
      </section>

      <section className="final-cta reveal" data-parallax>
        <div className="final-light" aria-hidden="true" />
        <p className="section-index">Open source. Your account. Your data.</p>
        <h2>Build on Cloudflare without<br />building the backend first.</h2>
        <p>Start with one command. Keep control of every layer.</p>
        <div className="hero-actions final-actions">
          <a className="button cta-white" href="/studio/new-project">Create a project <span>↗</span></a>
          <a className="button cta-dark" href="/docs">Read the docs <span>→</span></a>
        </div>
      </section>

      <footer className="site-footer">
        <div className="footer-brand">
          <a className="brand" href="#top"><span className="brand-mark" aria-hidden="true"><span /></span><span>baseclf</span></a>
          <p>The backend layer for Cloudflare.</p>
        </div>
        <div className="footer-links">
          <div><b>Product</b><a href="#capabilities">Overview</a><a href="#security">Security</a><a href="/docs/quickstart">Quickstart</a></div>
          <div><b>Developers</b><a href="/docs">Docs</a><a href="/docs/policies">Policy DSL</a><a href="/docs/compatibility">Compatibility</a></div>
          <div><b>Project</b><a href="https://github.com/baseclf/baseclf">GitHub</a><a href="#boundary">Caveats</a><a href="https://github.com/baseclf/baseclf/blob/main/LICENSE">License</a></div>
        </div>
        <div className="footer-bottom"><span>© 2026 BaseCLF</span><span>Built for Cloudflare developers.</span></div>
      </footer>
    </main>
  );
}
