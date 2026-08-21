"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  type RestExchange,
  type SchemaTableSummary,
  sendAnonymousRead,
} from "../../lib/api/deployment";
import {
  getServerOrigin,
  getSharedOrigin,
  subscribeSharedOrigin,
} from "../connection";
import ExpansionShell from "../expansion/ExpansionShell";

type ResponseTab = "Response" | "cURL" | "JavaScript";

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * The API Explorer, against the connected deployment.
 *
 * Every request it sends is a real anonymous GET: no token, no session, so the
 * response is exactly what the public sees and the policies decide every row.
 * Reads only, by the same decision that keeps the rest of the Studio
 * read-only in this build; the write path is application code with a session,
 * which the JavaScript tab shows how to start.
 */
export default function ApiExplorerApp() {
  const origin = useSyncExternalStore(subscribeSharedOrigin, getSharedOrigin, getServerOrigin);
  return origin === null ? <DisconnectedExplorer /> : <ConnectedExplorer origin={origin} />;
}

function ExplorerIntro({ caller }: { caller: string }) {
  return (
    <div className="api-intro">
      <div>
        <span className="expansion-kicker">Safe request builder</span>
        <h2>Try the API before writing app code.</h2>
        <p>Send a real request, read the real answer, then copy the client code when it looks right.</p>
      </div>
      <span className="api-role"><i /> {caller}</span>
    </div>
  );
}

function DisconnectedExplorer() {
  return (
    <ExpansionShell active="API Explorer" title="API Explorer" eyebrow="Your deployment / instant API">
      <ExplorerIntro caller="Not connected" />
      <section className="api-console">
        <div className="api-builder">
          <header><span>Request</span><b>No deployment yet</b></header>
          <div className="request-line">
            <select aria-label="HTTP method" disabled><option>GET</option></select>
            <input aria-label="Request path" value="/rest/v1/…" readOnly />
            <button type="button" disabled>Send request</button>
          </div>
          <aside>
            <strong>Connect first</strong>
            <p>This explorer sends anonymous requests to your own deployment. Connect once in the Studio and it knows where to send them; the token never reaches this page.</p>
          </aside>
          <div className="request-details">
            <span>What you will see</span>
            <div><code>x-baseclf-rows-read</code><code>what the request scanned</code></div>
            <div><code>x-d1-bookmark</code><code>the read-replication session</code></div>
          </div>
        </div>
        <div className="api-output">
          <header><div><button className="is-selected" type="button">Response</button></div><span>Waiting</span></header>
          <pre><code>{"-- Connect in the Studio, then send a request to see the real answer."}</code></pre>
          <footer><span>Nothing has been sent.</span><Link href="/studio">Open the Studio →</Link></footer>
        </div>
      </section>
    </ExpansionShell>
  );
}

function ConnectedExplorer({ origin }: { origin: string }) {
  const [tables, setTables] = useState<readonly SchemaTableSummary[]>([]);
  const [path, setPath] = useState("/rest/v1/");
  const [pathTouched, setPathTouched] = useState(false);
  const [tab, setTab] = useState<ResponseTab>("Response");
  const [busy, setBusy] = useState(false);
  const [exchange, setExchange] = useState<RestExchange | null>(null);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    let stale = false;
    void fetch(`${origin}/_schema`, { headers: { accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : { tables: [] }))
      .then((body) => {
        if (stale) return;
        const listed = (body as { tables?: SchemaTableSummary[] }).tables ?? [];
        setTables(listed);
        const first = listed[0];
        if (first !== undefined) {
          setPath((current) => (current === "/rest/v1/" ? `/rest/v1/${first.name}?limit=10` : current));
        }
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [origin]);

  const tableInPath = /^\/rest\/v1\/([^/?]+)/.exec(path)?.[1] ?? "";

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setProblem("");
    const answer = await sendAnonymousRead(origin, path);
    setBusy(false);
    if (answer.kind === "error") {
      setExchange(null);
      setProblem(answer.message);
      return;
    }
    setExchange(answer.exchange);
  };

  const curl = `curl '${origin}${path}'`;
  const snippet = [
    'import { createClient } from "baseclf-js";',
    "",
    `const client = createClient("${origin}");`,
    `const { data, error } = await client.from("${tableInPath === "" ? "your_table" : tableInPath}").select("*").limit(10);`,
  ].join("\n");
  const output = tab === "Response" ? (problem !== "" ? problem : (exchange?.body ?? "-- Send a request to see the real answer.")) : tab === "cURL" ? curl : snippet;

  return (
    <ExpansionShell active="API Explorer" title="API Explorer" eyebrow={`live / ${hostOf(origin)}`} connection={hostOf(origin)}>
      <ExplorerIntro caller="Running as anon — no token attached" />
      <section className="api-console">
        <div className="api-builder">
          <header><span>Request</span><b>{hostOf(origin)}</b></header>
          <div className="request-line">
            <select aria-label="HTTP method" disabled title="Reads only in this build. Writes are application code with a session."><option>GET</option></select>
            <input value={path} onChange={(event) => { setPath(event.target.value); setPathTouched(true); }} aria-label="Request path" spellCheck={false} />
            <button type="button" onClick={() => void send()} disabled={busy}>{busy ? "Sending…" : "Send request"}</button>
          </div>
          <div className="api-fields">
            <label>Table
              <select
                value={tables.some((table) => table.name === tableInPath) ? tableInPath : ""}
                onChange={(event) => { setPath(`/rest/v1/${event.target.value}?limit=10`); setPathTouched(false); }}
              >
                {tables.length === 0 ? <option value="">no tables listed</option> : null}
                {pathTouched && !tables.some((table) => table.name === tableInPath) ? <option value="">custom path</option> : null}
                {tables.map((table) => <option key={table.name} value={table.name}>{table.name}</option>)}
              </select>
            </label>
            <label>Method
              <select disabled title="Reads only in this build."><option>GET — reads only</option></select>
            </label>
          </div>
          <div className="request-details">
            <span>Headers sent</span>
            <div><code>accept</code><code>application/json</code></div>
            <div><code>Authorization</code><code>none — anonymous</code></div>
          </div>
          <aside>
            <strong>Policy check enabled</strong>
            <p>The response only contains rows the anon role may read. A table with no policy answers 404, and that is the engine working, not failing.</p>
          </aside>
        </div>
        <div className="api-output">
          <header>
            <div>{(["Response", "cURL", "JavaScript"] as ResponseTab[]).map((item) => <button key={item} className={tab === item ? "is-selected" : ""} type="button" onClick={() => setTab(item)}>{item}</button>)}</div>
            <span>{problem !== "" ? "Failed" : exchange === null ? "Ready" : `${exchange.status} · ${exchange.durationMs} ms`}</span>
          </header>
          <pre><code>{output}</code></pre>
          <footer>
            <span>
              {tab !== "Response"
                ? "Copy this example into your project"
                : exchange === null
                  ? "Nothing has been sent yet."
                  : `rows read ${exchange.rowsRead ?? "not reported"} · bookmark ${exchange.bookmark === null ? "none" : "present"}`}
            </span>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(output)}>Copy</button>
          </footer>
        </div>
      </section>
    </ExpansionShell>
  );
}
