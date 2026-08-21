"use client";

import { FormEvent, ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import ThemeToggle from "../ThemeToggle";
import {
  type BridgeRows,
  type LintFinding,
  type PolicyTable,
  runOnBridge,
  type SimulateResult,
  StudioClient,
} from "../lib/api/studio";
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

/** What one connection learns up front: the exposed tables and what lint says. */
interface LiveState {
  readonly policies: readonly PolicyTable[];
  readonly findings: readonly LintFinding[];
  readonly withheld: number;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

const navigation: StudioScreen[] = ["Simulator", "Policies", "Tables", "Auth", "Storage", "Health"];
const guidance: Record<StudioScreen, { label: string; copy: string }> = {
  Simulator: { label: "Recommended next", copy: "Run the request as an authenticated user, then compare it with anon access." },
  Policies: { label: "Start safe", copy: "Review the highlighted policy before creating a new rule." },
  Tables: { label: "Data check", copy: "Open posts first—the missing index warning needs attention." },
  Auth: { label: "Setup check", copy: "Copy the redirect URI, then run the provider diagnostic." },
  Storage: { label: "Access first", copy: "Choose a bucket and confirm its policy before uploading an object." },
  Health: { label: "What matters", copy: "Start with failures, then inspect the request trend." },
};

export default function StudioApp() {
  const [screen, setScreen] = useState<StudioScreen>("Simulator");
  const [mode, setMode] = useState<StudioMode>("demo");
  const [client, setClient] = useState<StudioClient | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [notice, setNotice] = useState("Policy simulation ready.");

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
  const beginLive = async (nextClient: StudioClient) => {
    setClient(nextClient);
    setLive(null);
    setMode("live");
    announce(`Connected to ${hostOf(nextClient.origin)}.`);

    const [policyAnswer, lintAnswer] = await Promise.all([
      nextClient.policies(),
      nextClient.lint(),
    ]);
    if (policyAnswer.kind === "error") announce(policyAnswer.message);
    setLive({
      policies: policyAnswer.kind === "data" ? policyAnswer.data.tables : [],
      findings: lintAnswer.kind === "data" ? lintAnswer.data.findings : [],
      withheld: lintAnswer.kind === "data" ? lintAnswer.data.withheld : 0,
    });
  };

  const disconnect = () => {
    setClient(null);
    setLive(null);
    setMode("connect");
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

  return (
    <main className="studio-root" data-density="compact">
      <aside className={`studio-sidebar ${menuOpen ? "is-mobile-open" : ""}`} aria-label="Studio navigation">
        <Link className="studio-brand" href="/" aria-label="BaseCLF landing page">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>baseclf</span>
        </Link>
        <div className="studio-project">
          <span className="machine-label">Project</span>
          <strong>{mode === "live" && client ? hostOf(client.origin) : mockProject.name}</strong>
          <span className="connection-state"><i /> {mode === "live" ? "Live connection" : "Demo connection"}</span>
          <div className="studio-project-progress"><span><i /></span><small>3 of 4 setup steps ready</small></div>
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
      </aside>

      <section className="studio-workspace">
        <div className="studio-ambient" aria-hidden="true" />
        <header className="studio-header">
          <button className="mobile-menu" type="button" aria-label="Open navigation" onClick={() => setMenuOpen((value) => !value)}>Menu</button>
          <div>
            <span className="machine-label">{mode === "live" && client ? `live / ${hostOf(client.origin)}` : `${mockProject.environment} / ${mockProject.database}`}</span>
            <h1>{connected ? screen : "Connect Studio"}</h1>
          </div>
          <div className="studio-header-actions">
            <Link className="studio-help" href="/docs">Need help?</Link>
            <span className="mock-badge">{mode === "live" ? "Live connection" : "Mock data"}</span>
            <ThemeToggle />
            <button className="connection-button" type="button" onClick={() => (mode === "demo" ? setMode("connect") : mode === "connect" ? setMode("demo") : disconnect())}>
              {mode === "demo" ? "Connect live" : mode === "connect" ? "Use demo" : "Disconnect"}
            </button>
          </div>
        </header>

        <div className="studio-content">
          {connected && <aside className="studio-guide"><span>{guidance[screen].label}</span><p>{guidance[screen].copy}</p><button type="button" onClick={() => setPaletteOpen(true)}>Show actions <kbd>⌘K</kbd></button></aside>}
          <div className="studio-screen-stage" key={connected ? `${mode}-${screen}` : "connect"}>{!connected ? (
              <ConnectPanel onConnected={beginLive} onDemo={() => setMode("demo")} />
            ) : screen === "Simulator" ? (
              <SimulatorPanel client={mode === "live" ? client : null} live={live} onNotice={announce} />
            ) : (
              <DataScreen screen={screen} live={mode === "live" ? live : null} onNotice={announce} onOpenDialog={() => setDialogOpen(true)} />
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
          <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command menu">
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
      {dialogOpen && <div className="palette-backdrop" role="button" tabIndex={0} aria-label="Close delete dialog" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialogOpen(false); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setDialogOpen(false); }}><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title"><span className="dialog-icon">!</span><h2 id="delete-title">Delete this policy?</h2><p>This preview action does not delete real data. In production, requests relying on this policy could change access immediately.</p><div><button className="studio-secondary" type="button" onClick={() => setDialogOpen(false)}>Cancel</button><button className="danger-button" type="button" onClick={() => { setDialogOpen(false); announce("Mock policy deleted. No product data changed."); }}>Delete policy</button></div></section></div>}
      {galleryOpen && <StateGallery onClose={() => setGalleryOpen(false)} />}
      {toast && <div className="studio-toast" role="status"><span className="status-pulse" />{toast}<button type="button" onClick={() => setToast("")} aria-label="Dismiss notification">×</button></div>}
    </main>
  );
}

function ConnectPanel({ onConnected, onDemo }: { onConnected: (client: StudioClient) => void; onDemo: () => void }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * The connection test is a real round trip: tools/list against the deployment.
   * There is no token format to check locally, because the admin token is
   * whatever MCP_TOKEN the operator set; only the deployment knows it.
   */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const candidate = new StudioClient(url, token);
    const answer = await candidate.connect();
    setBusy(false);
    if ("error" in answer) {
      setError(answer.error);
      return;
    }
    onConnected(candidate);
  };

  return (
    <div className="connect-layout">
      <section className="connect-copy">
        <p className="section-kicker">Live connection</p>
        <h2>Connect Studio to your Worker.</h2>
        <p>The deployment URL and admin token are sent directly to your Worker and are not stored by BaseCLF. The token is the MCP_TOKEN secret you set on the deployment, and it stays in this page&apos;s memory only.</p>
        <dl>
          <div><dt>Transport</dt><dd>HTTPS to your Worker</dd></div>
          <div><dt>Credential storage</dt><dd>This page, in memory</dd></div>
          <div><dt>BaseCLF servers</dt><dd>Not involved</dd></div>
        </dl>
      </section>
      <form className="connect-form" onSubmit={submit}>
        <label>Worker URL<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://your-project.your-subdomain.workers.dev" required /></label>
        <label>Admin token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="The MCP_TOKEN secret" aria-describedby={error ? "token-error" : "token-help"} required /></label>
        {error ? <p className="form-error" id="token-error">{error}</p> : <p className="form-help" id="token-help">This page&apos;s origin has to be in the deployment&apos;s trusted origins.</p>}
        <button className="studio-primary" type="submit" disabled={busy}>{busy ? "Connecting…" : "Connect Studio"}</button>
        <button className="studio-secondary" type="button" onClick={onDemo}>Open demo workspace</button>
      </form>
    </div>
  );
}

function SimulatorPanel({ client, live, onNotice }: { client: StudioClient | null; live: LiveState | null; onNotice: (message: string) => void }) {
  if (client !== null) return <LiveSimulatorPanel client={client} live={live} onNotice={onNotice} />;
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
function LiveSimulatorPanel({ client, live, onNotice }: { client: StudioClient; live: LiveState | null; onNotice: (message: string) => void }) {
  const tables = live === null ? [] : live.policies.map((entry) => entry.table);
  const [mode, setMode] = useState<"results" | "sql">("results");
  const [table, setTable] = useState("");
  const [operation, setOperation] = useState<"select" | "insert" | "update" | "delete">("select");
  const [role, setRole] = useState("authenticated");
  const [claimsText, setClaimsText] = useState('{ "uid": "u_demo" }');
  const [bodyText, setBodyText] = useState('{ "title": "edited" }');
  const [bridgeKey, setBridgeKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [rowsAnswer, setRowsAnswer] = useState<BridgeRows | null>(null);

  const chosenTable = table !== "" ? table : (tables[0] ?? "");
  const writesBody = operation === "insert" || operation === "update";

  const run = async (asRole: string) => {
    if (busy) return;
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
          <label className="claims-field">Bridge key, from npx baseclf studio<textarea rows={1} value={bridgeKey} onChange={(event) => setBridgeKey(event.target.value)} placeholder="Leave empty to compile without rows" spellCheck={false} /></label>
          <div className="panel-actions">
            <button className="studio-primary" type="button" disabled={busy} onClick={() => void run(role)}>{busy ? "Compiling…" : "Run simulation"}</button>
            <button className="studio-secondary" type="button" disabled={busy} onClick={() => { setRole("anon"); void run("anon"); }}>Run as anon</button>
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
                <div><span><strong>The deployment compiles without touching data.</strong><small>Rows come from the local bridge: run npx baseclf studio, paste its key on the left, and rerun. Your credential stays on your machine.</small></span></div>
              ) : rowsAnswer.rows.length === 0 ? (
                <div><span><strong>No rows for this caller.</strong><small>Either there are none, or none are theirs. The engine answers both the same way on purpose.</small></span></div>
              ) : (
                rowsAnswer.rows.map((row, index) => (
                  <div key={String(row.id ?? index)}>
                    <code>{String(row.id ?? index)}</code>
                    <span><strong>{String(row.title ?? row.name ?? Object.values(row)[1] ?? "")}</strong><small>{Object.entries(row).filter(([column]) => column !== "id" && column !== "title").slice(0, 3).map(([column, value]) => `${column}: ${String(value)}`).join(" · ")}</small></span>
                    <span className="result-verdict allow">Visible</span>
                  </div>
                ))
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

function DataScreen({ screen, live, onNotice, onOpenDialog }: { screen: Exclude<StudioScreen, "Simulator">; live: LiveState | null; onNotice: (message: string) => void; onOpenDialog: () => void }) {
  if (screen === "Policies") {
    return live !== null ? (
      <LivePoliciesScreen live={live} onNotice={onNotice} />
    ) : (
      <PoliciesScreen onNotice={onNotice} onOpenDialog={onOpenDialog} />
    );
  }
  if (screen === "Tables") return <TablesScreen />;
  if (screen === "Auth") return <AuthScreen onNotice={onNotice} />;
  if (screen === "Storage") return <StorageScreen onNotice={onNotice} />;
  return <HealthScreen />;
}

/**
 * The deployment's own policy list, read-only by decision Q5: the write path is
 * `baseclf policy apply`, whose validator refuses a bad document before it is
 * stored, and this screen hands out that command instead of growing a second
 * write path. Predicates are absent because `policy_list` withholds them by
 * design; what the operator gets is what the deployment will admit to a client
 * holding the admin token.
 */
function LivePoliciesScreen({ live, onNotice }: { live: LiveState; onNotice: (message: string) => void }) {
  const rows = live.policies.flatMap((entry) =>
    entry.policies.map((policy) => ({ ...policy, table: entry.table, enabled: entry.enabled, version: entry.version })),
  );
  const [selectedKey, setSelectedKey] = useState("");
  const selected = rows.find((row) => `${row.table}.${row.name}` === selectedKey) ?? rows[0];
  const command = "npx baseclf policy apply <document>.json --project <your-project>";

  const findingFor = (table: string, name: string) =>
    live.findings.find((entry) => entry.table === table && entry.policy === `${table}.${name}`) ??
    live.findings.find((entry) => entry.table === table);

  return <div>
    <ScreenTitle kicker="Policy engine" title="Policies" description="What this deployment exposes, read from the deployment itself. Documents are edited with the CLI, whose validator refuses a bad one before it is stored." action={<button className="studio-secondary" type="button" onClick={() => { void navigator.clipboard?.writeText(command); onNotice("CLI command copied. Policies are written with baseclf policy apply."); }}>Copy CLI command</button>} />
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

function TablesScreen() {
  const [selected, setSelected] = useState<(typeof mockTables)[number]>(mockTables[0]);
  return <div><ScreenTitle kicker="Database" title="Tables" description="Inspect rows and see policy coverage before opening a table." action={<button className="studio-secondary" type="button">Read-only SQL</button>} /><div className="workspace-grid"><section className="list-panel"><header><span>3 tables</span><input aria-label="Search tables" placeholder="Search" /></header><div className="data-list">{mockTables.map((table) => <button key={table.name} type="button" className={selected.name === table.name ? "is-selected" : ""} onClick={() => setSelected(table)}><span><strong>{table.name}</strong><small>{table.rows} rows · {table.policies} policies</small></span><span className={`state-label ${table.state}`}>{table.state === "attention" ? "Review" : "Covered"}</span></button>)}</div></section><section className="detail-panel"><header><div><span className="machine-label">Table</span><h3>{selected.name}</h3></div><button className="studio-primary" type="button">New row</button></header>{selected.state === "attention" && <div className="warning-strip page-strip"><strong>Policy requires an index</strong><span>`author_id` is scanned for each protected request.</span></div>}<div className="table-scroll"><table className="compact-table"><thead><tr><th>id</th><th>title</th><th>author</th><th>status</th><th>access</th></tr></thead><tbody>{mockSimulatorRows.map((row) => <tr key={row.id}><td><code>{row.id}</code></td><td>{row.title}</td><td>{row.author}</td><td>{row.status}</td><td><span className={`state-label ${row.visible ? "active" : "blocked"}`}>{row.visible ? "Visible" : "Blocked"}</span></td></tr>)}</tbody></table></div></section></div></div>;
}

function AuthScreen({ onNotice }: { onNotice: (message: string) => void }) {
  const redirect = `${mockProject.endpoint}/api/auth/callback/google`;
  return <div><ScreenTitle kicker="Identity" title="Authentication" description="Inspect users, provider status, and the redirect configuration used by your Worker." action={<button className="studio-primary" type="button" onClick={() => onNotice("Auth diagnostic completed. No blocking issue found.")}>Run diagnostic</button>} /><div className="metric-grid auth-providers"><article><span>Google</span><strong>Connected</strong><small>Client ID configured</small></article><article><span>GitHub</span><strong>Connected</strong><small>Client ID configured</small></article><article><span>Email</span><strong>Disabled</strong><small>No sender configured</small></article></div><section className="redirect-panel"><div><span className="machine-label">Google redirect URI</span><code>{redirect}</code></div><button type="button" onClick={() => navigator.clipboard?.writeText(redirect)}>Copy URI</button></section><section className="full-panel"><header><span>Users</span><span>{mockUsers.length} records</span></header><div className="table-scroll"><table className="compact-table"><thead><tr><th>User</th><th>ID</th><th>Provider</th><th>Status</th></tr></thead><tbody>{mockUsers.map((user) => <tr key={user.id}><td><strong>{user.name}</strong><small>{user.email}</small></td><td><code>{user.id}</code></td><td>{user.provider}</td><td><span className={`state-label ${user.state === "active" ? "active" : "blocked"}`}>{user.state}</span></td></tr>)}</tbody></table></div></section></div>;
}

function StorageScreen({ onNotice }: { onNotice: (message: string) => void }) {
  return <div><ScreenTitle kicker="R2 storage" title="Storage" description="Browse objects and inspect which policy controls each path." action={<button className="studio-primary" type="button" onClick={() => onNotice("Upload fixture added to the queue.")}>Upload object</button>} /><div className="storage-layout"><section className="bucket-list"><header>Buckets</header><button className="is-selected" type="button"><strong>app-files</strong><small>{mockStorageObjects.length} objects</small></button><button type="button"><strong>user-uploads</strong><small>Empty</small></button></section><section className="full-panel"><header><span>app-files</span><span>Mock objects</span></header><div className="table-scroll"><table className="compact-table"><thead><tr><th>Object</th><th>Type</th><th>Size</th><th>Access</th></tr></thead><tbody>{mockStorageObjects.map((object) => <tr key={object.name}><td><code>{object.name}</code></td><td>{object.type}</td><td>{object.size}</td><td><span className={`state-label ${object.access === "public" ? "attention" : "active"}`}>{object.access}</span></td></tr>)}</tbody></table></div></section></div></div>;
}

function HealthScreen() {
  const metrics = [["D1 size", mockHealth.databaseSize], ["Rows read", mockHealth.rowsRead], ["Rows written", mockHealth.rowsWritten], ["Requests", mockHealth.requests], ["Failures", mockHealth.failures]];
  return <div><ScreenTitle kicker="Operational record" title="Health" description="Review usage and policy warnings. Values remain mock data until telemetry contracts are approved." action={<span className="mock-badge">Mock data</span>} /><div className="metric-grid">{metrics.map(([label, value]) => <article key={label}><span>{label}</span><strong>{value}</strong><small>{mockHealth.period}</small></article>)}</div><div className="health-grid"><section className="full-panel"><header><span>Rows read and written</span><span>{mockHealth.period}</span></header><div className="mock-chart" aria-label="Mock seven-day activity chart">{[42,68,54,82,61,74,47].map((height, index) => <div key={index}><i style={{ height: `${height}%` }} /><span>Day {index + 1}</span></div>)}</div></section><section className="full-panel"><header><span>Attention required</span><span>2 items</span></header><div className="issue-list"><div><span className="state-label attention">Index</span><p><strong>posts.author_id</strong><small>Policy scans an unindexed column.</small></p></div><div><span className="state-label attention">Config</span><p><strong>Email provider disabled</strong><small>Passwordless email cannot send sign-in links.</small></p></div></div></section></div></div>;
}

function StateGallery({ onClose }: { onClose: () => void }) {
  const states = [
    ["Loading", "Three restrained skeleton rows indicate pending data."],
    ["Empty", "No records yet. The primary action stays visible."],
    ["Error", "The error names what failed and offers one recovery action."],
    ["Permission", "The user can see the boundary without seeing protected data."],
    ["Success", "A concise confirmation appears as a dismissible toast."],
  ];
  return <div className="palette-backdrop state-gallery-backdrop" role="button" tabIndex={0} aria-label="Close state gallery" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onClose(); }}><section className="state-gallery" role="dialog" aria-modal="true" aria-labelledby="gallery-title"><header><div><span className="machine-label">Shared system</span><h2 id="gallery-title">Interface states</h2></div><button type="button" onClick={onClose}>Close</button></header><div>{states.map(([title, description], index) => <article key={title}><span className={`gallery-state gallery-${index}`}>{index === 0 ? <><i /><i /><i /></> : index === 1 ? "0" : index === 2 ? "!" : index === 3 ? "×" : "✓"}</span><h3>{title}</h3><p>{description}</p></article>)}</div></section></div>;
}
