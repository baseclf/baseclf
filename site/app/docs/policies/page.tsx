import type { Metadata } from "next";
import DocsShell from "../DocsShell";
import CopyButton from "../CopyButton";
import "../docs.css";

export const metadata: Metadata = { title: "Policy DSL — BaseCLF" };

export default function PoliciesPage() {
  const policy = `allow("select", ({ auth, row }) =>\n  row.status.eq("published")\n    .or(row.author_id.eq(auth.sub))\n)`;
  const sql = `SELECT * FROM posts\nWHERE (status = ?1 OR author_id = ?2)\nLIMIT ?3`;
  return <DocsShell active="Policy DSL"><p className="docs-eyebrow">Reference</p><h1 id="overview">Policy rules that stay close to the data.</h1><p className="docs-lede">BaseCLF evaluates access on every protected request and turns policy expressions into parameterized SQL for D1.</p><h2 id="details">Claims and operators</h2><div className="docs-table-wrap"><table className="docs-table"><thead><tr><th>Expression</th><th>Meaning</th><th>Notes</th></tr></thead><tbody><tr><td><code>$auth.sub</code></td><td>Current user identifier</td><td>Absent for anonymous requests.</td></tr><tr><td><code>$auth.role</code></td><td>Resolved request role</td><td>Common values are <code>anon</code> and <code>authenticated</code>.</td></tr><tr><td><code>eq / neq</code></td><td>Equality checks</td><td>Values are bound as SQL parameters.</td></tr><tr><td><code>and / or</code></td><td>Boolean composition</td><td>Group expressions explicitly.</td></tr></tbody></table></div><h2>Example</h2><div className="docs-code"><header><span>Policy fixture · Mock identifiers</span><CopyButton value={policy} /></header><pre><code>{policy}</code></pre></div><div className="docs-code"><header><span>Generated SQL · Parameterized</span><CopyButton value={sql} /></header><pre><code>{sql}</code></pre></div><h2 id="caveats">Rejection behavior</h2><p>A denied read returns only visible rows. A denied mutation returns an authorization error and does not write partial state. Exact error codes remain a product-contract decision.</p><div className="docs-callout"><strong>Performance</strong><p>Columns used in policy filters should be indexed. Studio surfaces a warning when a fixture policy references an unindexed column.</p></div><div className="docs-footer-nav"><a href="/docs/quickstart">← Quickstart</a><a href="/docs/compatibility">Compatibility →</a></div></DocsShell>;
}
