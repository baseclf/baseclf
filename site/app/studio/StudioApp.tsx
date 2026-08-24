"use client";

import { FormEvent, ReactNode, RefObject, useEffect, useRef, useState } from "react";
import Link from "next/link";
import ThemeToggle from "../ThemeToggle";
import {
  applyOnBridge,
  type BridgeRows,
  type BrowsePage,
  browseOnBridge,
  editOnBridge,
  type LintFinding,
  type PolicyTable,
  readDocumentOnBridge,
  runOnBridge,
  type SchemaTable,
  type SimulateResult,
  StudioClient,
  type TableDetail,
  type UsageNumbers,
  usageOnBridge,
} from "../lib/api/studio";
import { type DiagnoseReport, readDiagnose } from "../lib/api/deployment";
import { formatCell } from "../lib/format";
import { setSharedOrigin } from "./connection";
import { clearStoredSession, readStoredSession, writeStoredSession } from "./session";
import {
  mockClaims,
  mockParameters,
  mockHealth,
  mockPolicies,
  mockProject,
  mockSimulatorRows,
  mockSql,
  mockStorageObjects,
  mockTables,
  mockUsers,
} from "../lib/mock-data";

type StudioScreen = "Simulator" | "Policies" | "Tables" | "Auth" | "Storage" | "Health";

/** Demo shows the fixtures; connect asks for a deployment; live talks to one. */
type StudioMode = "demo" | "connect" | "live";

/** What one connection learns up front: the tables, the policies, and what lint says. */
interface LiveState {
  readonly policies: readonly PolicyTable[];
  readonly findings: readonly LintFinding[];
  readonly withheld: number;
  readonly tables: readonly SchemaTable[];
  /**
   * Non-empty when any of the three reads failed. The lists above are then
   * incomplete, and a screen must say so rather than render them as truth: a
   * 429 from one refresh too many used to draw "0 TABLES / LIVE" over a
   * database that had tables, which sent the person into more refreshes.
   */
  readonly problem: string;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * Minimal focus containment for an overlay: focus moves in when it opens,
 * Tab cycles inside it, and focus returns to the opener when it closes.
 * The visual is untouched; this is only where the keyboard can go.
 */
function useOverlayFocus(active: boolean) {
  const containerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (container === null) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusables = () =>
      [...container.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.hasAttribute("disabled"));

    (focusables()[0] ?? container).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, [active]);

  return containerRef;
}

const navigation: StudioScreen[] = ["Simulator", "Policies", "Tables", "Auth", "Storage", "Health"];
// Two voices on purpose: the demo lines walk the fixture story, and showing
// them against a live deployment reads as instructions about tables that do
// not exist there. The first real walkthrough hit exactly that: "Open posts
// first" on a database with no posts table.
const guidance: Record<StudioScreen, { label: string; demo: string; live: string }> = {
  Simulator: { label: "Recommended next", demo: "Run the request as an authenticated user, then compare it with anon access.", live: "Run the same input as anon and as a user — the difference in rows is the policy working." },
  Policies: { label: "Start safe", demo: "Review the highlighted policy before creating a new rule.", live: "An applied change reaches every isolate within about half a minute." },
  Tables: { label: "Data check", demo: "Open posts first—the missing index warning needs attention.", live: "New tables appear after a refresh, within about a minute. Rows load only when you ask." },
  Auth: { label: "Setup check", demo: "Copy the redirect URI, then run the provider diagnostic.", live: "This is your deployment's own diagnostic, the one npx baseclf doctor reads. User records stay out of reach by design." },
  Storage: { label: "Access first", demo: "Choose a bucket and confirm its policy before uploading an object.", live: "This screen is still a fixture preview — storage rules live in your policy documents." },
  Health: { label: "What matters", demo: "Start with failures, then inspect the request trend.", live: "Everything this deployment can tell you about itself. Usage numbers live in your Cloudflare account and are not read here." },
};

export default function StudioApp() {
  const [screen, setScreen] = useState<StudioScreen>("Simulator");
  const [mode, setMode] = useState<StudioMode>("demo");
  // True while a stored session is being re-proven after a reload. Without it
  // the round-trip gap rendered the demo screens, and the first real user read
  // that flash as their data being replaced by mock tables.
  const [restoring, setRestoring] = useState(false);
  const [client, setClient] = useState<StudioClient | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [notice, setNotice] = useState("Policy simulation ready.");
  // One key for every bridge lane: the simulator's rows and the policies
  // editor share it, entered once. It rides with the tab's saved session,
  // like the admin token.
  const [bridgeKey, setBridgeKey] = useState("");
  const paletteFocus = useOverlayFocus(paletteOpen);
  const dialogFocus = useOverlayFocus(dialogOpen);
  const galleryFocus = useOverlayFocus(galleryOpen);

  const connected = mode !== "connect";

  const announce = (message: string) => {
    setNotice(message);
    setToast(message);
  };

  /**
   * One round trip already proved the token before this is called. The two
   * reads here fill the screens; a failure surfaces as a notice rather than
   * unwinding the connection, because a deployment with no policies yet is a
   * normal state, not a broken one.
   */
  const loadLive = async (from: StudioClient) => {
    const [policyAnswer, lintAnswer, schemaAnswer] = await Promise.all([
      from.policies(),
      from.lint(),
      from.schema(),
    ]);
    // Anything that is not data is a problem here, refusals included: a tool
    // that errors inside the deployment comes back as isError, which the
    // client maps to "refusal", and the first version of this check only
    // caught "error" - so a fresh deployment's INTERNAL still drew an empty
    // database. These three reads have no legitimate refusal.
    const problem =
      [policyAnswer, lintAnswer, schemaAnswer]
        .map((answer) => (answer.kind !== "data" ? answer.message : ""))
        .find((message) => message !== "") ?? "";
    if (problem !== "") announce(problem);
    setLive({
      policies: policyAnswer.kind === "data" ? policyAnswer.data.tables : [],
      findings: lintAnswer.kind === "data" ? lintAnswer.data.findings : [],
      withheld: lintAnswer.kind === "data" ? lintAnswer.data.withheld : 0,
      tables: schemaAnswer.kind === "data" ? schemaAnswer.data.tables : [],
      problem,
    });
  };

  const beginLive = async (nextClient: StudioClient, credentials: { url: string; token: string }) => {
    setClient(nextClient);
    setLive(null);
    setMode("live");
    // The origin only, for Overview and the API Explorer. Never the token.
    setSharedOrigin(nextClient.origin);
    // The proven pair, kept for this tab so a reload reconnects instead of
    // signing the person out. Written only after a real round trip accepted it.
    // A reconnect to the same deployment keeps the bridge key it stored; this
    // render's closure may still hold the empty initial one.
    const prior = readStoredSession();
    writeStoredSession({
      url: credentials.url,
      token: credentials.token,
      bridgeKey: prior !== null && prior.url === credentials.url ? prior.bridgeKey : bridgeKey,
    });
    announce(`Connected to ${hostOf(nextClient.origin)}.`);
    await loadLive(nextClient);
  };

  /** After an apply: what the deployment now admits to, re-read from it. */
  const refreshLive = async () => {
    if (client !== null) await loadLive(client);
  };

  const disconnect = () => {
    setClient(null);
    setLive(null);
    setMode("connect");
    setBridgeKey("");
    setSharedOrigin(null);
    clearStoredSession();
    // The notice belonged to the connection like everything else cleared here.
    // A failure about a deployment that outlives the deployment gets read as a
    // claim about whatever is on screen next, and the next screen is a fixture.
    setNotice("Disconnected. Nothing from that deployment is kept.");
  };

  /** The bridge key rides with the saved session, so F5 keeps the row lanes too. */
  const rememberBridgeKey = (key: string) => {
    setBridgeKey(key);
    const stored = readStoredSession();
    if (stored !== null) writeStoredSession({ ...stored, bridgeKey: key });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
        setDialogOpen(false);
        setGalleryOpen(false);
        setMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // The landing's "Connect live" deep-links here with ?connect=1. Read once
  // after hydration so the server-rendered demo frame stays identical; the
  // microtask keeps the state change out of the effect's synchronous body.
  //
  // A session saved in this tab outranks the deep link: the person already
  // connected once, so a reload reconnects - proven by a fresh round trip,
  // never by trust in the stored copy. A refusal clears the stored pair and
  // lands on the connect flow with a notice instead of a silent demo.
  useEffect(() => {
    const stored = readStoredSession();

    if (stored === null) {
      if (new URLSearchParams(window.location.search).has("connect")) {
        queueMicrotask(() => setMode("connect"));
      }
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setRestoring(true);
      announce(`Reconnecting to ${hostOf(stored.url)}…`);
    });
    void (async () => {
      const candidate = new StudioClient(stored.url, stored.token);
      const answer = await candidate.connect();
      if (cancelled) return;
      if ("error" in answer) {
        clearStoredSession();
        setRestoring(false);
        setMode("connect");
        announce("The saved session no longer connects. Connect again.");
        return;
      }
      setBridgeKey(stored.bridgeKey);
      await beginLive(candidate, { url: stored.url, token: stored.token });
      if (!cancelled) setRestoring(false);
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only by design: the stored session is read once per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className={`studio-root${connected ? "" : " is-connecting"}`} data-density="compact">
      {/* The full navigation is noise for somebody who has not connected yet:
          during the connect flow the sidebar goes away and the flow gets the
          whole width. */}
      {connected && <aside className={`studio-sidebar ${menuOpen ? "is-mobile-open" : ""}`} aria-label="Studio navigation">
        <Link className="studio-brand" href="/" aria-label="BaseCLF landing page">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>baseclf</span>
        </Link>
        <div className="studio-project">
          <span className="machine-label">Project</span>
          <strong>{mode === "live" && client ? hostOf(client.origin) : mockProject.name}</strong>
          <span className="connection-state"><i /> {mode === "live" ? "Live connection" : "Demo connection"}</span>
          {/* Fixture copy, so it renders only against the fixture: shown on a
              live connection it read as a claim about the person's own setup,
              and it counts nothing. */}
          {mode !== "live" && <div className="studio-project-progress"><span><i /></span><small>3 of 4 setup steps ready</small></div>}
          <div className="studio-project-actions"><Link href="/studio/overview">Overview</Link><Link href="/studio/api">API</Link><Link href="/studio/new-project">New</Link></div>
        </div>
        <nav>
          {navigation.map((item) => (
            <button
              key={item}
              type="button"
              className={screen === item ? "is-current" : ""}
              onClick={() => { setScreen(item); setMenuOpen(false); }}
            >
              <span aria-hidden="true">{item.slice(0, 2).toUpperCase()}</span>
              {item}
            </button>
          ))}
        </nav>
        <div className="studio-sidebar-footer">
          <button type="button" onClick={() => setPaletteOpen(true)}>Command menu <kbd>⌘K</kbd></button>
          <button type="button" onClick={() => setGalleryOpen(true)}>State gallery <span>↗</span></button>
          <a href="/docs">Documentation <span>↗</span></a>
        </div>
      </aside>}

      <section className="studio-workspace">
        <div className="studio-ambient" aria-hidden="true" />
        <header className="studio-header">
          <button className="mobile-menu" type="button" aria-label="Open navigation" onClick={() => setMenuOpen((value) => !value)}>Menu</button>
          <div>
            {/* The connect flow is neither mock nor live yet, so it wears
                neither label: a setup screen stamped "MOCK DATA" reads as a
                fake setup. */}
            <span className="machine-label">{mode === "live" && client ? `live / ${hostOf(client.origin)}` : mode === "connect" ? "setup / your deployment" : `${mockProject.environment} / ${mockProject.database}`}</span>
            <h1>{connected ? screen : "Connect Studio"}</h1>
          </div>
          <div className="studio-header-actions">
            <Link className="studio-help" href="/docs">Need help?</Link>
            {mode !== "connect" && <span className="mock-badge">{mode === "live" ? "Live connection" : "Mock data"}</span>}
            <ThemeToggle />
            <button className="connection-button" type="button" onClick={() => (mode === "demo" ? setMode("connect") : mode === "connect" ? setMode("demo") : disconnect())}>
              {mode === "demo" ? "Connect live" : mode === "connect" ? "Use demo" : "Disconnect"}
            </button>
          </div>
        </header>

        <div className="studio-content">
          {connected && !restoring && <aside className="studio-guide"><span>{guidance[screen].label}</span><p>{mode === "live" ? guidance[screen].live : guidance[screen].demo}</p>{mode === "demo" && <button type="button" onClick={() => setMode("connect")}>Connect live →</button>}<button type="button" onClick={() => setPaletteOpen(true)}>Show actions <kbd>⌘K</kbd></button></aside>}
          <div className="studio-screen-stage" key={restoring ? "restoring" : connected ? `${mode}-${screen}` : "connect"}>{restoring ? (
              <div className="studio-restoring"><span className="machine-label">Live connection</span><p>Reconnecting to your saved deployment…</p><small>A stored session is never trusted by itself: this is a real round trip, and a refusal lands on the connect screen.</small></div>
) : !connected ? (
              <ConnectFlow onConnected={beginLive} onDemo={() => setMode("demo")} onNotice={announce} onBridgeKey={rememberBridgeKey} />
) : screen === "Simulator" ? (
              <SimulatorPanel client={mode === "live" ? client : null} live={live} bridgeKey={bridgeKey} onBridgeKey={rememberBridgeKey} onNotice={announce} />
            ) : (
              <DataScreen screen={screen} client={mode === "live" ? client : null} live={mode === "live" ? live : null} bridgeKey={bridgeKey} onRefresh={() => void refreshLive()} onNotice={announce} onOpenDialog={() => setDialogOpen(true)} />
            )}</div>
        </div>

        <div className="studio-status" role="status">
          <span className="status-pulse" aria-hidden="true" />
          {notice}
          <span>{mode === "live" && client ? `Connected to ${hostOf(client.origin)}` : "Fixture-backed preview"}</span>
        </div>
      </section>

      {paletteOpen && (
        <div className="palette-backdrop" role="button" tabIndex={0} aria-label="Close command menu" onMouseDown={(event) => { if (event.target === event.currentTarget) setPaletteOpen(false); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setPaletteOpen(false); }}>
          <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command menu" ref={paletteFocus}>
            <input aria-label="Search commands" placeholder="Go to a screen" />
            <div>
              {navigation.map((item) => (
                <button key={item} type="button" onClick={() => { setScreen(item); setPaletteOpen(false); }}>
                  <span>Go to</span><strong>{item}</strong><kbd>↵</kbd>
                </button>
              ))}
              <button type="button" onClick={() => { setGalleryOpen(true); setPaletteOpen(false); }}><span>View</span><strong>State gallery</strong><kbd>↵</kbd></button>
            </div>
          </section>
        </div>
      )}
      {dialogOpen && <div className="palette-backdrop" role="button" tabIndex={0} aria-label="Close delete dialog" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialogOpen(false); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setDialogOpen(false); }}><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" ref={dialogFocus}><span className="dialog-icon">!</span><h2 id="delete-title">Delete this policy?</h2><p>This preview action does not delete real data. In production, requests relying on this policy could change access immediately.</p><div><button className="studio-secondary" type="button" onClick={() => setDialogOpen(false)}>Cancel</button><button className="danger-button" type="button" onClick={() => { setDialogOpen(false); announce("Mock policy deleted. No product data changed."); }}>Delete policy</button></div></section></div>}
      {galleryOpen && <StateGallery onClose={() => setGalleryOpen(false)} sectionRef={galleryFocus} />}
      {toast && <div className="studio-toast" role="status"><span className="status-pulse" />{toast}<button type="button" onClick={() => setToast("")} aria-label="Dismiss notification">×</button></div>}
    </main>
  );
}

/** What the wizard has collected and PROVEN so far. Page memory only. */
interface WizardState {
  readonly url: string;
  /** Set by a real GET /health round trip, never by typing. */
  readonly version: string | null;
  readonly token: string;
  /** Set by a real tools/list round trip with the token. */
  readonly client: StudioClient | null;
  readonly bridgeKey: string;
  readonly bridge: "unchecked" | "ok" | "skipped";
}

const EMPTY_WIZARD: WizardState = {
  url: "",
  version: null,
  token: "",
  client: null,
  bridgeKey: "",
  bridge: "unchecked",
};

type ConnectStage = "choice" | "prepare" | "create" | "token" | "bridge" | "summary" | "direct";

/**
 * A terminal window showing what the command really prints. Every line is
 * copied from a real run against real infrastructure, with only the
 * deployment address and the session key genericized; nothing is invented,
 * because the point of showing a terminal is that it matches the one the
 * person is about to see.
 */
function TerminalShot({ command, lines }: { command: string; lines: readonly string[] }) {
  return (
    <figure className="wizard-terminal" aria-label={`What ${command} prints`}>
      <figcaption><i /><i /><i /><span>Terminal</span></figcaption>
      <pre><code>{`$ ${command}\n${lines.join("\n")}`}</code></pre>
    </figure>
  );
}

const WHOAMI_OUTPUT: readonly string[] = [
  " ⛅️ wrangler 4.125.0",
  "───────────────────────",
  "Getting User settings...",
  "👋 You are logged in with an OAuth Token, associated with the email you@example.com.",
  "🔐 Credentials are stored in: C:\\Users\\you\\.wrangler\\config\\default.toml",
  "┌──────────────┬──────────────────────┐",
  "│ Account Name │ Account ID           │",
  "├──────────────┼──────────────────────┤",
  "│ Your Account │ <your-account-id>    │",
  "└──────────────┴──────────────────────┘",
];

const LOGIN_OUTPUT: readonly string[] = [
  "Need to install the following packages:",
  "wrangler@4.125.0",
  "Ok to proceed? (y) y",
  "",
  " ⛅️ wrangler 4.125.0",
  "───────────────────────",
  "Attempting to login via OAuth...",
  "Opening a link in your default browser: https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=…",
];

const CREATE_OUTPUT: readonly string[] = [
  "Project name",
  "  Names the database, the bucket and the Worker on your account.",
  "  [baseclf]",
  "Frontend origin",
  "  Browsers can call this API only from origins listed here. The default",
  "  suits an app running on your machine, and nothing else. Comma separate",
  "  more than one; include https://baseclf.dev to also manage this",
  "  deployment from the hosted Studio.",
  "  [http://localhost:3000] http://localhost:3000,https://baseclf.dev",
  "✓ Check the Cloudflare login",
  "✓ Create the database",
  "✓ Create the bucket",
  "✓ Claim the workers.dev subdomain",
  "✓ Upload the Worker",
  "✓ Set the signing secret",
  "✓ Turn on the workers.dev route",
  "✓ Set the scheduled work",
  "✓ Wait for the address to answer",
  "",
  "  Check: npx baseclf doctor https://your-project.your-subdomain.workers.dev",
];

const SECRET_OUTPUT: readonly string[] = [
  "Press Enter to generate a strong value for MCP_TOKEN, or type your own.",
  "  Nothing you type is echoed, written to disk, or printed back.",
  "  A typed value is asked for twice; a generated one cannot be mistyped.",
  "  This value is the admin token. The Studio asks for it, and anyone",
  "  holding it can do everything the engine allows.",
  "✓ Generated a strong value.",
  '✓ MCP_TOKEN is set on the Worker "your-project".',
  "  The value is in your clipboard: paste it into the Admin token field on the",
  "  Studio connect screen.",
  "  Cloudflare does not hand a secret back, so this reports that the request was",
  "  accepted rather than that the value is the one you meant.",
];

const STUDIO_OUTPUT: readonly string[] = [
  "✓ The result bridge is listening on 127.0.0.1:4000.",
  "Paste this key into the Result panel of the Studio simulator:",
  "",
  "00000000-0000-4000-8000-000000000000",
  "",
  "  Reads, plus the policy documents you apply. On this machine only.",
];

/**
 * The connect flow, one screen per decision. Every check mark is a real round
 * trip (health, tools/list, a bridge read); Next stays dark until the step
 * proved itself, and the summary offers the collected setup as a download —
 * without the token unless the person explicitly includes it.
 */
function ConnectFlow({ onConnected, onDemo, onNotice, onBridgeKey }: { onConnected: (client: StudioClient, credentials: { url: string; token: string }) => void; onDemo: () => void; onNotice: (message: string) => void; onBridgeKey: (key: string) => void }) {
  const [stage, setStage] = useState<ConnectStage>("choice");
  const [wizard, setWizard] = useState<WizardState>(EMPTY_WIZARD);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [includeToken, setIncludeToken] = useState(false);
  // The two account prerequisites live on the person's machine and in their
  // Cloudflare account, where this page cannot reach. Unlike every later step,
  // these are confirmed by the person, not proven by a round trip - so they are
  // checkboxes, and the page says plainly that they are the one check it cannot
  // make for them.
  const [authReady, setAuthReady] = useState(false);
  const [r2Ready, setR2Ready] = useState(false);
  // Safe to read lazily: this component only ever mounts client-side, after a
  // person chose Connect (or the ?connect deep link fired post-hydration).
  const [pageOrigin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));

  // The project name is the first label only on a workers.dev address, which
  // is what create-baseclf hands out. Anything else (an IP, localhost, a
  // custom domain) falls back to the CLI's own default rather than guessing:
  // the first label of 127.0.0.1 is "127", measured on this very screen.
  const project = (() => {
    try {
      const host = new URL(wizard.url).hostname;
      return host.endsWith(".workers.dev") ? host.split(".")[0] || "baseclf" : "baseclf";
    } catch {
      return "baseclf";
    }
  })();

  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value);
    onNotice("Copied.");
  };

  const go = (next: ConnectStage) => {
    setProblem("");
    setStage(next);
  };

  const checkUrl = async () => {
    if (busy) return;
    setBusy(true);
    setProblem("");
    const target = wizard.url.trim().replace(/\/+$/, "");
    try {
      const response = await fetch(`${target}/health`, { headers: { accept: "application/json" } });
      const body = (await response.json()) as { status?: string; version?: string };
      if (response.ok && body.status === "ok") {
        setWizard({ ...wizard, url: target, version: String(body.version ?? "unknown") });
      } else {
        setProblem(`That address answered ${response.status} without a health report.`);
      }
    } catch {
      // A CORS refusal and a dead address throw the same TypeError. A no-cors
      // probe tells them apart: it resolves opaque when the server answered and
      // only rejects when nothing did, so each failure gets its own fix.
      try {
        await fetch(`${target}/health`, { mode: "no-cors" });
        setProblem(`The deployment is alive, but it does not trust this page's origin, so the browser refuses to read its answers. Re-run npx create-baseclf with the same project name and include ${pageOrigin} in the Frontend origin answer, comma separated with your app's origin — everything already created is kept.`);
      } catch {
        setProblem("Could not reach that address. Check the URL, and that the create run finished.");
      }
    }
    setBusy(false);
  };

  // The refusal right after `secret set` is almost always timing, not the
  // value: a fresh secret rides a new Worker version, and the edge can keep
  // answering with the old one for a minute or two. Measured twice on real
  // first-run deployments; both times the person re-set a perfectly good
  // token because the message gave them nothing else to try.
  const explainRefusal = (error: string) =>
    error === "The deployment refused the token."
      ? "The deployment refused the token. Just set it? A new secret can take a minute or two to reach the version that answers — wait a moment and try again before re-setting anything."
      : error;

  const checkToken = async () => {
    if (busy) return;
    setBusy(true);
    setProblem("");
    const candidate = new StudioClient(wizard.url, wizard.token);
    const answer = await candidate.connect();
    setBusy(false);
    if ("error" in answer) {
      setProblem(explainRefusal(answer.error));
      return;
    }
    setWizard({ ...wizard, client: candidate });
  };

  const checkBridge = async () => {
    if (busy) return;
    setBusy(true);
    setProblem("");
    const key = wizard.bridgeKey.trim();
    const answer = await readDocumentOnBridge(key, "__wizard_ping__");
    setBusy(false);
    if (answer.kind !== "data") {
      setProblem(answer.message);
      return;
    }
    setWizard({ ...wizard, bridgeKey: key, bridge: "ok" });
    onBridgeKey(key);
  };

  const download = () => {
    const lines = [
      "# BaseCLF setup notes",
      "",
      `Deployment URL: ${wizard.url}`,
      `Project name:   ${project}`,
      `Version seen:   ${wizard.version ?? "unchecked"}`,
      `Trusted origin: ${pageOrigin}`,
      `Admin token:    ${includeToken ? wizard.token : "<your MCP_TOKEN — fill in yourself if you want it stored>"}`,
      `Bridge:         ${wizard.bridge === "ok" ? "verified on this machine" : "skipped"}`,
      "",
      "## The commands, for next time",
      "",
      "Create or update the deployment:",
      "    npx create-baseclf",
      "",
      "Set or rotate the admin token:",
      `    npx baseclf secret set MCP_TOKEN --script ${project}`,
      "",
      "Start the local bridge for rows and policy editing:",
      `    npx baseclf studio --project ${project}`,
      "",
      "Open the Studio:",
      `    ${pageOrigin}/studio?connect=1`,
      "",
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = "baseclf-setup.md";
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    onNotice(includeToken ? "Downloaded, with the token inside. Treat the file as a secret." : "Downloaded. The token line is left for you to fill in.");
  };

  const directSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem("");
    const candidate = new StudioClient(wizard.url, wizard.token);
    const answer = await candidate.connect();
    setBusy(false);
    if ("error" in answer) {
      setProblem(explainRefusal(answer.error));
      return;
    }
    onConnected(candidate, { url: wizard.url, token: wizard.token.trim() });
  };

  if (stage === "choice") {
    return (
      <div className="wizard">
        <section className="connect-copy">
          <p className="section-kicker">Live connection</p>
          <h2>Connect Studio to your Worker.</h2>
          <p>Everything is sent directly to your own deployment and kept in this browser only — you stay signed in until you disconnect, or after seven days unused. BaseCLF has no servers in between.</p>
          <dl>
            <div><dt>Transport</dt><dd>HTTPS to your Worker</dd></div>
            <div><dt>Credential storage</dt><dd>This browser, until you disconnect</dd></div>
            <div><dt>BaseCLF servers</dt><dd>Not involved</dd></div>
          </dl>
        </section>
        <div className="wizard-doors">
          <button className="wizard-door is-primary" type="button" onClick={() => go("prepare")}>
            <strong>First deployment? Set up step by step</strong>
            <small>Get the account ready, then three commands, each one checked before the next.</small>
          </button>
          <button className="wizard-door" type="button" onClick={() => go("direct")}>
            <strong>I already have a deployment</strong>
            <small>Paste the URL and the admin token, and connect.</small>
          </button>
          <button className="wizard-door" type="button" onClick={onDemo}>
            <strong>Open the demo workspace</strong>
            <small>Look around with fixture data first. Nothing to set up.</small>
          </button>
        </div>
      </div>
    );
  }

  if (stage === "direct") {
    return (
      <div className="wizard">
        <section className="connect-copy">
          <p className="section-kicker">Live connection</p>
          <h2>Connect Studio to your Worker.</h2>
          <p>The token is the MCP_TOKEN secret you set on the deployment. This page&apos;s origin has to be in the deployment&apos;s trusted origins.</p>
        </section>
        <form className="connect-form" onSubmit={directSubmit}>
          <label>Worker URL<input type="url" value={wizard.url} onChange={(event) => setWizard({ ...wizard, url: event.target.value })} placeholder="https://your-project.your-subdomain.workers.dev" required /></label>
          <label>Admin token<input type="password" value={wizard.token} onChange={(event) => setWizard({ ...wizard, token: event.target.value })} placeholder="The MCP_TOKEN secret" aria-describedby={problem ? "token-error" : undefined} required /></label>
          {problem !== "" && <p className="form-error" id="token-error">{problem}</p>}
          <button className="studio-primary" type="submit" disabled={busy}>{busy ? "Connecting…" : "Connect Studio"}</button>
          <button className="studio-secondary" type="button" onClick={() => go("choice")}>Back</button>
        </form>
      </div>
    );
  }

  if (stage === "prepare") {
    return (
      <div className="wizard">
        <p className="wizard-progress">Step 1 of 4 · Get the account ready</p>
        <section className="wizard-card">
          <h3>Two things the next command needs.</h3>
          <p>The create command provisions onto <strong>your own Cloudflare account</strong> — it needs a Cloudflare login on this machine, and an account with R2 storage turned on. Both live outside this page, so these two are the checks only you can make.</p>
          <p className="wizard-item">1 · Cloudflare login</p>
          <p className="form-help">This signs the machine into Cloudflare. Already signed in on this machine? Skip straight to the check below.</p>
          <div className="wizard-command"><code>npx wrangler login</code><button type="button" onClick={() => copy("npx wrangler login")}>Copy</button></div>
          <TerminalShot command="npx wrangler login" lines={LOGIN_OUTPUT} />
          <p className="form-help">Your browser opens Cloudflare&apos;s consent screen — &ldquo;Wrangler wants to access your account&rdquo;. Pick the account you want, press <strong>Authorize</strong>, and the tab ends on &ldquo;Authorization granted to Wrangler&rdquo;. Close it, then verify:</p>
          <div className="wizard-command"><code>npx wrangler whoami</code><button type="button" onClick={() => copy("npx wrangler whoami")}>Copy</button></div>
          <TerminalShot command="npx wrangler whoami" lines={WHOAMI_OUTPUT} />
          <p className="form-help">However you got here, whoami has to answer like that, and the account in the table is where the deployment will land. A token permissions list follows the table; its exact entries do not matter here.</p>
          <label className="wizard-include"><input type="checkbox" checked={authReady} onChange={(event) => setAuthReady(event.target.checked)} /> whoami answers, and it names the account I want to deploy to.</label>
          <p className="wizard-item">2 · R2 storage</p>
          <p className="form-help">Files live in R2, and on a new account R2 is off until you open it once. In the <a href="https://dash.cloudflare.com/?to=/:account/r2" target="_blank" rel="noreferrer">Cloudflare dashboard, open R2 Object Storage</a> and follow what it asks of you. Skipping this stops the create run at its bucket step.</p>
          <label className="wizard-include"><input type="checkbox" checked={r2Ready} onChange={(event) => setR2Ready(event.target.checked)} /> R2 is enabled on that account.</label>
          <div className="wizard-actions">
            <button className="studio-secondary" type="button" onClick={() => go("choice")}>Back</button>
            <button className="studio-primary" type="button" disabled={!authReady || !r2Ready} onClick={() => go("create")}>Next</button>
          </div>
        </section>
      </div>
    );
  }

  if (stage === "create") {
    return (
      <div className="wizard">
        <p className="wizard-progress">Step 2 of 4 · Create the deployment</p>
        <section className="wizard-card">
          <h3>One command creates everything.</h3>
          <p>It provisions the database, the bucket and the Worker on your own Cloudflare account, then <strong>prints your deployment URL</strong>. It asks two questions: a project name, and the <strong>Frontend origin</strong>. Answer the second with your app&apos;s origin plus this page&apos;s, comma separated — a deployment that does not list this page&apos;s origin refuses this browser.</p>
          <div className="wizard-command"><code>npx create-baseclf</code><button type="button" onClick={() => copy("npx create-baseclf")}>Copy</button></div>
          <div className="wizard-command"><code>{`http://localhost:3000,${pageOrigin}`}</code><button type="button" onClick={() => copy(`http://localhost:3000,${pageOrigin}`)}>Copy answer</button></div>
          <TerminalShot command="npx create-baseclf" lines={CREATE_OUTPUT} />
          <p className="form-help">This is what a successful run prints, from a real one. If yours shows a ✗ or stops early, that line is the thing to fix before going on. A ▲ line is different: the printout explains what it could not set and why, but the run continues and the address at the end works — carry on, and deal with the ▲ when it suits you.</p>
          <label className="wizard-field">Paste the deployment URL it printed<input type="url" value={wizard.url} onChange={(event) => setWizard({ ...wizard, url: event.target.value, version: null })} placeholder="https://your-project.your-subdomain.workers.dev" /></label>
          {wizard.version !== null ? (
            <p className="wizard-verified"><span className="state-label active">Verified</span> The deployment answers, running version {wizard.version}.</p>
          ) : problem !== "" ? (
            <p className="form-error">{problem}</p>
          ) : (
            <p className="form-help">Check makes a real request to /health. Nothing advances on trust.</p>
          )}
          <div className="wizard-actions">
            <button className="studio-secondary" type="button" onClick={() => go("prepare")}>Back</button>
            <button className="studio-secondary" type="button" disabled={busy || wizard.url.trim() === ""} onClick={() => void checkUrl()}>{busy ? "Checking…" : "Check"}</button>
            <button className="studio-primary" type="button" disabled={wizard.version === null} onClick={() => go("token")}>Next</button>
          </div>
        </section>
      </div>
    );
  }

  if (stage === "token") {
    return (
      <div className="wizard">
        <p className="wizard-progress">Step 3 of 4 · Set the admin token</p>
        <section className="wizard-card">
          <h3>The one credential, on your own Worker.</h3>
          <p>Set the MCP_TOKEN secret — it unlocks the management surface of your deployment. At the prompt, just <strong>press Enter</strong> and a strong value is generated for you; type your own instead and it is asked for twice. Either way the token lands in your clipboard, so the field below is one paste.</p>
          <div className="wizard-command"><code>npx baseclf secret set MCP_TOKEN --script {project}</code><button type="button" onClick={() => copy(`npx baseclf secret set MCP_TOKEN --script ${project}`)}>Copy</button></div>
          <TerminalShot command={`npx baseclf secret set MCP_TOKEN --script ${project}`} lines={SECRET_OUTPUT} />
          <p className="form-help">Nothing you type is echoed, which is correct. Yours should end like this, with the clipboard line.</p>
          <label className="wizard-field">Paste the token here<input type="password" value={wizard.token} onChange={(event) => setWizard({ ...wizard, token: event.target.value, client: null })} placeholder="The MCP_TOKEN value, from your clipboard" /></label>
          {wizard.client !== null ? (
            <p className="wizard-verified"><span className="state-label active">Verified</span> The deployment accepted the token.</p>
          ) : problem !== "" ? (
            <p className="form-error">{problem}</p>
          ) : (
            <p className="form-help">Check makes a real tools/list call with the token.</p>
          )}
          <div className="wizard-actions">
            <button className="studio-secondary" type="button" onClick={() => go("create")}>Back</button>
            <button className="studio-secondary" type="button" disabled={busy || wizard.token === ""} onClick={() => void checkToken()}>{busy ? "Checking…" : "Check"}</button>
            <button className="studio-primary" type="button" disabled={wizard.client === null} onClick={() => go("bridge")}>Next</button>
          </div>
        </section>
      </div>
    );
  }

  if (stage === "bridge") {
    return (
      <div className="wizard">
        <p className="wizard-progress">Step 4 of 4 · The local bridge, if you want rows</p>
        <section className="wizard-card">
          <h3>Rows and policy editing run on your machine.</h3>
          <p>The bridge holds your Cloudflare credential and answers this page on 127.0.0.1 only. Skipping it is fine: compiling SQL and reading policies work without it.</p>
          <div className="wizard-command"><code>npx baseclf studio --project {project}</code><button type="button" onClick={() => copy(`npx baseclf studio --project ${project}`)}>Copy</button></div>
          <TerminalShot command={`npx baseclf studio --project ${project}`} lines={STUDIO_OUTPUT} />
          <p className="form-help">Yours prints a key of this shape, freshly made for the session. Copy that one, not this example.</p>
          <label className="wizard-field">Paste the key it prints<input type="text" value={wizard.bridgeKey} onChange={(event) => setWizard({ ...wizard, bridgeKey: event.target.value, bridge: "unchecked" })} placeholder="The session key from the terminal" /></label>
          {wizard.bridge === "ok" ? (
            <p className="wizard-verified"><span className="state-label active">Verified</span> The bridge is answering on this machine.</p>
          ) : problem !== "" ? (
            <p className="form-error">{problem}</p>
          ) : (
            <p className="form-help">Check makes a real request to 127.0.0.1:4000 with the key.</p>
          )}
          <div className="wizard-actions">
            <button className="studio-secondary" type="button" onClick={() => go("token")}>Back</button>
            <button className="studio-secondary" type="button" disabled={busy || wizard.bridgeKey.trim() === ""} onClick={() => void checkBridge()}>{busy ? "Checking…" : "Check"}</button>
            <button className="studio-secondary" type="button" onClick={() => { setWizard({ ...wizard, bridge: "skipped" }); go("summary"); }}>Skip</button>
            <button className="studio-primary" type="button" disabled={wizard.bridge !== "ok"} onClick={() => go("summary")}>Next</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="wizard">
      <p className="wizard-progress">Done · Everything below was verified, not assumed</p>
      <section className="wizard-card">
        <h3>Your setup, checked.</h3>
        <div className="wizard-summary">
          <div><dt>Deployment</dt><dd>{wizard.url} <span className="state-label active">version {wizard.version}</span></dd></div>
          <div><dt>Admin token</dt><dd>{"•".repeat(Math.min(wizard.token.length, 18))} <span className="state-label active">accepted</span></dd></div>
          <div><dt>Local bridge</dt><dd>{wizard.bridge === "ok" ? <span className="state-label active">answering</span> : <span className="state-label blocked">skipped</span>}</dd></div>
          <div><dt>Trusted origin</dt><dd>{pageOrigin} <span className="state-label active">proven by the token check</span></dd></div>
        </div>
        <label className="wizard-include"><input type="checkbox" checked={includeToken} onChange={(event) => setIncludeToken(event.target.checked)} /> Include the token in the downloaded file. Off, the token line is left for you to fill in.</label>
        <div className="wizard-actions">
          <button className="studio-secondary" type="button" onClick={() => go("bridge")}>Back</button>
          <button className="studio-secondary" type="button" onClick={download}>Download setup notes</button>
          <button className="studio-primary" type="button" onClick={() => { if (wizard.client !== null) onConnected(wizard.client, { url: wizard.url, token: wizard.token.trim() }); }}>Connect</button>
        </div>
      </section>
    </div>
  );
}

function SimulatorPanel({ client, live, bridgeKey, onBridgeKey, onNotice }: { client: StudioClient | null; live: LiveState | null; bridgeKey: string; onBridgeKey: (key: string) => void; onNotice: (message: string) => void }) {
  if (client !== null) return <LiveSimulatorPanel client={client} live={live} bridgeKey={bridgeKey} onBridgeKey={onBridgeKey} onNotice={onNotice} />;
  return <DemoSimulatorPanel onNotice={onNotice} />;
}

/**
 * The real simulator. Everything shown is the deployment's own answer:
 * `policy_simulate` compiles with the caller's policies attached and returns
 * the SQL, the parameter count with values withheld by default, and the names
 * of the policies that matched. Rows are absent on purpose: the tool never
 * touches data, and executing the statement is the local Studio's job
 * (decision Q3), where the operator's own credential runs it.
 */
function LiveSimulatorPanel({ client, live, bridgeKey, onBridgeKey, onNotice }: { client: StudioClient; live: LiveState | null; bridgeKey: string; onBridgeKey: (key: string) => void; onNotice: (message: string) => void }) {
  const tables = live === null ? [] : live.policies.map((entry) => entry.table);
  const [mode, setMode] = useState<"results" | "sql">("results");
  const [table, setTable] = useState("");
  const [operation, setOperation] = useState<"select" | "insert" | "update" | "delete">("select");
  const [role, setRole] = useState("authenticated");
  const [claimsText, setClaimsText] = useState('{ "uid": "u_demo" }');
  const [bodyText, setBodyText] = useState('{ "title": "edited" }');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [rowsAnswer, setRowsAnswer] = useState<BridgeRows | null>(null);
  // A 429 sets a deadline from the deployment's Retry-After; the buttons stay
  // disabled until it passes and the seconds tick down next to them. Never an
  // automatic retry: the person decides when to press Run again.
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (cooldownUntil === 0 || cooldownUntil <= Date.now()) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= cooldownUntil) setCooldownUntil(0);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const cooling = cooldownUntil > now;
  const coolingSeconds = cooling ? Math.max(1, Math.ceil((cooldownUntil - now) / 1000)) : 0;

  const chosenTable = table !== "" ? table : (tables[0] ?? "");
  const writesBody = operation === "insert" || operation === "update";

  const run = async (asRole: string) => {
    if (busy || cooling) return;
    if (chosenTable === "") {
      onNotice("Nothing is exposed yet. Apply a policy document first.");
      return;
    }

    let claims: { uid?: string; email?: string } | undefined;
    let body: Record<string, unknown> | undefined;
    try {
      claims = asRole === "anon" ? undefined : (JSON.parse(claimsText) as { uid?: string });
      body = writesBody ? (JSON.parse(bodyText) as Record<string, unknown>) : undefined;
    } catch {
      onNotice("Claims and body have to be JSON objects.");
      return;
    }

    setBusy(true);
    const answer = await client.simulate({ table: chosenTable, operation, role: asRole, claims, body });

    if (answer.kind === "error") {
      setBusy(false);
      if (answer.retryAfterSeconds !== undefined) {
        setCooldownUntil(Date.now() + answer.retryAfterSeconds * 1000);
        setNow(Date.now());
      }
      onNotice(answer.message);
      return;
    }
    if (answer.kind === "refusal") {
      setBusy(false);
      setResult(null);
      setRowsAnswer(null);
      setRefusal(answer.message);
      onNotice(`Refused for role ${asRole}. Refusals are an answer here, not a failure.`);
      return;
    }
    setRefusal(null);
    setResult(answer.data);

    // Rows come from the local bridge, never from the deployment's simulator:
    // the tool does not touch data, and the bridge runs the read with the
    // operator's own credential on the operator's own machine (decision Q3).
    if (operation === "select" && bridgeKey.trim() !== "") {
      const rows = await runOnBridge(bridgeKey.trim(), { table: chosenTable, role: asRole, claims });
      if (rows.kind === "data") {
        setRowsAnswer(rows.data);
      } else {
        setRowsAnswer(null);
        onNotice(rows.message);
      }
    } else {
      setRowsAnswer(null);
    }

    setBusy(false);
    onNotice(`Compiled for role ${asRole}: ${answer.data.policies.length} matching ${answer.data.policies.length === 1 ? "policy" : "policies"}.`);
  };

  const finding = live?.findings.find((entry) => entry.table === chosenTable);

  return (
    <div className="simulator-shell">
      <div className="screen-intro">
        <div><p className="section-kicker">Policy evidence</p><h2>See the request BaseCLF evaluates.</h2></div>
        <div className="segmented-control" aria-label="Simulator layout">
          <button type="button" className={mode === "sql" ? "is-selected" : ""} onClick={() => setMode("sql")}>SQL only</button>
          <button type="button" className={mode === "results" ? "is-selected" : ""} onClick={() => setMode("results")}>With results</button>
        </div>
      </div>

      <div className={`simulator-grid ${mode === "sql" ? "is-two-column" : ""}`}>
        <section className="studio-panel input-panel">
          <header><span>Input</span><span>01</span></header>
          <div className="field-grid">
            <label>Table<select value={chosenTable} onChange={(event) => setTable(event.target.value)}>{tables.length === 0 ? <option value="">nothing exposed</option> : tables.map((name) => <option key={name}>{name}</option>)}</select></label>
            <label>Operation<select value={operation} onChange={(event) => setOperation(event.target.value as typeof operation)}><option>select</option><option>insert</option><option>update</option><option>delete</option></select></label>
            <label>Role<select value={role} onChange={(event) => setRole(event.target.value)}><option>authenticated</option><option>anon</option></select></label>
          </div>
          <label className="claims-field">JWT claims<textarea value={role === "anon" ? "{}" : claimsText} readOnly={role === "anon"} onChange={(event) => setClaimsText(event.target.value)} spellCheck={false} /></label>
          {writesBody && <label className="claims-field">Write body<textarea value={bodyText} onChange={(event) => setBodyText(event.target.value)} spellCheck={false} /></label>}
          <label className="claims-field">Bridge key, from npx baseclf studio<textarea rows={1} value={bridgeKey} onChange={(event) => onBridgeKey(event.target.value)} placeholder="Leave empty to compile without rows" spellCheck={false} /></label>
          <div className="panel-actions">
            <button className="studio-primary" type="button" disabled={busy || cooling} onClick={() => void run(role)}>{busy ? "Compiling…" : cooling ? `Rate limited · ${coolingSeconds}s` : "Run simulation"}</button>
            <button className="studio-secondary" type="button" disabled={busy || cooling} onClick={() => { setRole("anon"); void run("anon"); }}>Run as anon</button>
          </div>
        </section>

        <section className="studio-panel sql-panel">
          <header><span>Generated SQL</span><button type="button" onClick={() => { if (result !== null) void navigator.clipboard?.writeText(result.sql); }}>Copy</button></header>
          <pre><code>{refusal ?? result?.sql ?? "-- Run a simulation to compile the statement this caller would get."}</code></pre>
          <div className="parameter-table">
            <div><span>Parameter</span><span>Bound value</span></div>
            {result !== null && <div><code>{result.parameterCount ?? 0} bound</code><code>{result.parametersWithheld ? "values withheld" : "included"}</code></div>}
          </div>
          {finding !== undefined && <div className="index-warning"><strong>{finding.policy}</strong><p>{finding.detail}</p>{finding.remedy !== undefined && <code>{finding.remedy}</code>}{finding.remedy !== undefined && <button type="button" onClick={() => void navigator.clipboard?.writeText(finding.remedy ?? "")}>Copy statement</button>}</div>}
        </section>

        {mode === "results" && (
          <section className="studio-panel results-panel">
            <header><span>Result</span><span>{rowsAnswer === null ? "local bridge" : `${rowsAnswer.rows.length} row(s), ${rowsAnswer.rowsRead ?? "?"} scanned`}</span></header>
            <div className="result-list">
              {rowsAnswer === null ? (
                <div className="result-empty"><span><strong>The deployment compiles without touching data.</strong><small>Rows come from the local bridge: run npx baseclf studio, paste its key on the left, and rerun. Your credential stays on your machine.</small></span></div>
              ) : rowsAnswer.rows.length === 0 ? (
                <div className="result-empty"><span><strong>No rows for this caller.</strong><small>Either there are none, or none are theirs. The engine answers both the same way on purpose.</small></span></div>
              ) : (
                rowsAnswer.rows.map((row, index) => {
                  const parts = Object.entries(row)
                    .filter(([column]) => column !== "id" && column !== "title")
                    .slice(0, 3)
                    .map(([column, value]) => ({ column, cell: formatCell(column, value) }));
                  return (
                    <div key={String(row.id ?? index)}>
                      <code>{formatCell("id", row.id ?? index).text}</code>
                      <span><strong>{formatCell("title", row.title ?? row.name ?? Object.values(row)[1] ?? "").text}</strong><small title={parts.map((part) => `${part.column}: ${part.cell.title ?? part.cell.text}`).join(" · ")}>{parts.map((part) => `${part.column}: ${part.cell.text}`).join(" · ")}</small></span>
                      <span className="result-verdict allow">Visible</span>
                    </div>
                  );
                })
              )}
            </div>
            <footer><span>Decided by</span>{(result?.policies ?? []).map((name) => <code key={name}>{name}</code>)}</footer>
          </section>
        )}
      </div>
    </div>
  );
}

function DemoSimulatorPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [mode, setMode] = useState<"results" | "sql">("results");
  const [role, setRole] = useState("authenticated");

  return (
    <div className="simulator-shell">
      <div className="screen-intro">
        <div><p className="section-kicker">Policy evidence</p><h2>See the request BaseCLF evaluates.</h2></div>
        <div className="segmented-control" aria-label="Simulator layout">
          <button type="button" className={mode === "sql" ? "is-selected" : ""} onClick={() => setMode("sql")}>SQL only</button>
          <button type="button" className={mode === "results" ? "is-selected" : ""} onClick={() => setMode("results")}>With results</button>
        </div>
      </div>

      <div className={`simulator-grid ${mode === "sql" ? "is-two-column" : ""}`}>
        <section className="studio-panel input-panel">
          <header><span>Input</span><span>01</span></header>
          <div className="field-grid">
            <label>Table<select defaultValue="posts"><option>posts</option><option>profiles</option></select></label>
            <label>Operation<select defaultValue="select"><option>select</option><option>insert</option><option>update</option></select></label>
            <label>Role<select value={role} onChange={(event) => setRole(event.target.value)}><option>authenticated</option><option>anon</option></select></label>
          </div>
          <label className="claims-field">JWT claims<textarea value={role === "anon" ? "{}" : mockClaims} readOnly spellCheck={false} /></label>
          <div className="panel-actions">
            <button className="studio-primary" type="button" onClick={() => onNotice(`Simulation complete for role ${role}.`)}>Run simulation</button>
            <button className="studio-secondary" type="button" onClick={() => setRole("anon")}>Run as anon</button>
          </div>
        </section>

        <section className="studio-panel sql-panel">
          <header><span>Generated SQL</span><button type="button" onClick={() => navigator.clipboard?.writeText(mockSql)}>Copy</button></header>
          <pre><code>{mockSql}</code></pre>
          <div className="parameter-table">
            <div><span>Parameter</span><span>Bound value</span></div>
            {mockParameters.map((parameter) => <div key={parameter.placeholder}><code>{parameter.placeholder}</code><code>{parameter.value}</code></div>)}
          </div>
          <div className="index-warning"><strong>Missing index</strong><p>`posts.author_id` is used by a policy and has no index.</p><code>CREATE INDEX idx_posts_author_id ON posts(author_id);</code><button type="button">Copy statement</button></div>
        </section>

        {mode === "results" && (
          <section className="studio-panel results-panel">
            <header><span>Result</span><span>2 of 4 visible</span></header>
            <div className="result-list">
              {mockSimulatorRows.map((row) => (
                <div key={row.id} className={!row.visible ? "is-filtered" : ""}>
                  <code>{row.id}</code><span><strong>{row.title}</strong><small>{row.author} · {row.status}</small></span><span className={`result-verdict ${row.visible ? "allow" : "deny"}`}>{row.visible ? "Visible" : "Blocked"}</span>
                </div>
              ))}
            </div>
            <footer><span>Decided by</span>{mockPolicies.slice(0, 2).map((policy) => <code key={policy.name}>{policy.name}</code>)}</footer>
          </section>
        )}
      </div>
    </div>
  );
}

function DataScreen({ screen, client, live, bridgeKey, onRefresh, onNotice, onOpenDialog }: { screen: Exclude<StudioScreen, "Simulator">; client: StudioClient | null; live: LiveState | null; bridgeKey: string; onRefresh: () => void; onNotice: (message: string) => void; onOpenDialog: () => void }) {
  if (screen === "Policies") {
    return live !== null ? (
      <LivePoliciesScreen live={live} bridgeKey={bridgeKey} onRefresh={onRefresh} onNotice={onNotice} />
    ) : (
      <PoliciesScreen onNotice={onNotice} onOpenDialog={onOpenDialog} />
    );
  }
  if (screen === "Tables") {
    return client !== null && live !== null ? (
      <LiveTablesScreen client={client} live={live} bridgeKey={bridgeKey} onRefresh={onRefresh} onNotice={onNotice} />
    ) : (
      <TablesScreen />
    );
  }
  // Auth needs only the deployment's address: the diagnostic is public, so this
  // screen goes live on the client alone and does not wait for the /mcp reads.
  if (screen === "Auth") {
    return client !== null ? <LiveAuthScreen origin={client.origin} onNotice={onNotice} /> : <AuthScreen onNotice={onNotice} />;
  }
  if (screen === "Storage") return <StorageScreen onNotice={onNotice} />;
  // Health goes live on the client alone, like Auth: the diagnostic is public.
  // `live` may still be null when the /mcp reads failed, and the screen has to
  // tell that apart from a deployment with nothing wrong.
  return client !== null ? (
    <LiveHealthScreen origin={client.origin} live={live} bridgeKey={bridgeKey} onNotice={onNotice} />
  ) : (
    <HealthScreen />
  );
}

/**
 * The deployment's own policy list, and the editor decision Q5 planned as the
 * second phase. The listing reads over `/mcp`, which withholds predicates by
 * design. Editing goes through the local bridge instead: the stored source
 * document is read back for the operator's own page, and applying runs the
 * CLI's `policy apply` code path on the operator's machine, so there is still
 * exactly one write path and one validator. Deleting rules stays with the CLI
 * and its typed `--confirm`.
 */
function LivePoliciesScreen({ live, bridgeKey, onRefresh, onNotice }: { live: LiveState; bridgeKey: string; onRefresh: () => void; onNotice: (message: string) => void }) {
  const rows = live.policies.flatMap((entry) =>
    entry.policies.map((policy) => ({ ...policy, table: entry.table, enabled: entry.enabled, version: entry.version })),
  );
  const [selectedKey, setSelectedKey] = useState("");
  const selected = rows.find((row) => `${row.table}.${row.name}` === selectedKey) ?? rows[0];
  const command = "npx baseclf policy apply <document>.json --project <your-project>";

  // The editor. Opened per table, seeded with the stored source document read
  // through the bridge, applied through the bridge, which runs the CLI's own
  // apply. Nothing here ever holds or sends SQL.
  const [editing, setEditing] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyAnswer, setApplyAnswer] = useState<{ tone: "refusal" | "lines"; text: string } | null>(null);

  const openEditor = async (table: string) => {
    if (bridgeKey.trim() === "") {
      onNotice("Editing needs the bridge. Run npx baseclf studio and paste its key in the Simulator.");
      return;
    }
    setApplyAnswer(null);
    const answer = await readDocumentOnBridge(bridgeKey.trim(), table);
    if (answer.kind !== "data") {
      onNotice(answer.kind === "refusal" ? answer.message : answer.message);
      return;
    }
    const seed =
      answer.data.document ??
      ({ table, enabled: true, policies: [] } as Record<string, unknown>);
    setDraftText(JSON.stringify(seed, null, 2));
    setEditing(table);
  };

  const applyDraft = async () => {
    if (applyBusy || editing === null) return;
    setApplyBusy(true);
    setApplyAnswer(null);
    const answer = await applyOnBridge(bridgeKey.trim(), draftText);
    setApplyBusy(false);
    if (answer.kind === "refusal") {
      setApplyAnswer({ tone: "refusal", text: answer.message });
      onNotice("The engine refused the document. Nothing was stored.");
      return;
    }
    if (answer.kind === "error") {
      onNotice(answer.message);
      return;
    }
    setApplyAnswer({ tone: "lines", text: answer.data.lines.join("\n") });
    if (answer.data.applied) {
      onNotice(`Applied. The deployment now answers for "${editing}" under the new rules.`);
      onRefresh();
    } else {
      onNotice("The apply did not finish. The lines say where it stopped.");
    }
  };

  if (editing !== null) {
    return <div>
      <ScreenTitle kicker="Policy engine" title={`Edit ${editing}`} description="The document below is the stored source, read from the deployment. Applying replaces every rule on the table, through the same validation and the same steps as baseclf policy apply." action={<button className="studio-secondary" type="button" onClick={() => setEditing(null)}>Back to policies</button>} />
      <section className="detail-panel">
        <div className="editor-form">
          <label className="claims-field">Policy document<textarea rows={18} value={draftText} onChange={(event) => setDraftText(event.target.value)} spellCheck={false} /></label>
          {applyAnswer !== null && (
            <div className="editor-code-field">
              <span>{applyAnswer.tone === "refusal" ? "Refused by the engine. Nothing was stored." : "What the apply reported"}</span>
              <pre><code>{applyAnswer.text}</code></pre>
            </div>
          )}
          <div className="panel-actions">
            <button className="studio-primary" type="button" disabled={applyBusy} onClick={() => void applyDraft()}>{applyBusy ? "Applying…" : "Apply document"}</button>
            <button className="studio-secondary" type="button" disabled={applyBusy} onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      </section>
    </div>;
  }

  const findingFor = (table: string, name: string) =>
    live.findings.find((entry) => entry.table === table && entry.policy === `${table}.${name}`) ??
    live.findings.find((entry) => entry.table === table);

  return <div>
    <ScreenTitle kicker="Policy engine" title="Policies" description="What this deployment exposes, read from the deployment itself. Edit through the local bridge, which runs the same validation and the same apply as the CLI." action={<div className="panel-actions">{selected !== undefined && <button className="studio-primary" type="button" onClick={() => void openEditor(selected.table)}>Edit document</button>}<button className="studio-secondary" type="button" onClick={() => { void navigator.clipboard?.writeText(command); onNotice("CLI command copied. Policies are written with baseclf policy apply."); }}>Copy CLI command</button></div>} />
    <div className="workspace-grid">
      <section className="list-panel"><header><span>{rows.length} {rows.length === 1 ? "policy" : "policies"}</span><span className="machine-label">{live.withheld > 0 ? `${live.withheld} withheld` : "live"}</span></header><div className="data-list">{rows.length === 0 ? <button type="button" className="is-selected"><span><strong>Nothing exposed yet</strong><small>Apply a policy document to expose a table.</small></span></button> : rows.map((row) => <button key={`${row.table}.${row.name}`} type="button" className={selected !== undefined && `${row.table}.${row.name}` === `${selected.table}.${selected.name}` ? "is-selected" : ""} onClick={() => setSelectedKey(`${row.table}.${row.name}`)}><span><strong>{row.name}</strong><small>{row.table} · {row.operation}</small></span><span className={`state-label ${findingFor(row.table, row.name) !== undefined ? "attention" : "active"}`}>{findingFor(row.table, row.name) !== undefined ? "Needs index" : "Active"}</span></button>)}</div></section>
      <section className="detail-panel">{selected === undefined ? <div className="editor-form"><p>Nothing to show until a table is exposed. Save a policy document and apply it:</p><div className="editor-code-field"><span>Terminal</span><pre><code>{command}</code></pre></div></div> : <><header><div><span className="machine-label">Policy</span><h3>{selected.name}</h3></div><span className={`state-label ${findingFor(selected.table, selected.name) !== undefined ? "attention" : "active"}`}>{findingFor(selected.table, selected.name) !== undefined ? "Needs index" : "Active"}</span></header><div className="editor-form"><div className="editor-fields"><label>Operation<select value={selected.operation} disabled><option>{selected.operation}</option></select></label><label>Roles<select value={selected.roles.join(", ")} disabled><option>{selected.roles.join(", ")}</option></select></label></div><div className="validation-line"><span>{selected.hasCheck ? "Carries WITH CHECK" : "No WITH CHECK"}</span><code>{selected.columns.length} columns granted</code></div><div className="editor-code-field"><span>Granted columns</span><pre><code>{selected.columns.join(", ")}</code></pre></div>{selected.serverSet.length > 0 && <div className="validation-line"><span>Server-set, never from the request body</span><code>{selected.serverSet.join(", ")}</code></div>}<div className="editor-code-field"><span>Predicates stay on the deployment. Edit with the CLI:</span><pre><code>{command}</code></pre></div>{findingFor(selected.table, selected.name) !== undefined && <div className="warning-strip"><strong>Index required</strong><span>{findingFor(selected.table, selected.name)?.detail}</span>{findingFor(selected.table, selected.name)?.remedy !== undefined && <code>{findingFor(selected.table, selected.name)?.remedy}</code>}</div>}</div><footer><span className="machine-label">table {selected.table} · version {selected.version}</span><button className="studio-secondary" type="button" onClick={() => { void navigator.clipboard?.writeText(command); onNotice("CLI command copied."); }}>Copy CLI command</button></footer></>}</section>
    </div>
  </div>;
}

function ScreenTitle({ kicker, title, description, action }: { kicker: string; title: string; description: string; action?: ReactNode }) {
  return <div className="screen-title"><div><p className="section-kicker">{kicker}</p><h2>{title}</h2><p>{description}</p></div>{action}</div>;
}

function PoliciesScreen({ onNotice, onOpenDialog }: { onNotice: (message: string) => void; onOpenDialog: () => void }) {
  const [selected, setSelected] = useState<(typeof mockPolicies)[number]>(mockPolicies[0]);
  const [expression, setExpression] = useState("status = 'published' OR author_id = $auth.sub");
  return <div>
    <ScreenTitle kicker="Policy engine" title="Policies" description="Edit access rules and inspect the SQL BaseCLF generates." action={<button className="studio-primary" type="button" onClick={() => onNotice("New policy draft created.")}>New policy</button>} />
    <div className="workspace-grid">
      <section className="list-panel"><header><span>3 policies</span><input aria-label="Search policies" placeholder="Search" /></header><div className="data-list">{mockPolicies.map((policy) => <button key={policy.name} type="button" className={selected.name === policy.name ? "is-selected" : ""} onClick={() => setSelected(policy)}><span><strong>{policy.name}</strong><small>{policy.table} · {policy.operation}</small></span><span className={`state-label ${policy.state}`}>{policy.state === "attention" ? "Needs index" : "Active"}</span></button>)}</div></section>
      <section className="detail-panel"><header><div><span className="machine-label">Policy</span><h3>{selected.name}</h3></div><span className={`state-label ${selected.state}`}>{selected.state === "attention" ? "Needs index" : "Active"}</span></header><div className="editor-form"><div className="editor-fields"><label>Operation<select defaultValue={selected.operation.split(",")[0]}><option>select</option><option>insert</option><option>update</option></select></label><label>Role<select defaultValue={selected.role}><option>authenticated</option><option>anon</option></select></label></div><label>Expression<textarea value={expression} onChange={(event) => setExpression(event.target.value)} spellCheck={false} /></label><div className="validation-line"><span>Valid expression</span><code>2 predicates</code></div><div className="editor-code-field"><span>Generated SQL</span><pre><code>WHERE ({expression.replace("$auth.sub", "?1")})</code></pre></div>{selected.state === "attention" && <div className="warning-strip"><strong>Index required</strong><span>`posts.author_id` has no index.</span><code>CREATE INDEX idx_posts_author_id ON posts(author_id);</code></div>}</div><footer><button className="danger-link" type="button" onClick={onOpenDialog}>Delete</button><button className="studio-secondary" type="button">Discard</button><button className="studio-primary" type="button" onClick={() => onNotice(`Policy ${selected.name} saved.`)}>Save policy</button></footer></section>
    </div>
  </div>;
}

/**
 * The deployment's own tables, from `schema_list` and `schema_describe`.
 *
 * What shows is names and shapes, never rows and never a row count: counting
 * rows on D1 scans the table, and scans are what D1 bills for. Reads and
 * writes stay with the API and the CLI; this screen is read-only by the same
 * decision (Q5) that keeps the policies screen read-only.
 */
function LiveTablesScreen({ client, live, bridgeKey, onRefresh, onNotice }: { client: StudioClient; live: LiveState; bridgeKey: string; onRefresh: () => void; onNotice: (message: string) => void }) {
  const [selectedName, setSelectedName] = useState("");
  // The description remembers which table it belongs to, so changing the
  // selection needs no synchronous reset: a description for another table is
  // simply not current, and the loading state falls out of that.
  const [described, setDescribed] = useState<{ table: string; detail?: TableDetail; error?: string } | null>(null);
  // Same shape for the rows page. Nothing loads until the operator asks, and
  // each numbered page is its own small scan: the deployment bills rows read,
  // so the panel never runs a scan the person did not click for.
  const [browsed, setBrowsed] = useState<{ table: string; offset: number; page?: BrowsePage; error?: string } | null>(null);
  const [browsing, setBrowsing] = useState(false);
  // Which cell is open, by position in the page rather than by row identity: a
  // page is one snapshot and closing the editor is what ends it.
  const [editing, setEditing] = useState<{ rowAt: number; column: string; draft: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const selected = live.tables.find((table) => table.name === selectedName) ?? live.tables[0];
  const policyEntry = selected === undefined ? undefined : live.policies.find((entry) => entry.table === selected.name);
  const finding = selected === undefined ? undefined : live.findings.find((entry) => entry.table === selected.name);

  const loadRows = async (table: string, offset: number) => {
    if (browsing) return;
    setBrowsing(true);
    const answer = await browseOnBridge(bridgeKey, table, offset);
    setBrowsing(false);
    setBrowsed(
      answer.kind === "data"
        ? { table, offset, page: answer.data }
        : { table, offset, error: answer.message },
    );
    if (answer.kind !== "data") onNotice(answer.message);
  };

  useEffect(() => {
    if (selected === undefined) return;
    const name = selected.name;
    let stale = false;
    void client.describeTable(name).then((answer) => {
      if (stale) return;
      setDescribed(
        answer.kind === "data" ? { table: name, detail: answer.data } : { table: name, error: answer.message },
      );
    });
    return () => {
      stale = true;
    };
  }, [client, selected]);

  const current = described !== null && selected !== undefined && described.table === selected.name ? described : null;
  const detail = current?.detail ?? null;
  const detailError = current?.error ?? "";

  const rowsCurrent = browsed !== null && selected !== undefined && browsed.table === selected.name ? browsed : null;
  const rowsPage = rowsCurrent?.page;
  const pageSize = rowsPage?.limit ?? 50;
  const pageIndex = rowsPage === undefined ? 0 : Math.floor(rowsPage.offset / pageSize);
  // Numbered pages, discovered lazily: a full page proves one more exists, and
  // nothing is ever counted. The cap mirrors the bridge's scan ceiling.
  const MAX_BROWSE_PAGES = 20;
  const lastKnownPage = rowsPage === undefined ? 0 : pageIndex + (rowsPage.rows.length === pageSize ? 2 : 1);
  const pageNumbers = Array.from({ length: Math.min(lastKnownPage, MAX_BROWSE_PAGES) }, (_, at) => at + 1);
  const rowColumns = detail?.columns.map((column) => column.name) ?? Object.keys(rowsPage?.rows[0] ?? {});

  // Which columns name a row, and therefore which ones cannot be the thing that
  // changes: editing a key moves a row rather than editing it. A table that
  // declares none cannot be edited at all, because there is no way to address
  // one of its rows, and the panel says that instead of offering a field that
  // the bridge would refuse.
  const keyColumns = (detail?.columns ?? []).filter((column) => column.primaryKey).map((column) => column.name);
  const canEdit = detail !== undefined && keyColumns.length > 0 && bridgeKey !== "";

  /**
   * The draft, typed the way the column expects.
   *
   * ⚠️ A convenience, not a check. The bridge validates against the declared
   * type and refuses with its own message; doing it here as well only means the
   * common case does not need a round trip to be told it is wrong. If the two
   * ever disagree the bridge wins, which is the direction that keeps the
   * boundary in one place.
   */
  const typedDraft = (column: string, draft: string): string | number | null => {
    const declared = (detail?.columns.find((entry) => entry.name === column)?.type ?? "").toUpperCase();
    const nullable = detail?.columns.find((entry) => entry.name === column)?.notNull === false;
    if (draft === "" && nullable) return null;
    if (declared.includes("INT") || declared.includes("REAL") || declared.includes("FLOA") || declared.includes("DOUB")) {
      const asNumber = Number(draft);
      return draft.trim() !== "" && Number.isFinite(asNumber) ? asNumber : draft;
    }
    return draft;
  };

  const saveEdit = async (rowAt: number, column: string, draft: string) => {
    if (selected === undefined || rowsPage === undefined || saving) return;
    const row = rowsPage.rows[rowAt];
    if (row === undefined) return;

    setSaving(true);
    const answer = await editOnBridge(bridgeKey, {
      table: selected.name,
      // The whole key, taken from the row on screen. A partial one would address
      // more than the person pointed at, and the bridge refuses it.
      key: Object.fromEntries(keyColumns.map((name) => [name, row[name]])),
      column,
      // What the screen is showing, which is what makes the write safe without a
      // transaction: an edit against a value somebody else already changed
      // writes nothing and comes back as a refusal.
      expected: row[column] ?? null,
      next: typedDraft(column, draft),
    });
    setSaving(false);

    if (answer.kind === "data") {
      const next = rowsPage.rows.map((entry, at) => (at === rowAt ? answer.data.row : entry));
      setBrowsed({ table: selected.name, offset: rowsPage.offset, page: { ...rowsPage, rows: next } });
      setEditing(null);
      onNotice(
        answer.data.recorded
          ? `Changed ${column}. The edit is in _audit_log.`
          : (answer.data.warning ?? `Changed ${column}, and the audit log did not accept the entry.`),
      );
      return;
    }
    // A conflict is somebody else's write, not a failure of this one, and the
    // sentence says so. Either way the row on screen is stale, so it stays put
    // and the person is told to load it again rather than being shown a value
    // nothing wrote.
    onNotice(answer.message);
  };

  return <div>
    <ScreenTitle kicker="Database" title="Tables" description="Every application table, read from the deployment itself. Columns and indexes come from the deployment; rows come one small page at a time through your local bridge, and are never counted, because counting is a full scan D1 would bill for." action={<button className="studio-secondary" type="button" onClick={() => { void navigator.clipboard?.writeText("npx baseclf policy apply <document>.json"); onNotice("CLI command copied. Exposing a table is a policy document."); }}>Copy CLI command</button>} />
    <div className="workspace-grid">
      <section className="list-panel">
        <header><span>{live.tables.length} {live.tables.length === 1 ? "table" : "tables"}</span><span className="machine-label">live</span></header>
        <div className="data-list">
          {live.tables.length === 0 ? (
            live.problem !== "" ? (
              // A failed read is not an empty database. Saying "no tables" here
              // sent a person into a refresh loop against the rate limit that
              // caused the failure in the first place.
              <button type="button" className="is-selected" onClick={onRefresh}><span><strong>Could not read the deployment</strong><small>{live.problem} Click here to read again.</small></span></button>
            ) : (
              <button type="button" className="is-selected"><span><strong>No application tables yet</strong><small>Create one with wrangler d1 execute. It appears here after a refresh, within about a minute.</small></span></button>
            )
          ) : (
            live.tables.map((table) => (
              <button key={table.name} type="button" className={selected !== undefined && table.name === selected.name ? "is-selected" : ""} onClick={() => setSelectedName(table.name)}>
                <span><strong>{table.name}</strong><small>{table.columns} columns · {table.indexes} {table.indexes === 1 ? "index" : "indexes"}</small></span>
                <span className={`state-label ${table.exposed ? "active" : "blocked"}`}>{table.exposed ? "Exposed" : "Not exposed"}</span>
              </button>
            ))
          )}
        </div>
      </section>
      <section className="detail-panel">
        {selected === undefined ? (
          <div className="editor-form"><p>Nothing to show yet. Tables appear here as soon as the database has one.</p></div>
        ) : (
          <>
            <header>
              <div><span className="machine-label">Table</span><h3>{selected.name}</h3></div>
              <span className={`state-label ${selected.exposed ? "active" : "blocked"}`}>{selected.exposed ? `${policyEntry?.policies.length ?? 0} ${policyEntry?.policies.length === 1 ? "policy" : "policies"}` : "Not exposed"}</span>
            </header>
            {finding !== undefined && <div className="warning-strip page-strip"><strong>Policy requires an index</strong><span>{finding.detail}</span></div>}
            {detailError !== "" ? (
              <div className="editor-form"><p>{detailError}</p></div>
            ) : detail === null ? (
              <div className="editor-form"><p>Reading the table shape…</p></div>
            ) : (
              <div className="table-scroll">
                <table className="compact-table">
                  <thead><tr><th>Column</th><th>Type</th><th>Constraints</th><th>Default</th></tr></thead>
                  <tbody>
                    {detail.columns.map((column) => (
                      <tr key={column.name}>
                        <td><code>{column.name}</code></td>
                        <td>{column.type === "" ? "any" : column.type}</td>
                        <td>{[column.primaryKey ? "primary key" : "", column.notNull ? "not null" : ""].filter((part) => part !== "").join(", ") || "—"}</td>
                        <td>{column.hasDefault ? "yes" : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {detail.indexes.length > 0 && (
                  <table className="compact-table">
                    <thead><tr><th>Index</th><th>Columns</th><th>Unique</th></tr></thead>
                    <tbody>
                      {detail.indexes.map((index) => (
                        <tr key={index.name}><td><code>{index.name}</code></td><td>{index.columns.join(", ")}</td><td>{index.unique ? "yes" : "—"}</td></tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {detail.foreignKeys.length > 0 && (
                  <table className="compact-table">
                    <thead><tr><th>Foreign key</th><th>References</th></tr></thead>
                    <tbody>
                      {detail.foreignKeys.map((key) => (
                        <tr key={`${key.column}-${key.referencesTable}`}><td><code>{key.column}</code></td><td><code>{key.referencesTable}.{key.referencesColumn}</code></td></tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
            <section className="full-panel rows-panel">
              {/* The label names the write now that there is one. "Operator
                  view" described a read; a person who can change a cell needs
                  to know the change lands on real data with no policy in front
                  of it, and that a key column is not one of the things that
                  can change. */}
              <header><span>Rows · operator view, no policy applied{canEdit ? " · editable" : ""}</span>{rowsPage !== undefined && <span>{rowsPage.rows.length} rows · {rowsPage.rowsRead ?? "?"} scanned</span>}</header>
              {bridgeKey === "" ? (
                <div className="editor-form"><p>Rows come from your local bridge, read with your own credential. Run <code>npx baseclf studio</code> and paste its key into the Simulator&apos;s Result panel; this panel shares it. What a caller would see is the Simulator&apos;s question.</p></div>
              ) : rowsCurrent === null ? (
                <div className="editor-form"><p>Newest rows first, fifty per page. Every page is one small scan, run only when you ask for it. {keyColumns.length === 0 ? "This table declares no primary key, so a row cannot be named and nothing here can be edited." : "Click a cell to change it: the write goes to your data with no policy in front of it, one field at a time, and a key column stays put."}</p><button className="studio-secondary" type="button" disabled={browsing} onClick={() => void loadRows(selected.name, 0)}>{browsing ? "Loading…" : "Load latest rows"}</button></div>
              ) : rowsCurrent.error !== undefined ? (
                <div className="editor-form"><p>{rowsCurrent.error}</p><button className="studio-secondary" type="button" disabled={browsing} onClick={() => void loadRows(selected.name, rowsCurrent.offset)}>Try again</button></div>
              ) : rowsPage !== undefined && rowsPage.rows.length === 0 ? (
                <div className="editor-form"><p>{rowsPage.offset === 0 ? "The table has no rows yet." : "No rows on this page."}</p>{rowsPage.offset > 0 && <button className="studio-secondary" type="button" disabled={browsing} onClick={() => void loadRows(selected.name, 0)}>Back to page 1</button>}</div>
              ) : rowsPage !== undefined ? (
                <>
                  <div className="table-scroll">
                    <table className="compact-table">
                      <thead><tr>{rowColumns.map((name) => <th key={name}>{name}</th>)}</tr></thead>
                      <tbody>
                        {rowsPage.rows.map((row, index) => (
                          <tr key={`${String(row[rowColumns[0] ?? "id"] ?? "")}-${index}`}>
                            {rowColumns.map((name) => {
                              const cell = formatCell(name, row[name]);
                              const open = editing !== null && editing.rowAt === index && editing.column === name;
                              const editable = canEdit && !keyColumns.includes(name);
                              if (open) {
                                return <td key={name} className="cell-editing">
                                  <input
                                    // The rule is about focus taken from somebody who did not
                                    // ask for it. This input exists only because they clicked
                                    // the cell, and it unmounts when the edit ends, so not
                                    // focusing it would leave the caret on the cell behind a
                                    // box that is open and waiting. For a keyboard or screen
                                    // reader user that is the worse of the two.
                                    // eslint-disable-next-line jsx-a11y/no-autofocus
                                    autoFocus
                                    value={editing.draft}
                                    aria-label={`New value for ${name}`}
                                    disabled={saving}
                                    onChange={(event) => setEditing({ rowAt: index, column: name, draft: event.target.value })}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") void saveEdit(index, name, editing.draft);
                                      if (event.key === "Escape") setEditing(null);
                                    }}
                                  />
                                  <button className="studio-primary" type="button" disabled={saving} onClick={() => void saveEdit(index, name, editing.draft)}>{saving ? "Saving…" : "Save"}</button>
                                  <button className="studio-secondary" type="button" disabled={saving} onClick={() => setEditing(null)}>Cancel</button>
                                </td>;
                              }
                              return <td key={name} title={cell.title}>
                                {editable ? (
                                  <button className="cell-edit" type="button" onClick={() => setEditing({ rowAt: index, column: name, draft: row[name] === null || row[name] === undefined ? "" : String(row[name]) })}>{cell.text}</button>
                                ) : cell.text}
                              </td>;
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {pageNumbers.length > 1 && (
                    <div className="rows-pager">
                      {pageNumbers.map((number) => (
                        <button key={number} className={number === pageIndex + 1 ? "studio-primary" : "studio-secondary"} type="button" disabled={browsing} onClick={() => void loadRows(selected.name, (number - 1) * pageSize)}>{number}</button>
                      ))}
                    </div>
                  )}
                </>
              ) : null}
            </section>
          </>
        )}
      </section>
    </div>
  </div>;
}

function TablesScreen() {
  const [selected, setSelected] = useState<(typeof mockTables)[number]>(mockTables[0]);
  return <div><ScreenTitle kicker="Database" title="Tables" description="Inspect rows and see policy coverage before opening a table." action={<button className="studio-secondary" type="button">Read-only SQL</button>} /><div className="workspace-grid"><section className="list-panel"><header><span>3 tables</span><input aria-label="Search tables" placeholder="Search" /></header><div className="data-list">{mockTables.map((table) => <button key={table.name} type="button" className={selected.name === table.name ? "is-selected" : ""} onClick={() => setSelected(table)}><span><strong>{table.name}</strong><small>{table.rows} rows · {table.policies} policies</small></span><span className={`state-label ${table.state}`}>{table.state === "attention" ? "Review" : "Covered"}</span></button>)}</div></section><section className="detail-panel"><header><div><span className="machine-label">Table</span><h3>{selected.name}</h3></div><button className="studio-primary" type="button">New row</button></header>{selected.state === "attention" && <div className="warning-strip page-strip"><strong>Policy requires an index</strong><span>`author_id` is scanned for each protected request.</span></div>}<div className="table-scroll"><table className="compact-table"><thead><tr><th>id</th><th>title</th><th>author</th><th>status</th><th>access</th></tr></thead><tbody>{mockSimulatorRows.map((row) => <tr key={row.id}><td><code>{row.id}</code></td><td>{row.title}</td><td>{row.author}</td><td>{row.status}</td><td><span className={`state-label ${row.visible ? "active" : "blocked"}`}>{row.visible ? "Visible" : "Blocked"}</span></td></tr>)}</tbody></table></div></section></div></div>;
}

/**
 * The deployment's own auth configuration, read from `/api/auth/_diagnose`.
 *
 * No credential is attached and none is needed: that endpoint answers before
 * the limiter and before anything reads configuration, because it exists for a
 * deployment too broken to answer anywhere else. It reports presence, never
 * values, so nothing here is a secret the page should not hold.
 *
 * ## What this screen cannot show, and why it says so instead of faking it
 *
 * The fixture lists user records. There is no path to them: `user`, `session`,
 * `account`, `verification`, and `jwks` are reserved names, refused by the
 * catalogue, by the REST router, and by the bridge, and no MCP tool reads them.
 * That is the design working, not a gap to route around, so the screen states
 * the boundary rather than drawing an empty table that reads as "no users".
 */
function LiveAuthScreen({ origin, onNotice }: { origin: string; onNotice: (message: string) => void }) {
  const [state, setState] = useState<{ diagnose?: DiagnoseReport; error?: string } | null>(null);
  const [reading, setReading] = useState(false);

  const read = async (announce: boolean) => {
    setReading(true);
    const answer = await readDiagnose(origin);
    setReading(false);
    setState(answer.kind === "data" ? { diagnose: answer.diagnose } : { error: answer.message });
    if (answer.kind !== "data") onNotice(answer.message);
    else if (announce) {
      onNotice(
        answer.diagnose.warnings.length === 0
          ? "Auth diagnostic read. Nothing to warn about."
          : `Auth diagnostic read. ${answer.diagnose.warnings.length} thing${answer.diagnose.warnings.length === 1 ? "" : "s"} to look at.`,
      );
    }
  };

  useEffect(() => {
    let stale = false;
    void readDiagnose(origin).then((answer) => {
      if (stale) return;
      setState(answer.kind === "data" ? { diagnose: answer.diagnose } : { error: answer.message });
    });
    return () => {
      stale = true;
    };
  }, [origin]);

  const diagnose = state?.diagnose;
  const providers = diagnose === undefined ? [] : Object.entries(diagnose.providers);

  return (
    <div>
      <ScreenTitle
        kicker="Identity"
        title="Authentication"
        description="What this deployment has configured, read from the deployment itself."
        action={
          <button className="studio-primary" type="button" disabled={reading} onClick={() => void read(true)}>
            {reading ? "Reading…" : "Run diagnostic"}
          </button>
        }
      />
      {state === null ? (
        <section className="full-panel"><div className="editor-form"><p>Reading the deployment&apos;s auth configuration…</p></div></section>
      ) : state.error !== undefined ? (
        // Announces on success too, and that is the point: a failed read leaves
        // its message standing in the notification strip, so a silent recovery
        // leaves the person reading a failure that is no longer true. Watched
        // that happen, with the stale line following a disconnect onto the
        // fixture screen, where it read as a claim about the fixture.
        <section className="full-panel"><div className="editor-form"><p>{state.error}</p><button className="studio-secondary" type="button" disabled={reading} onClick={() => void read(true)}>Try again</button></div></section>
      ) : diagnose !== undefined ? (
        <>
          <div className="metric-grid auth-live">
            {providers.map(([name, provider]) => (
              <article key={name}>
                <span>{name}</span>
                <strong>{provider.configured ? "Configured" : "Not configured"}</strong>
                {/* The missing variable is named, because a provider that is
                    half configured is missing exactly one of its two and the
                    person needs to know which. Same words the CLI prints. */}
                <small>{provider.configured ? "Client id and secret are set" : `Missing ${provider.missing.join(" and ")}`}</small>
              </article>
            ))}
            <article>
              <span>Email and password</span>
              <strong>{diagnose.email_password_enabled ? "Enabled" : "Disabled"}</strong>
              <small>{diagnose.email_password_enabled ? "Hashing one password costs ~58 ms of CPU" : "Off by default: hashing costs ~58 ms against a 10 ms free-plan request"}</small>
            </article>
            <article>
              <span>Signing secret</span>
              <strong>{diagnose.secret_configured ? "Set" : "Missing"}</strong>
              <small>{diagnose.secret_configured ? "Presence only; the value never leaves the deployment" : "Every route answers 500 until this is set"}</small>
            </article>
          </div>

          {providers.map(([name, provider]) => (
            <section className="redirect-panel" key={`redirect-${name}`}>
              <div>
                <span className="machine-label">{name} redirect URI</span>
                <code>{provider.redirect_uri}</code>
              </div>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(provider.redirect_uri);
                  onNotice(`Copied the ${name} redirect URI.`);
                }}
              >
                Copy URI
              </button>
            </section>
          ))}

          <section className="full-panel">
            <header><span>Where browsers may call from</span><span>{diagnose.trusted_origins.length} origin{diagnose.trusted_origins.length === 1 ? "" : "s"}</span></header>
            <div className="editor-form">
              <p>
                {diagnose.base_url_matches
                  ? <>The configured address matches the one serving this request: <code>{diagnose.base_url_actual}</code>.</>
                  : <>The configured address is <code>{diagnose.base_url_config === "" ? "not a URL" : diagnose.base_url_config}</code> but this request was served by <code>{diagnose.base_url_actual}</code>. Sign-in redirects go to the configured one.</>}
              </p>
              <ul className="origin-list">
                {diagnose.trusted_origins.map((entry) => <li key={entry}><code>{entry}</code></li>)}
              </ul>
            </div>
          </section>

          <section className="full-panel">
            <header><span>Warnings</span><span>{diagnose.warnings.length === 0 ? "none" : `${diagnose.warnings.length}`}</span></header>
            <div className="editor-form">
              {diagnose.warnings.length === 0 ? (
                <p>Nothing to warn about. This is the same check <code>npx baseclf doctor</code> runs.</p>
              ) : (
                <ul className="origin-list">{diagnose.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              )}
            </div>
          </section>

          <section className="full-panel">
            <header><span>User records</span><span>not readable here</span></header>
            <div className="editor-form">
              <p>
                The identity tables are reserved names: the catalogue, the REST router, and the bridge each
                refuse them, and no tool reads them. That is deliberate, so this screen shows no user list
                rather than an empty one. Use the D1 console or <code>wrangler d1 execute</code>, which is the
                administrative path and bypasses the policy engine by design.
              </p>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function AuthScreen({ onNotice }: { onNotice: (message: string) => void }) {
  const redirect = `${mockProject.endpoint}/api/auth/callback/google`;
  return <div><ScreenTitle kicker="Identity" title="Authentication" description="Inspect users, provider status, and the redirect configuration used by your Worker." action={<button className="studio-primary" type="button" onClick={() => onNotice("Auth diagnostic completed. No blocking issue found.")}>Run diagnostic</button>} /><div className="metric-grid auth-providers"><article><span>Google</span><strong>Connected</strong><small>Client ID configured</small></article><article><span>GitHub</span><strong>Connected</strong><small>Client ID configured</small></article><article><span>Email</span><strong>Disabled</strong><small>No sender configured</small></article></div><section className="redirect-panel"><div><span className="machine-label">Google redirect URI</span><code>{redirect}</code></div><button type="button" onClick={() => navigator.clipboard?.writeText(redirect)}>Copy URI</button></section><section className="full-panel"><header><span>Users</span><span>{mockUsers.length} records</span></header><div className="table-scroll"><table className="compact-table"><thead><tr><th>User</th><th>ID</th><th>Provider</th><th>Status</th></tr></thead><tbody>{mockUsers.map((user) => <tr key={user.id}><td><strong>{user.name}</strong><small>{user.email}</small></td><td><code>{user.id}</code></td><td>{user.provider}</td><td><span className={`state-label ${user.state === "active" ? "active" : "blocked"}`}>{user.state}</span></td></tr>)}</tbody></table></div></section></div>;
}

function StorageScreen({ onNotice }: { onNotice: (message: string) => void }) {
  return <div><ScreenTitle kicker="R2 storage" title="Storage" description="Browse objects and inspect which policy controls each path." action={<button className="studio-primary" type="button" onClick={() => onNotice("Upload fixture added to the queue.")}>Upload object</button>} /><div className="storage-layout"><section className="bucket-list"><header>Buckets</header><button className="is-selected" type="button"><strong>app-files</strong><small>{mockStorageObjects.length} objects</small></button><button type="button"><strong>user-uploads</strong><small>Empty</small></button></section><section className="full-panel"><header><span>app-files</span><span>Mock objects</span></header><div className="table-scroll"><table className="compact-table"><thead><tr><th>Object</th><th>Type</th><th>Size</th><th>Access</th></tr></thead><tbody>{mockStorageObjects.map((object) => <tr key={object.name}><td><code>{object.name}</code></td><td>{object.type}</td><td>{object.size}</td><td><span className={`state-label ${object.access === "public" ? "attention" : "active"}`}>{object.access}</span></td></tr>)}</tbody></table></div></section></div></div>;
}

/**
 * What the deployment can say about its own condition, and nothing else.
 *
 * The fixture screen has two halves: numbers across the top, and a list of things
 * needing attention. Only the second half has a source that does not need the
 * operator's Cloudflare credential, so only the second half is here. The numbers were
 * measured to be reachable — `workersInvocationsAdaptive` filters down to one script,
 * and `d1AnalyticsAdaptiveGroups` carries rows read and written — but reaching them
 * needs the local bridge and a permission question nobody has answered yet, so the
 * panel below says where they live instead of drawing a chart with no data behind it.
 *
 * 🔴 The distinction the screen exists to keep: **nothing wrong** and **could not
 * look** are different answers. Rendering an empty warning list for a failed read is
 * the interface version of failing open, and this project has already watched a
 * refused read draw "0 TABLES / LIVE" over a database that had tables.
 */
function LiveHealthScreen({ origin, live, bridgeKey, onNotice }: { origin: string; live: LiveState | null; bridgeKey: string; onNotice: (message: string) => void }) {
  const [state, setState] = useState<{ diagnose?: DiagnoseReport; error?: string } | null>(null);
  const [reading, setReading] = useState(false);
  // Four states, and they are four different sentences: not asked for, being read,
  // read, and declined by Cloudflare. Collapsing the last two would turn "your token
  // cannot see this" into "there is nothing to see".
  const [usage, setUsage] = useState<
    { kind: "numbers"; numbers: UsageNumbers } | { kind: "said"; message: string } | null
  >(null);
  const [readingUsage, setReadingUsage] = useState(false);

  const readUsage = async () => {
    if (bridgeKey.trim() === "") {
      onNotice("The numbers need the bridge. Run npx baseclf studio and paste its key in the Simulator.");
      return;
    }
    setReadingUsage(true);
    const answer = await usageOnBridge(bridgeKey.trim());
    setReadingUsage(false);
    if (answer.kind === "data") {
      setUsage({ kind: "numbers", numbers: answer.data });
      return;
    }
    // A refusal and a broken bridge both end up here as a sentence, because both
    // are things the reader has to act on and neither is a number.
    setUsage({ kind: "said", message: answer.message });
    onNotice(answer.message);
  };

  const read = async (announce: boolean) => {
    setReading(true);
    const answer = await readDiagnose(origin);
    setReading(false);
    setState(answer.kind === "data" ? { diagnose: answer.diagnose } : { error: answer.message });
    if (answer.kind !== "data") onNotice(answer.message);
    else if (announce) onNotice("Read the deployment's own checks.");
  };

  useEffect(() => {
    let stale = false;
    void readDiagnose(origin).then((answer) => {
      if (stale) return;
      setState(answer.kind === "data" ? { diagnose: answer.diagnose } : { error: answer.message });
    });
    return () => {
      stale = true;
    };
  }, [origin]);

  const diagnose = state?.diagnose;
  // Three states, not two. `undefined` means the read has not answered or failed,
  // and an empty array means it answered with nothing to report.
  const configWarnings = diagnose?.warnings;
  const indexFindings = live?.problem === "" ? live.findings : undefined;
  const bindingsMissing = (diagnose?.bindings ?? []).filter((binding) => !binding.present);

  // Both messages below are somebody else's text followed by ours. Concatenated
  // raw they run together, and "Failed to fetch Nothing below is a statement about
  // its configuration" reads as one broken sentence; saw exactly that on screen.
  const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

  const readable = configWarnings !== undefined && indexFindings !== undefined;
  const total = (configWarnings?.length ?? 0) + (indexFindings?.length ?? 0) + bindingsMissing.length;
  const counted = readable ? `${total} item${total === 1 ? "" : "s"}` : "partly readable";

  return (
    <div>
      <ScreenTitle
        kicker="Operational record"
        title="Health"
        description="What this deployment reports about itself: the checks it can run without leaving the Worker."
        action={
          <button className="studio-primary" type="button" disabled={reading} onClick={() => void read(true)}>
            {reading ? "Reading…" : "Run checks"}
          </button>
        }
      />

      {state === null ? (
        <section className="full-panel"><div className="editor-form"><p>Reading the deployment&apos;s own checks…</p></div></section>
      ) : (
        <>
          <section className="full-panel">
            <header><span>Attention required</span><span>{counted}</span></header>
            <div className="editor-form">
              {state.error !== undefined && (
                <div className="warning-strip">
                  <strong>The deployment did not answer</strong>
                  <span>{sentence(state.error)} Nothing below is a statement about its configuration.</span>
                </div>
              )}

              {indexFindings === undefined && (
                <div className="warning-strip">
                  <strong>Policy warnings were not read</strong>
                  <span>
                    {live === null ? "The policy reads have not answered on this connection." : sentence(live.problem)}{" "}
                    An empty list here would mean nothing is wrong, so there is no list.
                  </span>
                </div>
              )}

              {readable && total === 0 ? (
                <p>
                  Nothing to report. These are the same checks <code>npx baseclf doctor</code> runs, plus the
                  index findings behind <code>baseclf policy lint</code>.
                </p>
              ) : (
                <div className="issue-list">
                  {(indexFindings ?? []).map((finding) => (
                    <div key={`${finding.table}.${finding.policy}.${finding.code}`}>
                      <span className="state-label attention">Index</span>
                      <p>
                        <strong>{finding.table}</strong>
                        <small>{finding.detail}</small>
                        {/* D1 bills rows scanned, not rows returned, so an unindexed
                            policy column is a recurring invoice rather than a style
                            note. The statement that fixes it is copyable for that
                            reason. rules/01 section D. */}
                        {finding.remedy !== undefined && <small><code>{finding.remedy}</code></small>}
                      </p>
                    </div>
                  ))}
                  {(configWarnings ?? []).map((warning) => (
                    <div key={`config-${warning}`}>
                      <span className="state-label attention">Config</span>
                      <p><strong>Configuration</strong><small>{warning}</small></p>
                    </div>
                  ))}
                  {bindingsMissing.map((binding) => (
                    <div key={`binding-${binding.name}`}>
                      <span className="state-label blocked">Binding</span>
                      <p>
                        <strong>{binding.name} is not bound</strong>
                        {/* A missing binding is the quiet one: the storage registry
                            reads an unreadable bucket list as no buckets, so those
                            routes answer 404 exactly as they would when working. */}
                        <small>Routes that need it answer as though nothing is there, which looks the same as working.</small>
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="full-panel">
            <header>
              <span>Usage numbers</span>
              <span>
                {usage?.kind === "numbers"
                  ? `${usage.numbers.since} to ${usage.numbers.until}`
                  : "from your Cloudflare account"}
              </span>
            </header>
            <div className="editor-form">
              {usage?.kind === "numbers" ? (
                <>
                  {/* The third line of each tile says something different, because
                      it can. Repeating the Worker's name six times filled the space
                      without telling anybody anything, which is what it looked like
                      on screen. What belongs there is the reason the number matters:
                      D1 bills rows scanned, an indexed write costs two, and the free
                      plan's ceiling is what makes a CPU median worth reading. */}
                  <div className="metric-grid">
                    {([
                      ["Requests", usage.numbers.requests.toLocaleString(), "over seven days"],
                      ["Errors", usage.numbers.errors.toLocaleString(), "requests that did not finish"],
                      ["Rows read", usage.numbers.rowsRead.toLocaleString(), "rows scanned, which is what D1 bills"],
                      ["Rows written", usage.numbers.rowsWritten.toLocaleString(), "an indexed write costs two"],
                      ["CPU median", usage.numbers.cpuP50 === null ? "no data" : `${(usage.numbers.cpuP50 / 1000).toFixed(1)} ms`, "the free plan allows 10 ms a request"],
                      ["CPU 99th", usage.numbers.cpuP99 === null ? "no data" : `${(usage.numbers.cpuP99 / 1000).toFixed(1)} ms`, "the slowest one in a hundred"],
                    ] as const).map(([label, value, note]) => (
                      <article key={label}>
                        <span>{label}</span>
                        <strong>{value}</strong>
                        <small>{note}</small>
                      </article>
                    ))}
                  </div>
                  <p>
                    Cloudflare&apos;s own record for the Worker named{" "}
                    <code>{usage.numbers.scriptName}</code>, not for the whole account. Rows read is the
                    one worth watching: D1 bills every row a query <em>scans</em>, not the rows it
                    returns, so an unindexed policy column is a recurring cost.
                  </p>
                </>
              ) : usage?.kind === "said" ? (
                <div className="warning-strip">
                  <strong>The numbers were not readable</strong>
                  <span>{usage.message}</span>
                </div>
              ) : (
                <p>
                  Requests, errors, CPU time, and rows read and written are recorded by Cloudflare
                  against your account, not by this deployment. Reading them needs your Cloudflare
                  credential, which this page never holds and the local bridge does. Run{" "}
                  <code>npx baseclf studio</code>, paste its key in the Simulator, then read them here.
                </p>
              )}
              <div className="panel-actions">
                <button className="studio-secondary" type="button" disabled={readingUsage} onClick={() => void readUsage()}>
                  {readingUsage ? "Reading…" : usage === null ? "Read usage numbers" : "Read again"}
                </button>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function HealthScreen() {
  const metrics = [["D1 size", mockHealth.databaseSize], ["Rows read", mockHealth.rowsRead], ["Rows written", mockHealth.rowsWritten], ["Requests", mockHealth.requests], ["Failures", mockHealth.failures]];
  return <div><ScreenTitle kicker="Operational record" title="Health" description="Review usage and policy warnings. Values remain mock data until telemetry contracts are approved." action={<span className="mock-badge">Mock data</span>} /><div className="metric-grid">{metrics.map(([label, value]) => <article key={label}><span>{label}</span><strong>{value}</strong><small>{mockHealth.period}</small></article>)}</div><div className="health-grid"><section className="full-panel"><header><span>Rows read and written</span><span>{mockHealth.period}</span></header><div className="mock-chart" aria-label="Mock seven-day activity chart">{[42,68,54,82,61,74,47].map((height, index) => <div key={index}><i style={{ height: `${height}%` }} /><span>Day {index + 1}</span></div>)}</div></section><section className="full-panel"><header><span>Attention required</span><span>2 items</span></header><div className="issue-list"><div><span className="state-label attention">Index</span><p><strong>posts.author_id</strong><small>Policy scans an unindexed column.</small></p></div><div><span className="state-label attention">Config</span><p><strong>Email provider disabled</strong><small>Passwordless email cannot send sign-in links.</small></p></div></div></section></div></div>;
}

function StateGallery({ onClose, sectionRef }: { onClose: () => void; sectionRef: RefObject<HTMLElement | null> }) {
  const states = [
    ["Loading", "Three restrained skeleton rows indicate pending data."],
    ["Empty", "No records yet. The primary action stays visible."],
    ["Error", "The error names what failed and offers one recovery action."],
    ["Permission", "The user can see the boundary without seeing protected data."],
    ["Success", "A concise confirmation appears as a dismissible toast."],
  ];
  return <div className="palette-backdrop state-gallery-backdrop" role="button" tabIndex={0} aria-label="Close state gallery" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onClose(); }}><section className="state-gallery" role="dialog" aria-modal="true" aria-labelledby="gallery-title" ref={sectionRef}><header><div><span className="machine-label">Shared system</span><h2 id="gallery-title">Interface states</h2></div><button type="button" onClick={onClose}>Close</button></header><div>{states.map(([title, description], index) => <article key={title}><span className={`gallery-state gallery-${index}`}>{index === 0 ? <><i /><i /><i /></> : index === 1 ? "0" : index === 2 ? "!" : index === 3 ? "×" : "✓"}</span><h3>{title}</h3><p>{description}</p></article>)}</div></section></div>;
}
