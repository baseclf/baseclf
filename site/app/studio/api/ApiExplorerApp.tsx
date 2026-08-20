"use client";

import { useState } from "react";
import { mockApiResponse } from "../../lib/mock-data";
import ExpansionShell from "../expansion/ExpansionShell";

type ResponseTab = "Response" | "cURL" | "JavaScript";

export default function ApiExplorerApp() {
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/rest/v1/posts?select=id,title,status");
  const [tab, setTab] = useState<ResponseTab>("Response");
  const [sent, setSent] = useState(false);
  const output = tab === "Response" ? mockApiResponse : tab === "cURL" ? `curl 'https://field-notes.baseclf.workers.dev${path}' \\\n+  -H 'Authorization: Bearer mock-user-token'` : `const { data, error } = await supabase\n  .from('posts')\n  .select('id, title, status')`;
  return <ExpansionShell active="API Explorer" title="API Explorer" eyebrow="field-notes / instant API">
    <div className="api-intro"><div><span className="expansion-kicker">Safe request builder</span><h2>Try the API before writing app code.</h2><p>Choose an action, inspect the exact request, then copy the client code when it looks right.</p></div><span className="api-role"><i /> Running as authenticated user</span></div>
    <section className="api-console"><div className="api-builder"><header><span>Request</span><b>Mock endpoint</b></header><div className="request-line"><select value={method} onChange={(event) => setMethod(event.target.value)} aria-label="HTTP method"><option>GET</option><option>POST</option><option>PATCH</option><option>DELETE</option></select><input value={path} onChange={(event) => setPath(event.target.value)} aria-label="Request path" /><button type="button" onClick={() => setSent(true)}>Send request</button></div><div className="api-fields"><label>Table<select defaultValue="posts"><option>posts</option><option>profiles</option><option>comments</option></select></label><label>Return<select defaultValue="selected"><option value="selected">Selected columns</option><option>All columns</option><option>Count only</option></select></label></div><div className="request-details"><span>Headers</span><div><code>Authorization</code><code>Bearer mock-user-token</code></div><div><code>Content-Type</code><code>application/json</code></div></div><aside><strong>Policy check enabled</strong><p>The response only contains rows visible to this user.</p></aside></div>
      <div className="api-output"><header><div>{(["Response", "cURL", "JavaScript"] as ResponseTab[]).map((item) => <button key={item} className={tab === item ? "is-selected" : ""} type="button" onClick={() => setTab(item)}>{item}</button>)}</div><span>{sent ? "200 OK · 48 ms mock" : "Ready"}</span></header><pre><code>{output}</code></pre><footer><span>{tab === "Response" ? "2 visible rows · fixture response" : "Copy this example into your project"}</span><button type="button" onClick={() => navigator.clipboard?.writeText(output)}>Copy</button></footer></div>
    </section>
  </ExpansionShell>;
}
