"use client";

import { useState } from "react";
import { mockProject, mockSecrets } from "../../lib/mock-data";
import ExpansionShell from "../expansion/ExpansionShell";

type SettingsTab = "General" | "Admin token" | "Secrets";

/**
 * Q4 housekeeping lives here: the Environments tab is gone (one deployment is
 * one environment; a preview is a second deployment), and the API Keys screen
 * collapsed into the Admin token section, because the product has exactly one
 * admin credential and it is the MCP_TOKEN secret. Secrets are read-only with
 * the real CLI command to change them: this page never accepts a secret value.
 */
export default function SettingsApp() {
  const [tab, setTab] = useState<SettingsTab>("General");
  const [notice, setNotice] = useState("");
  const announce = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(""), 2400); };
  return <ExpansionShell active="Settings" title="Project Settings" eyebrow="field-notes / configuration">
    <div className="settings-heading"><div><span className="expansion-kicker">Project configuration</span><h2>Change the project without exposing its secrets.</h2><p>General details, the one admin credential, and encrypted values stay separated so the dangerous parts are obvious.</p></div><span className="settings-boundary">Mock settings · no Cloudflare configuration changes</span></div>
    <div className="settings-tabs" role="tablist">{(["General", "Admin token", "Secrets"] as SettingsTab[]).map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? "is-selected" : ""} type="button" onClick={() => setTab(item)}>{item}</button>)}</div>
    {tab === "General" ? <GeneralSettings announce={announce} /> : tab === "Admin token" ? <AdminTokenSettings announce={announce} /> : <SecretSettings announce={announce} />}
    {notice && <div className="expansion-toast" role="status"><i />{notice}</div>}
  </ExpansionShell>;
}

function GeneralSettings({ announce }: { announce: (message: string) => void }) {
  return <div className="settings-grid"><section className="settings-card"><header><div><h3>Project details</h3><p>Names shown in Studio and generated examples.</p></div></header><div className="settings-form"><label>Project name<input defaultValue="field-notes" /></label><label>Production endpoint<input value="https://field-notes.baseclf.workers.dev" readOnly /></label><label>Database name<input value={mockProject.database} readOnly /></label></div><footer><button type="button" onClick={() => announce("Mock project details saved.")}>Save changes</button></footer></section><section className="settings-card"><header><div><h3>Default security</h3><p>Safe defaults for newly exposed tables and routes.</p></div></header><div className="toggle-list"><label><span><strong>Deny without a policy</strong><small>New tables start private.</small></span><input aria-label="Deny without a policy" type="checkbox" defaultChecked /></label><label><span><strong>Require authenticated writes</strong><small>Anonymous mutation requests are blocked.</small></span><input aria-label="Require authenticated writes" type="checkbox" defaultChecked /></label><label><span><strong>Record policy decisions</strong><small>Add mock policy traces to Request Logs.</small></span><input aria-label="Record policy decisions" type="checkbox" defaultChecked /></label></div></section><section className="settings-card danger-zone"><header><div><h3>Danger zone</h3><p>Actions here require explicit confirmation.</p></div></header><div><span><strong>Disconnect Studio</strong><small>Remove the admin token from this browser.</small></span><button type="button">Disconnect</button></div><div><span><strong>Delete project</strong><small>This preview cannot delete a Cloudflare resource.</small></span><button type="button">Delete project</button></div></section></div>;
}

const SET_TOKEN_COMMAND = "npx baseclf secret set MCP_TOKEN --script <project>";

/**
 * The product has one admin credential, not an API-key system: MCP_TOKEN, a
 * secret on the deployment. Ordinary clients never hold a key at all — a
 * session decides what a caller may read, and anonymous requests are the
 * public view. So this section replaces a key-management screen: it says what
 * the credential is, how to set or rotate it, and where it lives when the
 * Studio uses it.
 */
function AdminTokenSettings({ announce }: { announce: (message: string) => void }) {
  return <div className="settings-grid"><section className="settings-card"><header><div><h3>The admin token</h3><p>One credential, set as a secret on your own Worker.</p></div></header><div className="settings-form"><label>Secret name<input value="MCP_TOKEN" readOnly /></label><label>Set or rotate it<input value={SET_TOKEN_COMMAND} readOnly /></label></div><footer><button type="button" onClick={() => { void navigator.clipboard?.writeText(SET_TOKEN_COMMAND); announce("Command copied. Run it in your project folder."); }}>Copy command</button></footer></section><section className="settings-card"><header><div><h3>What it grants, and where it lives</h3><p>The boundary that replaces an API-key system.</p></div></header><div className="toggle-list"><div><span><strong>Grants the management surface</strong><small>Schema reads, policy listings, and the simulator, over /mcp.</small></span></div><div><span><strong>Never a data-plane credential</strong><small>Application reads and writes are decided by sessions and policies, not by keys.</small></span></div><div><span><strong>Stays in memory</strong><small>The Studio keeps it in the page&apos;s memory only; closing the tab forgets it. Unset, the endpoint refuses everybody.</small></span></div></div></section></div>;
}

/**
 * Read-only by decision Q5. Values never pass through this page in either
 * direction: the table reports names and states, and changing one is the
 * CLI command, copied.
 */
function SecretSettings({ announce }: { announce: (message: string) => void }) {
  return <section className="settings-card secrets-card"><header><div><h3>Secrets</h3><p>Encrypted values used by the deployed Worker.</p></div><button type="button" onClick={() => { void navigator.clipboard?.writeText("npx baseclf secret set <NAME> --script <project>"); announce("Command copied. Secrets are set from your terminal, never through this page."); }}>Copy set command</button></header><div className="secret-note"><strong>Values cannot be revealed after saving.</strong><span>Secrets are set with npx baseclf secret set &lt;NAME&gt; and never entered here. Replace a secret to change it.</span></div><div className="secrets-table"><div className="secrets-head"><span>Name</span><span>Environment</span><span>Updated</span><span>Status</span><span /></div>{mockSecrets.map((secret) => <div key={secret.name}><code>{secret.name}</code><span>{secret.environment}</span><span>{secret.updated}</span><b className={`secret-state ${secret.state}`}>{secret.state}</b><span /></div>)}</div></section>;
}
