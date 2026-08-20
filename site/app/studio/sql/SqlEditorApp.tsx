"use client";

import { useState } from "react";
import { mockSqlHistory, mockSqlResults } from "../../lib/mock-data";
import ExpansionShell from "../expansion/ExpansionShell";

export default function SqlEditorApp() {
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState(mockSqlHistory[0].query);
  const [resultTab, setResultTab] = useState<"Results" | "Explain">("Results");
  const [notice, setNotice] = useState("");
  const run = () => { setNotice("Mock query completed · 3 rows in 38 ms"); window.setTimeout(() => setNotice(""), 2400); };
  const choose = (index: number) => { setSelected(index); setQuery(mockSqlHistory[index].query); };
  return <ExpansionShell active="SQL Editor" title="SQL Editor" eyebrow="field-notes / D1 database">
    <div className="suite-heading"><div><span className="expansion-kicker">Query without leaving your project</span><h2>Ask the database directly. See the answer clearly.</h2><p>Write SQL, review the execution boundary, and inspect fixture results before connecting a real D1 database.</p></div><span className="suite-note"><b>Preview mode</b> Queries and results are mock data.</span></div>
    <section className="sql-workbench">
      <aside className="sql-history"><header><span>Saved & recent</span><button type="button" onClick={() => { setQuery(""); setSelected(-1); }}>＋ New</button></header>{mockSqlHistory.map((item, index) => <button className={selected === index ? "is-selected" : ""} key={item.name} type="button" onClick={() => choose(index)}><strong>{item.name}</strong><small>{item.rows} rows · {item.duration}</small></button>)}</aside>
      <div className="sql-main"><header><div><span className="sql-status"><i /> Connected to mock production</span><code>launch-notes-prod</code></div><div><button type="button" onClick={() => setQuery(mockSqlHistory[0].query)}>Format</button><button type="button" onClick={run}>Run query ↗</button></div></header><div className="sql-editor"><ol>{Array.from({ length: Math.max(query.split("\n").length, 6) }, (_, index) => <li key={index}>{index + 1}</li>)}</ol><textarea aria-label="SQL query" spellCheck={false} value={query} onChange={(event) => setQuery(event.target.value)} /></div><aside className="sql-safety"><span>READ QUERY</span><p>No schema or data changes detected. Mutating statements will require a separate confirmation.</p></aside>
        <div className="sql-results"><header><div>{(["Results", "Explain"] as const).map((tab) => <button type="button" className={resultTab === tab ? "is-selected" : ""} key={tab} onClick={() => setResultTab(tab)}>{tab}</button>)}</div><span>3 fixture rows · 38 ms</span></header>{resultTab === "Results" ? <div className="data-table"><div className="data-row data-head"><span>id</span><span>title</span><span>status</span><span>updated_at</span></div>{mockSqlResults.map((row) => <div className="data-row" key={row.id}><code>{row.id}</code><strong>{row.title}</strong><span className="state-positive">{row.status}</span><code>{row.updated_at}</code></div>)}</div> : <div className="explain-plan"><span>QUERY PLAN</span><code>SEARCH posts USING INDEX idx_posts_status (status=?)</code><code>USE TEMP B-TREE FOR ORDER BY</code><p>Fixture plan only. Connect D1 to inspect an actual query plan.</p></div>}</div>
      </div>
    </section>
    {notice && <div className="expansion-toast" role="status"><i />{notice}</div>}
  </ExpansionShell>;
}
