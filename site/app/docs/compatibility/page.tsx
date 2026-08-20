import type { Metadata } from "next";
import DocsShell from "../DocsShell";
import { mockCompatibility } from "../../lib/mock-data";
import "../docs.css";

export const metadata: Metadata = { title: "Compatibility — BaseCLF" };

export default function CompatibilityPage() {
  return <DocsShell active="Compatibility"><p className="docs-eyebrow">Reference</p><h1 id="overview">Know what carries over—and what changes.</h1><p className="docs-lede">BaseCLF aims for familiar client workflows on Cloudflare infrastructure. Compatibility is practical, not a promise that D1 behaves like Postgres.</p><h2 id="details">Capability matrix</h2><div className="docs-table-wrap"><table className="docs-table"><thead><tr><th>Capability</th><th>Status</th><th>Boundary</th></tr></thead><tbody>{mockCompatibility.map(([capability, status, boundary]) => <tr key={capability}><td>{capability}</td><td><span className={`docs-state ${status === "Supported" ? "supported" : status === "Partial" || status === "Planned" ? "partial" : "unsupported"}`}>{status}</span></td><td>{boundary}</td></tr>)}</tbody></table></div><h2 id="caveats">How to read this page</h2><ul><li><strong>Supported</strong> is a design target and must still be verified against a release build.</li><li><strong>Partial</strong> means the happy path is represented while edge cases or providers remain open.</li><li><strong>Planned</strong> is roadmap language, not an available production feature.</li></ul><div className="docs-callout"><strong>Source of truth</strong><p>This table currently contains planning content. Replace each row from a versioned compatibility record once implementation testing exists.</p></div><div className="docs-footer-nav"><a href="/docs/policies">← Policy DSL</a><a href="/studio">Open Studio →</a></div></DocsShell>;
}
