"use client";

import { useMemo, useState } from "react";
import { mockRequestLogs } from "../../lib/mock-data";
import ExpansionShell from "../expansion/ExpansionShell";

type Severity = "all" | "info" | "warning" | "error";

export default function LogsApp() {
  const [severity, setSeverity] = useState<Severity>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(mockRequestLogs[0].id);
  const [live, setLive] = useState(true);
  const filtered = useMemo(() => mockRequestLogs.filter((log) => (severity === "all" || log.severity === severity) && `${log.method} ${log.path} ${log.status}`.toLowerCase().includes(query.toLowerCase())), [severity, query]);
  const selected = mockRequestLogs.find((log) => log.id === selectedId) ?? filtered[0] ?? mockRequestLogs[0];

  return <ExpansionShell active="Request Logs" title="Request Logs" eyebrow="field-notes / observability">
    <div className="logs-heading"><div><span className="expansion-kicker">Understand every request</span><h2>Find what happened without reading infrastructure logs.</h2><p>Filter requests, inspect the policy decision, and copy the exact request ID when you need a deeper trace.</p></div><button className={live ? "is-live" : ""} type="button" onClick={() => setLive((value) => !value)}><i />{live ? "Live updates on" : "Live updates off"}</button></div>
    <div className="logs-metrics"><article><span>Requests</span><strong>1,284</strong><small>Mock · last hour</small></article><article><span>Successful</span><strong>1,241</strong><small>Mock · 96.7%</small></article><article><span>Policy blocked</span><strong>31</strong><small>Mock · expected denies</small></article><article><span>Errors</span><strong>12</strong><small>Mock · needs review</small></article></div>
    <section className="logs-console"><header className="logs-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search route, method, or status" aria-label="Search request logs" /><select value={severity} onChange={(event) => setSeverity(event.target.value as Severity)} aria-label="Filter severity"><option value="all">All severity</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option></select><select aria-label="Environment"><option>Production</option><option>Preview</option></select><span>{filtered.length} mock events</span></header>
      <div className="logs-list" role="list"><div className="logs-list-head"><span>Time</span><span>Request</span><span>Status</span><span>Duration</span></div>{filtered.length ? filtered.map((log) => <button key={log.id} className={selected.id === log.id ? "is-selected" : ""} type="button" onClick={() => setSelectedId(log.id)}><time>{log.time}</time><span><b className={`method method-${log.method.toLowerCase()}`}>{log.method}</b><code>{log.path}</code></span><strong className={`http-status status-${Math.floor(log.status / 100)}`}>{log.status}</strong><small>{log.duration}</small></button>) : <div className="logs-empty"><strong>No matching requests</strong><span>Clear a filter to see the mock log stream.</span></div>}</div>
      <aside className="log-detail"><header><div><span className="expansion-kicker">Request detail</span><h3>{selected.id}</h3></div><button type="button" onClick={() => navigator.clipboard?.writeText(selected.id)}>Copy ID</button></header><div className="log-verdict"><span className={`severity-dot ${selected.severity}`} /> <strong>{selected.message}</strong><small>{selected.status >= 400 ? "Request did not change protected data." : "Request completed with policy enforcement."}</small></div><dl><div><dt>Method</dt><dd>{selected.method}</dd></div><div><dt>Route</dt><dd><code>{selected.path}</code></dd></div><div><dt>Location</dt><dd>{selected.region}</dd></div><div><dt>Role</dt><dd>{selected.role}</dd></div><div><dt>Duration</dt><dd>{selected.duration}</dd></div></dl><section><header>Policy trace</header><div><span>01</span><p><strong>Resolve session</strong><small>{selected.role}</small></p><b>Done</b></div><div><span>02</span><p><strong>Apply row policies</strong><small>{selected.status === 404 ? "no policy admitted the request, answered not found" : "read_published allowed"}</small></p><b>{selected.status === 404 ? "Blocked" : "Done"}</b></div><div><span>03</span><p><strong>Return response</strong><small>HTTP {selected.status}</small></p><b>Done</b></div></section><footer>Fixture-backed log · not Cloudflare telemetry</footer></aside>
    </section>
  </ExpansionShell>;
}
