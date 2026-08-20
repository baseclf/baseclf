"use client";

import { useRouter } from "next/navigation";
import ExpansionShell from "../expansion/ExpansionShell";

export default function NewProjectApp() {
  const router = useRouter();
  return <ExpansionShell active="New project" title="Create a project" eyebrow="Workspace / setup">
    <div className="new-project-layout">
      <section className="new-project-intro"><span>Backend, already assembled</span><h2>Choose what you need. We wire the rest.</h2><p>No infrastructure vocabulary required. Start with the familiar pieces below and BaseCLF prepares them inside your Cloudflare account.</p><div className="recipe-preview"><article><span>Database</span><strong>Cloudflare D1</strong></article><article><span>Files</span><strong>Cloudflare R2</strong></article><article><span>API</span><strong>Supabase-style</strong></article><article><span>Access</span><strong>Policies on every request</strong></article></div></section>
      <form className="new-project-form" onSubmit={(event) => { event.preventDefault(); router.push("/studio/provisioning"); }}><header><h3>Your new backend</h3><p>All values shown in this preview are mock data.</p></header><label>Project name<input name="name" defaultValue="field-notes" required /></label><label>Nearest region<select name="region" defaultValue="automatic"><option value="automatic">Automatic · recommended</option><option>North America</option><option>Europe</option><option>Asia Pacific</option></select></label><div className="recipe-options"><span>Include</span><label><input type="checkbox" defaultChecked />Database <span>D1 + instant API</span></label><label><input type="checkbox" defaultChecked />Authentication <span>Google + GitHub</span></label><label><input type="checkbox" defaultChecked />File storage <span>R2 bucket</span></label></div><p className="form-boundary">Resources will belong to your Cloudflare account. BaseCLF does not retain your admin token.</p><button type="submit">Create project →</button><small>Preview action · no Cloudflare resource will be created</small></form>
    </div>
  </ExpansionShell>;
}
