"use client";

import Link from "next/link";
import { ReactNode, useState } from "react";
import ThemeToggle from "../../ThemeToggle";

// Q4 verdicts, encoded in what the sidebar offers: screens with a real
// development path stay as Coming-soon previews; Team, API Keys and
// Functions are gone because they describe a product this is not — the
// deployment belongs to one Cloudflare account, the admin credential is
// MCP_TOKEN (see Settings), and app logic is the customer's own Worker.
const routeGroups = [
  { label: "Workspace", routes: [["Overview", "/studio/overview"], ["API Explorer", "/studio/api"], ["Request Logs", "/studio/logs"]] },
  { label: "Data", routes: [["SQL Editor", "/studio/sql"], ["Migrations", "/studio/migrations"], ["Backups", "/studio/backups"], ["Realtime", "/studio/realtime"]] },
  { label: "Compute", routes: [["Webhooks & Queues", "/studio/webhooks"], ["Deployments", "/studio/deployments"]] },
  { label: "Project", routes: [["Usage & Billing", "/studio/usage"], ["Settings", "/studio/settings"]] },
  { label: "Setup", routes: [["New project", "/studio/new-project"], ["Provisioning", "/studio/provisioning"]] },
] as const;

/**
 * `connection` is the host of a live deployment, when the screen inside is
 * reading from one. It only changes the labels that would otherwise lie:
 * the project name, the mock badge, the status footer, and the demo persona.
 * Absent, everything renders exactly as the demo always has.
 */
export default function ExpansionShell({ active, title, eyebrow, children, connection }: { active: string; title: string; eyebrow: string; children: ReactNode; connection?: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ Setup: true });
  return <main className="expansion-root">
    <aside className={`expansion-sidebar ${menuOpen ? "is-open" : ""}`}>
      <Link className="expansion-brand" href="/"><span className="brand-mark" aria-hidden="true"><span /></span><strong>baseclf</strong></Link>
      <Link className="expansion-project" href="/studio/overview"><span><small>Project</small><strong>{connection ?? "field-notes"}</strong></span><b>{connection === undefined ? "3 / 4 ready" : "live"}</b><i><span /></i></Link>
      <nav aria-label="Workspace navigation">{routeGroups.map((group) => <div className={`expansion-nav-group ${collapsed[group.label] ? "is-collapsed" : ""}`} key={group.label}><button className="expansion-label" type="button" aria-expanded={!collapsed[group.label]} onClick={() => setCollapsed((value) => ({ ...value, [group.label]: !value[group.label] }))}><span>{group.label}</span><i>⌄</i></button><div>{group.routes.map(([label, href]) => <Link key={href} className={active === label ? "is-current" : ""} href={href} onClick={() => setMenuOpen(false)}><i>{label.split(" ").map((word) => word[0]).join("").slice(0, 2).toUpperCase()}</i>{label}</Link>)}</div></div>)}<div className="expansion-nav-group"><span className="expansion-label plain-label">Build</span><div><Link href="/studio"><i>PS</i>Policy Studio</Link><Link href="/docs"><i>DO</i>Documentation</Link></div></div></nav>
      <div className="expansion-account">{connection === undefined ? <><span>MC</span><p><strong>Maya Chen</strong><small>Demo workspace</small></p></> : <><span>AN</span><p><strong>Anonymous reads</strong><small>No token attached</small></p></>}</div>
    </aside>
    <section className="expansion-workspace">
      <div className="expansion-ambient" aria-hidden="true" />
      <header className="expansion-header"><button className="expansion-menu" type="button" onClick={() => setMenuOpen((value) => !value)}>Menu</button><div><span>{eyebrow}</span><h1>{title}</h1></div><div><Link className="expansion-help" href="/docs">Need help?</Link><span className="mock-badge">{connection === undefined ? "Mock data" : "Live connection"}</span><ThemeToggle /><Link href="/studio">Policy Studio</Link></div></header>
      <div className="expansion-content">{children}</div>
      <footer className="expansion-status"><span><i /> BaseCLF preview</span><span>{connection === undefined ? "Fixture-backed interface" : `Connected to ${connection}`}</span></footer>
    </section>
  </main>;
}
