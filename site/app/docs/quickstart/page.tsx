import type { Metadata } from "next";
import DocsShell from "../DocsShell";
import CopyButton from "../CopyButton";
import "../docs.css";

export const metadata: Metadata = { title: "Quickstart — BaseCLF" };

export default function QuickstartPage() {
  const create = `npx baseclf init demo-app\ncd demo-app\nnpx baseclf dev`;
  const config = `export default defineConfig({\n  tables: { posts: { primaryKey: "id" } },\n  policies: {\n    posts_read: allow("select", ({ auth, row }) =>\n      row.status.eq("published").or(row.author_id.eq(auth.sub))\n    )\n  }\n})`;
  const request = `curl https://demo-worker.example.workers.dev/rest/v1/posts \\\n+  -H "Authorization: Bearer mock-user-token"\n\nHTTP/2 200\n[{ "id": "post_01", "title": "Launch notes" }]`;
  return <DocsShell active="Quickstart"><p className="docs-eyebrow">Guide · 5 minutes</p><h1 id="overview">Go from an empty Worker to your first protected query.</h1><p className="docs-lede">This preview flow uses mock names and endpoints. It demonstrates the intended setup order without claiming a final CLI contract.</p><div className="docs-callout"><strong>Mock values</strong><p>Replace every value beginning with <code>demo</code>, <code>mock</code>, or <code>bclf_admin_</code> when the real product exposes its contracts.</p></div><h2 id="details">1. Create a project</h2><div className="docs-code"><header><span>Terminal · Mock CLI</span><CopyButton value={create} /></header><pre><code>{create}</code></pre></div><h2>2. Define a table and policy</h2><div className="docs-code"><header><span>baseclf.config.ts · TypeScript</span><CopyButton value={config} /></header><pre><code>{config}</code></pre></div><h2>3. Verify the response</h2><div className="docs-code"><header><span>Terminal · Mock endpoint</span><CopyButton value={request} /></header><pre><code>{request}</code></pre></div><div className="docs-note" id="caveats"><p>Admin tokens belong only in local Studio or trusted server workflows. Never ship them to a browser bundle.</p></div><div className="docs-footer-nav"><a href="/docs">← Overview</a><a href="/docs/policies">Policy DSL →</a></div></DocsShell>;
}
