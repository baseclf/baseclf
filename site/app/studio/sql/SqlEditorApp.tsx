"use client";

import { mockSqlHistory, mockSqlResults } from "../../lib/mock-data";
import ComingSoon from "../expansion/ComingSoon";
import ExpansionShell from "../expansion/ExpansionShell";

/**
 * A Coming-soon preview, frozen on its first saved query. When this opens for
 * real it rides the D1 REST API with the operator's own Cloudflare credential,
 * the same lane the CLI uses — never the Worker, which only ever accepts
 * structured queries. That lane goes around the policy engine, and the real
 * screen will say so on every query; the banner says it already.
 */
export default function SqlEditorApp() {
  const query = mockSqlHistory[0].query;
  return <ExpansionShell active="SQL Editor" title="SQL Editor" eyebrow="field-notes / D1 database">
    <div className="suite-heading"><div><span className="expansion-kicker">Query without leaving your project</span><h2>Ask the database directly. See the answer clearly.</h2><p>Write SQL, review the execution boundary, and inspect fixture results before connecting a real D1 database.</p></div><span className="suite-note"><b>Preview mode</b> Queries and results are mock data.</span></div>
    <ComingSoon surface="The SQL editor" note="The real path is the D1 REST API with your own Cloudflare credential — and because that lane bypasses policies, the open screen will carry a bypass label on every query.">
    <section className="sql-workbench">
      <aside className="sql-history"><header><span>Saved & recent</span><button type="button">＋ New</button></header>{mockSqlHistory.map((item, index) => <button className={index === 0 ? "is-selected" : ""} key={item.name} type="button"><strong>{item.name}</strong><small>{item.rows} rows · {item.duration}</small></button>)}</aside>
      <div className="sql-main"><header><div><span className="sql-status"><i /> Connected to mock production</span><code>launch-notes-prod</code></div><div><button type="button">Format</button><button type="button">Run query ↗</button></div></header><div className="sql-editor"><ol>{Array.from({ length: Math.max(query.split("\n").length, 6) }, (_, index) => <li key={index}>{index + 1}</li>)}</ol><textarea aria-label="SQL query" spellCheck={false} value={query} readOnly /></div><aside className="sql-safety"><span>READ QUERY</span><p>No schema or data changes detected. Mutating statements will require a separate confirmation.</p></aside>
        <div className="sql-results"><header><div><button type="button" className="is-selected">Results</button><button type="button">Explain</button></div><span>3 fixture rows · 38 ms</span></header><div className="data-table"><div className="data-row data-head"><span>id</span><span>title</span><span>status</span><span>updated_at</span></div>{mockSqlResults.map((row) => <div className="data-row" key={row.id}><code>{row.id}</code><strong>{row.title}</strong><span className="state-positive">{row.status}</span><code>{row.updated_at}</code></div>)}</div></div>
      </div>
    </section></ComingSoon>
  </ExpansionShell>;
}
