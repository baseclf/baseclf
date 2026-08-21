"use client";

import ComingSoon from "../expansion/ComingSoon";
import ExpansionShell from "../expansion/ExpansionShell";

const CREATE_COMMAND = "npx create-baseclf";

/**
 * A Coming-soon preview of a hosted create flow. The real path exists today
 * and is the CLI: the banner's one live control copies it. The local Studio
 * holds the operator's wrangler credential, so this screen can eventually
 * host the same provisioning chain the CLI runs.
 */
export default function NewProjectApp() {
  return <ExpansionShell active="New project" title="Create a project" eyebrow="Workspace / setup">
    <ComingSoon surface="Creating a project from the Studio" note="The real path is the CLI, which provisions the same resources today:" action={<button type="button" onClick={() => void navigator.clipboard?.writeText(CREATE_COMMAND)}>Copy {CREATE_COMMAND}</button>}>
    <div className="new-project-layout">
      <section className="new-project-intro"><span>Backend, already assembled</span><h2>Choose what you need. We wire the rest.</h2><p>No infrastructure vocabulary required. Start with the familiar pieces below and BaseCLF prepares them inside your Cloudflare account.</p><div className="recipe-preview"><article><span>Database</span><strong>Cloudflare D1</strong></article><article><span>Files</span><strong>Cloudflare R2</strong></article><article><span>API</span><strong>Supabase-style</strong></article><article><span>Access</span><strong>Policies on every request</strong></article></div></section>
      <form className="new-project-form"><header><h3>Your new backend</h3><p>All values shown in this preview are mock data.</p></header><label>Project name<input name="name" defaultValue="field-notes" required /></label><label>Nearest region<select name="region" defaultValue="automatic"><option value="automatic">Automatic · recommended</option><option>North America</option><option>Europe</option><option>Asia Pacific</option></select></label><div className="recipe-options"><span>Include</span><label><input type="checkbox" defaultChecked />Database <span>D1 + instant API</span></label><label><input type="checkbox" defaultChecked />Authentication <span>Google + GitHub</span></label><label><input type="checkbox" defaultChecked />File storage <span>R2 bucket</span></label></div><p className="form-boundary">Resources will belong to your Cloudflare account. BaseCLF does not retain your admin token.</p><button type="submit">Create project →</button><small>Preview action · no Cloudflare resource will be created</small></form>
    </div></ComingSoon>
  </ExpansionShell>;
}
