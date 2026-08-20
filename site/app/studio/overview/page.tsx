import type { Metadata } from "next";
import Link from "next/link";
import { mockActivity, mockProjectServices } from "../../lib/mock-data";
import ExpansionShell from "../expansion/ExpansionShell";
import "../expansion/expansion.css";

export const metadata: Metadata = { title: "Project overview — BaseCLF", description: "See what is ready and what to do next in BaseCLF." };

export default function OverviewPage() {
  return <ExpansionShell active="Overview" title="field-notes" eyebrow="Production / project overview">
    <div className="overview-heading"><div><span className="expansion-kicker">Your backend</span><h2>Ready to connect.</h2><p>Everything important is in one place, with the next unfinished step shown first.</p></div><div><Link className="overview-secondary" href="/docs/quickstart">Quickstart</Link><Link className="overview-primary" href="/studio/api">Try the API →</Link></div></div>
    <section className="next-step"><span>Next step</span><div><b>01</b><p><strong>Copy the Google redirect URI</strong><small>Add it to your OAuth application, then run the diagnostic.</small></p><Link href="/studio">Open Authentication →</Link></div></section>
    <div className="service-grid">{mockProjectServices.map((service) => <article key={service.name}><header><span>{service.name}</span><b className={service.state === "Ready" ? "service-ready" : "service-review"}>{service.state}</b></header><h3>{service.resource}</h3><p>{service.detail}</p><Link href={service.name === "Instant API" ? "/studio/api" : "/studio"}>Manage →</Link></article>)}</div>
    <div className="overview-lower"><section className="overview-panel"><header><span>Recent activity</span><small>Mock events</small></header>{mockActivity.map((item) => <div className="activity-row" key={item.event}><span>{item.time}</span><p><strong>{item.event}</strong><small>{item.actor}</small></p></div>)}</section><section className="overview-panel quick-actions"><header><span>Quick actions</span><small>Common tasks</small></header><Link href="/studio">Test a policy <span>→</span></Link><Link href="/studio/api">Send an API request <span>→</span></Link><Link href="/docs/policies">Read policy basics <span>→</span></Link></section></div>
  </ExpansionShell>;
}
