import type { Metadata } from "next";
import Link from "next/link";
import DocsShell from "./DocsShell";
import "./docs.css";

export const metadata: Metadata = { title: "Docs — BaseCLF", description: "Build a Supabase-compatible backend on Cloudflare." };

export default function DocsHome() {
  return <DocsShell active="Overview"><p className="docs-eyebrow">BaseCLF documentation</p><h1 id="overview">A backend you can understand before you ship.</h1><p className="docs-lede">BaseCLF assembles authentication, D1, R2 storage, instant APIs, and row-level policies into one Cloudflare-native workflow.</p><div className="docs-callout"><strong>Preview</strong><p>All project names, usage values, IDs, generated output, and examples shown here are mock data until product data contracts are approved.</p></div><h2 id="details">Choose your path</h2><div className="docs-table-wrap"><table className="docs-table"><thead><tr><th>Goal</th><th>Start here</th><th>What you get</th></tr></thead><tbody><tr><td>Launch a project</td><td><a href="/docs/quickstart">Quickstart →</a></td><td>Install, configure, deploy, and verify a first request.</td></tr><tr><td>Control data access</td><td><a href="/docs/policies">Policy DSL →</a></td><td>Rules, auth claims, rejection behavior, and SQL examples.</td></tr><tr><td>Check fit</td><td><a href="/docs/compatibility">Compatibility →</a></td><td>Supported features and deliberate caveats.</td></tr></tbody></table></div><h2 id="caveats">Important boundaries</h2><ul><li>BaseCLF runs in your Cloudflare account; it is not a hosted database service.</li><li>Generated examples are design fixtures, not production credentials or measured benchmarks.</li><li>Compatibility claims must be verified against working product behavior before release.</li></ul><div className="docs-footer-nav"><Link href="/">← Landing</Link><a href="/docs/quickstart">Quickstart →</a></div></DocsShell>;
}
