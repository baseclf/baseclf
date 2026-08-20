"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { mockProvisioningSteps } from "../../lib/mock-data";
import ExpansionShell from "../expansion/ExpansionShell";

export default function ProvisioningApp() {
  const [completed, setCompleted] = useState(6);
  const router = useRouter();
  const finished = completed >= mockProvisioningSteps.length;
  return <ExpansionShell active="Provisioning" title="Preparing field-notes" eyebrow="Workspace / setup">
    <section className="provision-layout">
      <div className="provision-main"><span className="expansion-kicker">One-time setup</span><h2>{finished ? "Your backend is ready." : "Building inside your Cloudflare account."}</h2><p>{finished ? "Every mock check completed successfully. Continue to the overview to finish the provider setup." : "You can leave this page. Completed steps remain completed if one service needs a retry."}</p><div className="progress-track" aria-label={`${completed} of ${mockProvisioningSteps.length} steps complete`}><i style={{ width: `${(completed / mockProvisioningSteps.length) * 100}%` }} /></div><strong className="progress-copy">{completed} / {mockProvisioningSteps.length} steps complete</strong>
        <div className="provision-steps">{mockProvisioningSteps.map((step, index) => { const state = index < completed ? "complete" : index === completed ? "working" : "waiting"; return <article key={step.label} className={state}><span>{state === "complete" ? "✓" : state === "working" ? "···" : index + 1}</span><p><strong>{step.label}</strong><small>{step.detail}</small></p><b>{state === "complete" ? "Done" : state === "working" ? "Working" : "Waiting"}</b></article>; })}</div>
      </div>
      <aside className="provision-summary"><span className="expansion-kicker">Project receipt</span><h3>field-notes</h3><dl><div><dt>Account</dt><dd>Maya’s Cloudflare</dd></div><div><dt>Database</dt><dd>Cloudflare D1</dd></div><div><dt>Storage</dt><dd>Cloudflare R2</dd></div><div><dt>Access</dt><dd>Private by default</dd></div></dl>{finished ? <><div className="endpoint-receipt"><span>Project URL</span><code>https://field-notes.baseclf.workers.dev</code></div><button type="button" onClick={() => router.push("/studio/overview")}>Open project overview →</button></> : <button type="button" onClick={() => setCompleted((value) => Math.min(mockProvisioningSteps.length, value + 1))}>Advance mock step</button>}<small>Preview only · no resource is being created</small></aside>
    </section>
  </ExpansionShell>;
}
