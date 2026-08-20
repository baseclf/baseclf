"use client";

import { useState } from "react";
import { mockEnvironments, mockProject, mockSecrets } from "../../lib/mock-data";
import ExpansionShell from "../expansion/ExpansionShell";

type SettingsTab = "General" | "Environments" | "Secrets";

export default function SettingsApp() {
  const [tab, setTab] = useState<SettingsTab>("General");
  const [secretOpen, setSecretOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const announce = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(""), 2400); };
  return <ExpansionShell active="Settings" title="Project Settings" eyebrow="field-notes / configuration">
    <div className="settings-heading"><div><span className="expansion-kicker">Project configuration</span><h2>Change the project without exposing its secrets.</h2><p>General details, environments, and encrypted values stay separated so the dangerous parts are obvious.</p></div><span className="settings-boundary">Mock settings · no Cloudflare configuration changes</span></div>
    <div className="settings-tabs" role="tablist">{(["General", "Environments", "Secrets"] as SettingsTab[]).map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? "is-selected" : ""} type="button" onClick={() => setTab(item)}>{item}</button>)}</div>
    {tab === "General" ? <GeneralSettings announce={announce} /> : tab === "Environments" ? <EnvironmentSettings /> : <SecretSettings onAdd={() => setSecretOpen(true)} />}
    {secretOpen && <div className="expansion-modal-backdrop" role="button" tabIndex={0} aria-label="Close secret dialog" onMouseDown={(event) => { if (event.target === event.currentTarget) setSecretOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") setSecretOpen(false); }}><form className="expansion-dialog" onSubmit={(event) => { event.preventDefault(); setSecretOpen(false); announce("Mock secret saved. Its value can no longer be viewed."); }}><span className="expansion-kicker">Encrypted value</span><h3>Add a secret</h3><p>The value is accepted once and never displayed again in this interface.</p><label>Name<input defaultValue="EMAIL_API_TOKEN" /></label><label>Value<input type="password" placeholder="Paste secret value" /></label><label>Environment<select><option>Production</option><option>Preview</option></select></label><div><button type="button" onClick={() => setSecretOpen(false)}>Cancel</button><button type="submit">Save secret</button></div></form></div>}
    {notice && <div className="expansion-toast" role="status"><i />{notice}</div>}
  </ExpansionShell>;
}

function GeneralSettings({ announce }: { announce: (message: string) => void }) {
  return <div className="settings-grid"><section className="settings-card"><header><div><h3>Project details</h3><p>Names shown in Studio and generated examples.</p></div></header><div className="settings-form"><label>Project name<input defaultValue="field-notes" /></label><label>Production endpoint<input value="https://field-notes.baseclf.workers.dev" readOnly /></label><label>Database name<input value={mockProject.database} readOnly /></label></div><footer><button type="button" onClick={() => announce("Mock project details saved.")}>Save changes</button></footer></section><section className="settings-card"><header><div><h3>Default security</h3><p>Safe defaults for newly exposed tables and routes.</p></div></header><div className="toggle-list"><label><span><strong>Deny without a policy</strong><small>New tables start private.</small></span><input aria-label="Deny without a policy" type="checkbox" defaultChecked /></label><label><span><strong>Require authenticated writes</strong><small>Anonymous mutation requests are blocked.</small></span><input aria-label="Require authenticated writes" type="checkbox" defaultChecked /></label><label><span><strong>Record policy decisions</strong><small>Add mock policy traces to Request Logs.</small></span><input aria-label="Record policy decisions" type="checkbox" defaultChecked /></label></div></section><section className="settings-card danger-zone"><header><div><h3>Danger zone</h3><p>Actions here require explicit confirmation.</p></div></header><div><span><strong>Disconnect Studio</strong><small>Remove the admin token from this browser.</small></span><button type="button">Disconnect</button></div><div><span><strong>Delete project</strong><small>This preview cannot delete a Cloudflare resource.</small></span><button type="button">Delete project</button></div></section></div>;
}

function EnvironmentSettings() {
  return <section className="settings-card environment-card"><header><div><h3>Environments</h3><p>Keep preview and production configuration isolated.</p></div><button type="button">New environment</button></header><div className="environment-table"><div className="environment-head"><span>Environment</span><span>Worker</span><span>Branch</span><span>Status</span></div>{mockEnvironments.map((environment) => <div key={environment.name}><strong>{environment.name}</strong><code>{environment.worker}</code><code>{environment.branch}</code><span className="environment-state"><i />{environment.state}</span></div>)}</div><aside>Environment values are fixtures. BaseCLF will not duplicate production secrets into a preview environment automatically.</aside></section>;
}

function SecretSettings({ onAdd }: { onAdd: () => void }) {
  return <section className="settings-card secrets-card"><header><div><h3>Secrets</h3><p>Encrypted values used by the deployed Worker.</p></div><button type="button" onClick={onAdd}>Add secret</button></header><div className="secret-note"><strong>Values cannot be revealed after saving.</strong><span>Replace a secret to change it. Never put sensitive values in ordinary environment variables.</span></div><div className="secrets-table"><div className="secrets-head"><span>Name</span><span>Environment</span><span>Updated</span><span>Status</span><span /></div>{mockSecrets.map((secret) => <div key={secret.name}><code>{secret.name}</code><span>{secret.environment}</span><span>{secret.updated}</span><b className={`secret-state ${secret.state}`}>{secret.state}</b><button type="button">{secret.state === "missing" ? "Set" : "Replace"}</button></div>)}</div></section>;
}
