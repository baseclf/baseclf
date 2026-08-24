"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { type AuthUser, createClient } from "baseclf-js";
import ThemeToggle from "../ThemeToggle";

/**
 * The deployment this page talks to. Env-only on purpose: no deployment address is
 * hard-coded into the public site, and an unset value renders a setup panel rather
 * than a broken app. Point it at what `npx create-baseclf` printed.
 */
const DEPLOYMENT =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_BASECLF_URL ?? "";

/** Set just before leaving for the provider, read when the browser comes back. */
const RETURNING = "baseclf-example-returning";

/**
 * A claim about the table, not a check the client performs. `created_at` is written
 * loosely on purpose: seeded rows carry small ordering integers while drafts written
 * here carry epoch milliseconds, and the renderer must not trust either.
 */
interface Post {
  readonly id: string;
  readonly title: string;
  readonly body: string | null;
  readonly status: string;
  readonly author_id: string;
  readonly created_at: string | number;
}

type ExampleState = "signed-out" | "signed-in" | "session-missing";

function excerpt(body: string | null): string {
  if (body === null || body === "") return "This post has no body.";
  return body.length > 140 ? `${body.slice(0, 140)}…` : body;
}

function postStamp(value: string | number): string {
  const stamp = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(stamp) || stamp < 1_000_000_000) return `#${String(value)}`;
  const date = new Date(stamp > 1_000_000_000_000 ? stamp : stamp * 1000);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function ExampleApp() {
  const client = useMemo(() => (DEPLOYMENT === "" ? null : createClient(DEPLOYMENT)), []);
  const [phase, setPhase] = useState<"loading" | "ready">("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [posts, setPosts] = useState<readonly Post[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [stranded, setStranded] = useState(false);
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    if (client === null) return;
    setPhase("loading");
    setProblem(null);

    const who =
      client.auth.getSession() === null
        ? null
        : ((await client.auth.getUser()).data?.user ?? null);
    setUser(who);

    // The three lines the page exists for. No status filter, no author filter, no
    // identity in the query: the policies on the deployment decide the rows.
    const { data, error } = await client
      .from<Post>("posts")
      .select("id,title,body,status,author_id,created_at")
      .order("created_at", { ascending: false });

    if (error !== null) {
      setProblem(error.message);
      setPosts([]);
    } else {
      setPosts(data ?? []);
    }
    setPhase("ready");
  }, [client]);

  useEffect(() => {
    if (client === null) return;
    // The deployment hands the session back in the URL fragment, the one part of a
    // URL a browser sends nowhere. Read it, clear it from history, then render.
    const handed = new URLSearchParams(window.location.hash.slice(1)).get("session");
    if (handed !== null && handed !== "") {
      client.auth.setSession(handed);
      window.history.replaceState({}, "", window.location.pathname);
      sessionStorage.removeItem(RETURNING);
    } else if (sessionStorage.getItem(RETURNING) === "1") {
      sessionStorage.removeItem(RETURNING);
      // Read from outside React, so there is nothing to compute during render: the
      // fact being recorded is that a round trip came back with no session in the
      // fragment, which only the fragment and sessionStorage can say. The rule is
      // aimed at state derived from props, and this is not that.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStranded(true);
    }
    void refresh();
  }, [client, refresh]);

  const beginSignIn = useCallback(async () => {
    if (client === null) return;
    const { data, error } = await client.auth.signInWithOAuth({
      provider: "github",
      callbackURL: `${window.location.origin}${window.location.pathname}`,
    });
    if (error !== null || data === null) {
      setProblem(error?.message ?? "The deployment accepted nothing.");
      return;
    }
    sessionStorage.setItem(RETURNING, "1");
    window.location.href = data.url;
  }, [client]);

  const signOut = useCallback(async () => {
    if (client === null) return;
    await client.auth.signOut();
    setStranded(false);
    await refresh();
  }, [client, refresh]);

  const createDraft = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (client === null) return;
      const form = event.currentTarget;
      const fields = new FormData(form);

      // No author_id. The policy's column list does not include it, so the engine
      // writes it from the verified token; sending one would change nothing.
      const { error } = await client.from("posts").insert({
        id: crypto.randomUUID(),
        title: String(fields.get("title") ?? ""),
        body: String(fields.get("body") ?? ""),
        status: "draft",
        created_at: Date.now(),
      });

      if (error !== null) {
        setNote(`Refused: ${error.message}`);
        return;
      }
      setNote("");
      form.reset();
      await refresh();
    },
    [client, refresh],
  );

  const state: ExampleState =
    user !== null ? "signed-in" : stranded ? "session-missing" : "signed-out";

  const chipAction = (item: ExampleState): (() => void) | undefined => {
    if (item === "signed-out" && user !== null) return () => void signOut();
    if (item === "signed-in" && user === null) return () => void beginSignIn();
    return undefined;
  };

  return <main className="example-root">
    <header className="example-header"><Link href="/" className="example-brand"><span className="brand-mark" aria-hidden="true"><span /></span><strong>Field notes</strong></Link><div><span className="example-mock">{client === null ? "Not connected" : "Live deployment"}</span><ThemeToggle /><a href="/docs/policies">How access works</a></div></header>
    <section className="example-state-switch" aria-label="Authentication state">{(["signed-out", "signed-in", "session-missing"] as ExampleState[]).map((item) => <button key={item} className={state === item ? "is-selected" : ""} type="button" aria-pressed={state === item} onClick={chipAction(item)} title={item === "session-missing" ? "Shown when a sign-in returns without a session" : undefined}>{item.replaceAll("-", " ")}</button>)}</section>
    <section className="example-hero"><p>BaseCLF example app</p><h1>One query. Different rows for each session.</h1><code>client.from(&quot;posts&quot;).select(&quot;*&quot;)</code></section>
    <div className="example-state-stage" key={client === null ? "unconfigured" : state}>{client === null ? <section className="session-error"><span>Not connected</span><h2>Point this page at a deployment you own.</h2><p>Set VITE_BASECLF_URL in site/.env to the address npx create-baseclf printed, then restart the dev server. The page runs one query for every visitor; the policies on the deployment decide the rows.</p><div><a href="/docs/quickstart">Read the quickstart</a></div></section> : state === "session-missing" ? <section className="session-error"><span>Session missing</span><h2>Sign-in finished, but this page did not receive a session.</h2><p>Your data query was not changed or retried with elevated access. The deployment hands the session back in the URL fragment; if it is absent, check that this origin is in the deployment&apos;s trusted origins.</p><div><button type="button" onClick={() => setStranded(false)}>Return to sign in</button><a href="/docs/quickstart">Check configuration</a></div></section> : <div className="example-layout"><section className="post-feed"><header><div><span>Visible posts</span><strong>{phase === "loading" ? "…" : String(posts.length)}</strong></div><small>The same query is filtered by policy.</small></header>{problem !== null && <article><div><span>Refused</span></div><h2>The deployment refused the request.</h2><p>{problem}</p></article>}{problem === null && phase === "loading" && <article aria-busy="true"><div><span>Loading</span></div><h2>Asking the deployment…</h2><p>The same three lines run for every visitor; only the session differs.</p></article>}{problem === null && phase === "ready" && posts.length === 0 && <article><div><span>Empty</span></div><h2>No posts you can read.</h2><p>Either there are none, or none of them are yours. The engine answers both the same way on purpose.</p></article>}{problem === null && posts.map((post) => <article key={post.id} className={post.status === "published" ? "" : "draft-post"}><div><span>{post.status === "published" ? "Published" : "Draft · yours"}</span><time>{postStamp(post.created_at)}</time></div><h2>{post.title}</h2><p>{excerpt(post.body)}</p></article>)}</section><aside className="example-account">{user === null ? <><span className="machine-label">Signed out</span><h2>See your own drafts.</h2><p>Published posts are public. Sign in to reveal only the draft rows owned by your user ID.</p><button type="button" onClick={() => void beginSignIn()}>Sign in with GitHub</button><small>No admin token is sent to this browser.</small></> : <><span className="machine-label">Signed in</span><h2>{user.name ?? user.email}</h2><p>Your drafts are part of the same query now. The published rows did not change.</p><div className="example-claim"><span>JWT claim</span><code>sub: {user.id}</code></div><form onSubmit={createDraft}><label>Draft title<input name="title" required maxLength={120} placeholder="A new field note" /></label><label>Draft body<input name="body" required maxLength={400} placeholder="Only you will see it" /></label><button type="submit">Create draft</button></form><small aria-live="polite">{note}</small><button className="sign-out" type="button" onClick={() => void signOut()}>Sign out</button></>}</aside></div>}</div>
    <footer className="example-footer"><span>{client === null ? "Reference app · Not connected to a deployment" : "Reference app · Live data from a BaseCLF deployment"}</span><a href="/studio">Inspect in Studio →</a></footer>
  </main>;
}
