"use client";

import { useState } from "react";
import Link from "next/link";
import ThemeToggle from "../ThemeToggle";
import { mockExamplePosts } from "../lib/mock-data";

type ExampleState = "signed-out" | "signed-in" | "session-missing";

export default function ExampleApp() {
  const [state, setState] = useState<ExampleState>("signed-out");
  return <main className="example-root">
    <header className="example-header"><Link href="/" className="example-brand"><span className="brand-mark" aria-hidden="true"><span /></span><strong>Field notes</strong></Link><div><span className="example-mock">Mock state</span><ThemeToggle /><a href="/docs/policies">How access works</a></div></header>
    <section className="example-state-switch" aria-label="Example authentication state">{(["signed-out", "signed-in", "session-missing"] as ExampleState[]).map((item) => <button key={item} className={state === item ? "is-selected" : ""} type="button" onClick={() => setState(item)}>{item.replaceAll("-", " ")}</button>)}</section>
    <section className="example-hero"><p>BaseCLF example app</p><h1>One query. Different rows for each session.</h1><code>supabase.from(&quot;posts&quot;).select(&quot;*&quot;)</code></section>
    <div className="example-state-stage" key={state}>{state === "session-missing" ? <section className="session-error"><span>Session missing</span><h2>Sign-in finished, but this page did not receive a session.</h2><p>Your data query was not changed or retried with elevated access. Return to sign in, then check the callback URL and cookie configuration.</p><div><button type="button" onClick={() => setState("signed-out")}>Return to sign in</button><a href="/docs/quickstart">Check configuration</a></div></section> : <div className="example-layout"><section className="post-feed"><header><div><span>Visible posts</span><strong>{state === "signed-in" ? "3" : "2"}</strong></div><small>The same query is filtered by policy.</small></header>{mockExamplePosts.map((post) => <article key={post.id}><div><span>Published</span><time>{post.date}</time></div><h2>{post.title}</h2><p>{post.excerpt}</p><button type="button">Read note →</button></article>)}{state === "signed-in" && <article className="draft-post"><div><span>Draft · yours</span><time>Today</time></div><h2>What I learned shipping the policy simulator</h2><p>Only the signed-in owner can see this unfinished post.</p><button type="button">Continue editing →</button></article>}</section><aside className="example-account">{state === "signed-out" ? <><span className="machine-label">Signed out</span><h2>See your own drafts.</h2><p>Published posts are public. Sign in to reveal only the draft rows owned by your user ID.</p><button type="button" onClick={() => setState("signed-in")}>Sign in with GitHub</button><small>No admin token is sent to this browser.</small></> : <><span className="machine-label">Signed in</span><h2>Maya Chen</h2><p>One private draft became visible. The two published rows did not change.</p><div className="example-claim"><span>JWT claim</span><code>sub: usr_maya_chen</code></div><form><label>Draft title<input placeholder="A new field note" /></label><button type="button">Create draft</button></form><button className="sign-out" type="button" onClick={() => setState("signed-out")}>Sign out</button></>}</aside></div>}</div>
    <footer className="example-footer"><span>Reference app · All records are mock data</span><a href="/studio">Inspect in Studio →</a></footer>
  </main>;
}
