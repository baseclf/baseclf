"use client";

import { mockProvisioningSteps } from "../../lib/mock-data";
import ComingSoon from "../expansion/ComingSoon";
import ExpansionShell from "../expansion/ExpansionShell";

const CREATE_COMMAND = "npx create-baseclf";

/**
 * A Coming-soon preview of a hosted provisioning run, frozen mid-flight. The
 * chain it illustrates is the one the CLI really runs — database, bucket,
 * Worker, secrets, address — so the banner's one live control copies that
 * command.
 */
export default function ProvisioningApp() {
  const completed = 6;
  return <ExpansionShell active="Provisioning" title="Preparing field-notes" eyebrow="Workspace / setup">
    <ComingSoon surface="Watching provisioning from the Studio" note="The real path is the CLI, whose run prints these same steps today:" action={<button type="button" onClick={() => void navigator.clipboard?.writeText(CREATE_COMMAND)}>Copy {CREATE_COMMAND}</button>}>
    <section className="provision-layout">
      <div className="provision-main"><span className="expansion-kicker">One-time setup</span><h2>Building inside your Cloudflare account.</h2><p>You can leave this page. Completed steps remain completed if one service needs a retry.</p><div className="progress-track" aria-label={`${completed} of ${mockProvisioningSteps.length} steps complete`}><i style={{ width: `${(completed / mockProvisioningSteps.length) * 100}%` }} /></div><strong className="progress-copy">{completed} / {mockProvisioningSteps.length} steps complete</strong>
        <div className="provision-steps">{mockProvisioningSteps.map((step, index) => { const state = index < completed ? "complete" : index === completed ? "working" : "waiting"; return <article key={step.label} className={state}><span>{state === "complete" ? "✓" : state === "working" ? "···" : index + 1}</span><p><strong>{step.label}</strong><small>{step.detail}</small></p><b>{state === "complete" ? "Done" : state === "working" ? "Working" : "Waiting"}</b></article>; })}</div>
      </div>
      <aside className="provision-summary"><span className="expansion-kicker">Project receipt</span><h3>field-notes</h3><dl><div><dt>Account</dt><dd>Maya’s Cloudflare</dd></div><div><dt>Database</dt><dd>Cloudflare D1</dd></div><div><dt>Storage</dt><dd>Cloudflare R2</dd></div><div><dt>Access</dt><dd>Private by default</dd></div></dl><small>Preview only · no resource is being created</small></aside>
    </section></ComingSoon>
  </ExpansionShell>;
}
