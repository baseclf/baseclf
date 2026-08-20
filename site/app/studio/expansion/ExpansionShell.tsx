"use client";

import Link from "next/link";
import { ReactNode, useState } from "react";
import ThemeToggle from "../../ThemeToggle";

const routeGroups = [
  { label: "Workspace", routes: [["Overview", "/studio/overview"], ["API Explorer", "/studio/api"], ["Request Logs", "/studio/logs"]] },
  { label: "Data", routes: [["SQL Editor", "/studio/sql"], ["Migrations", "/studio/migrations"], ["Backups", "/studio/backups"], ["Realtime", "/studio/realtime"]] },
  { label: "Compute", routes: [["Functions & Cron", "/studio/functions"], ["Webhooks & Queues", "/studio/webhooks"], ["Deployments", "/studio/deployments"]] },
  { label: "Project", routes: [["Team", "/studio/team"], ["API Keys", "/studio/api-keys"], ["Usage & Billing", "/studio/usage"], ["Settings", "/studio/settings"]] },
  { label: "Setup", routes: [["New project", "/studio/new-project"], ["Provisioning", "/studio/provisioning"]] },
] as const;

export default function ExpansionShell({ active, title, eyebrow, children }: { active: string; title: string; eyebrow: string; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ Setup: true });
  return <main className="expansion-root">
    <aside className={`expansion-sidebar ${menuOpen ? "is-open" : ""}`}>
      <Link className="expansion-brand" href="/"><span className="brand-mark" aria-hidden="true"><span /></span><strong>baseclf</strong></Link>
      <Link className="expansion-project" href="/studio/overview"><span><small>Project</small><strong>field-notes</strong></span><b>3 / 4 ready</b><i><span /></i></Link>
      <nav aria-label="Workspace navigation">{routeGroups.map((group) => <div className={`expansion-nav-group ${collapsed[group.label] ? "is-collapsed" : ""}`} key={group.label}><button className="expansion-label" type="button" aria-expanded={!collapsed[group.label]} onClick={() => setCollapsed((value) => ({ ...value, [group.label]: !value[group.label] }))}><span>{group.label}</span><i>⌄</i></button><div>{group.routes.map(([label, href]) => <Link key={href} className={active === label ? "is-current" : ""} href={href} onClick={() => setMenuOpen(false)}><i>{label.split(" ").map((word) => word[0]).join("").slice(0, 2).toUpperCase()}</i>{label}</Link>)}</div></div>)}<div className="expansion-nav-group"><span className="expansion-label plain-label">Build</span><div><Link href="/studio"><i>PS</i>Policy Studio</Link><Link href="/docs"><i>DO</i>Documentation</Link></div></div></nav>
      <div className="expansion-account"><span>MC</span><p><strong>Maya Chen</strong><small>Demo workspace</small></p></div>
    </aside>
    <section className="expansion-workspace">
      <div className="expansion-ambient" aria-hidden="true" />
      <header className="expansion-header"><button className="expansion-menu" type="button" onClick={() => setMenuOpen((value) => !value)}>Menu</button><div><span>{eyebrow}</span><h1>{title}</h1></div><div><Link className="expansion-help" href="/docs">Need help?</Link><span className="mock-badge">Mock data</span><ThemeToggle /><Link href="/studio">Policy Studio</Link></div></header>
      <div className="expansion-content">{children}</div>
      <footer className="expansion-status"><span><i /> BaseCLF preview</span><span>Fixture-backed interface</span></footer>
    </section>
  </main>;
}
