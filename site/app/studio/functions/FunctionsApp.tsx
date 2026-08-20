"use client";

import { useState } from "react";
import { mockFunctions, mockSchedules } from "../../lib/mock-data";
import ExpansionShell from "../expansion/ExpansionShell";

const functionSource = `export default {
  async fetch(request, env) {
    const payload = await request.json();
    await env.EMAIL_QUEUE.send({
      userId: payload.user_id,
      template: "welcome"
    });

    return Response.json({ queued: true });
  }
};`;

export default function FunctionsApp() {
  const [selectedName, setSelectedName] = useState(mockFunctions[0].name);
  const [notice, setNotice] = useState("");
  const [showSchedule, setShowSchedule] = useState(false);
  const selected = mockFunctions.find((item) => item.name === selectedName) ?? mockFunctions[0];
  const announce = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(""), 2400); };
  return <ExpansionShell active="Functions & Cron" title="Functions & Cron" eyebrow="field-notes / compute">
    <div className="functions-heading"><div><span className="expansion-kicker">Server code without server setup</span><h2>Run app logic when a request arrives—or on a schedule.</h2><p>Keep common jobs close to your backend. BaseCLF shows the trigger, deployment state, and last result in plain language.</p></div><div><button type="button" onClick={() => setShowSchedule(true)}>New schedule</button><button type="button" onClick={() => announce("Mock function draft created.")}>New function →</button></div></div>
    <section className="functions-layout"><aside className="function-list"><header><span>Functions</span><small>{mockFunctions.length} mock items</small></header>{mockFunctions.map((item) => <button key={item.name} className={item.name === selected.name ? "is-selected" : ""} type="button" onClick={() => setSelectedName(item.name)}><span><strong>{item.name}</strong><small>{item.trigger} · {item.updated}</small></span><b className={`function-state ${item.state}`}>{item.state}</b></button>)}</aside>
      <div className="function-editor"><header><div><span className="expansion-kicker">{selected.trigger} function</span><h3>{selected.name}</h3></div><div><button type="button" onClick={() => navigator.clipboard?.writeText(selected.path)}>Copy endpoint</button><button type="button" onClick={() => announce(`${selected.name} deployed in the mock workspace.`)}>Deploy</button></div></header><div className="function-meta"><div><span>Endpoint</span><code>{selected.path}</code></div><div><span>Environment</span><strong>Production</strong></div><div><span>Status</span><strong>{selected.state}</strong></div></div><div className="code-editor"><ol>{functionSource.split("\n").map((_, index) => <li key={index}>{index + 1}</li>)}</ol><pre><code>{functionSource}</code></pre></div><footer><span>Fixture source · changes are not saved</span><button type="button" onClick={() => announce("Mock invocation completed with 202 Accepted.")}>Run test request</button></footer></div>
    </section>
    <section className="schedule-panel"><header><div><span>Schedules</span><small>Cron Triggers run in UTC</small></div><button type="button" onClick={() => setShowSchedule(true)}>Add schedule</button></header><div className="schedule-table"><div className="schedule-head"><span>When</span><span>Function</span><span>Expression</span><span>Status</span></div>{mockSchedules.map((schedule) => <div key={schedule.expression}><span><strong>{schedule.label}</strong><small>Next run is mock</small></span><code>{schedule.target}</code><code>{schedule.expression}</code><b className={`schedule-state ${schedule.state}`}>{schedule.state}</b></div>)}</div></section>
    {showSchedule && <div className="expansion-modal-backdrop" role="button" tabIndex={0} aria-label="Close schedule dialog" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSchedule(false); }} onKeyDown={(event) => { if (event.key === "Escape") setShowSchedule(false); }}><form className="expansion-dialog" onSubmit={(event) => { event.preventDefault(); setShowSchedule(false); announce("Mock schedule added."); }}><span className="expansion-kicker">Cron Trigger</span><h3>Add a schedule</h3><p>Scheduled execution uses UTC. Preview values do not modify a Worker.</p><label>Function<select defaultValue="cleanup-expired-sessions">{mockFunctions.map((item) => <option key={item.name}>{item.name}</option>)}</select></label><label>Cron expression<input defaultValue="0 3 * * *" /></label><div><button type="button" onClick={() => setShowSchedule(false)}>Cancel</button><button type="submit">Add schedule</button></div></form></div>}
    {notice && <div className="expansion-toast" role="status"><i />{notice}</div>}
  </ExpansionShell>;
}
