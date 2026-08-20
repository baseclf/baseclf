"use client";

import { useState } from "react";

type User = "maya" | "leo";

const rows = [
  { title: "Launch notes", owner: "Maya", visibleTo: ["maya"] as User[] },
  { title: "Public roadmap", owner: "Maya", visibleTo: ["maya", "leo"] as User[] },
  { title: "Team draft", owner: "Leo", visibleTo: ["leo"] as User[] },
  { title: "Private brief", owner: "Leo", visibleTo: ["leo"] as User[] },
];

export default function PolicyDemo() {
  const [user, setUser] = useState<User>("maya");
  const visibleCount = rows.filter((row) => row.visibleTo.includes(user)).length;

  return (
    <section className="policy-demo reveal" aria-labelledby="policy-demo-title">
      <div className="policy-demo-copy">
        <p className="section-index">Interactive policy preview</p>
        <h2 id="policy-demo-title">Change the user.<br />Watch access change.</h2>
        <p>Choose a person and BaseCLF immediately shows which mock rows their policy allows—before the rule reaches production.</p>
        <div className="policy-demo-switch" role="group" aria-label="Preview access as user">
          <button type="button" className={user === "maya" ? "is-active" : ""} aria-pressed={user === "maya"} onClick={() => setUser("maya")}><span>MC</span>Maya</button>
          <button type="button" className={user === "leo" ? "is-active" : ""} aria-pressed={user === "leo"} onClick={() => setUser("leo")}><span>LM</span>Leo</button>
        </div>
      </div>

      <div className="policy-demo-table">
        <header><span>Post</span><span>Owner</span><span>Access for {user === "maya" ? "Maya" : "Leo"}</span></header>
        <div className="policy-demo-rows" aria-live="polite">
          {rows.map((row) => {
            const visible = row.visibleTo.includes(user);
            return (
              <div className={visible ? "is-visible-row" : "is-blocked-row"} key={row.title}>
                <span>{row.title}</span>
                <span>{row.owner}</span>
                <b><i aria-hidden="true" />{visible ? "Visible" : "Blocked"}</b>
              </div>
            );
          })}
        </div>
        <footer><span><i /> Policy applied automatically</span><b>{visibleCount} of {rows.length} rows visible</b></footer>
      </div>
    </section>
  );
}
