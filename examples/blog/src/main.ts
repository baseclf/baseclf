/**
 * A reader for one table, and the point is what it does not do.
 *
 * There is no filter in any request below that says "only published posts" or "only
 * mine". The same three lines run for a signed-out visitor and for a signed-in
 * author, and the two of them get different rows. The narrowing happens in the
 * engine, from policies stored beside the data, and this file cannot reach it.
 *
 * That is the whole demonstration. Everything else here is layout.
 *
 * ⚠️ Imports the design system from the repository rather than from a copy, so the
 * example consumes the file it is meant to exercise. An application outside this
 * repository would vendor theme.css or write its own.
 */

import { createClient } from 'baseclf-js';

import '../../../_design_system/theme.css';
import './app.css';

/** Whatever deployment this points at. See .env.example. */
const URL_FROM_ENV = import.meta.env['VITE_BASECLF_URL'] as string | undefined;

/**
 * ⚠️ A description of what this application expects, not a guarantee. `from<Post>()`
 * takes the type on trust, so every field here is rendered through `text()` rather
 * than used as the type says. `created_at` is written loosely for that reason: it is
 * an integer on the deployment this was built against and a string in the test
 * fixture, and the renderer should not care which.
 */
interface Post {
  readonly id: string;
  readonly title: string;
  readonly body: string | null;
  readonly status: string;
  readonly author_id: string;
  readonly created_at: string | number;
}

const mounted = document.querySelector<HTMLDivElement>('#app');
if (mounted === null) throw new Error('no #app element to render into');
const root: HTMLDivElement = mounted;

if (URL_FROM_ENV === undefined || URL_FROM_ENV === '') {
  root.innerHTML = `
    <div class="page">
      <main class="main">
        <h1>Set VITE_BASECLF_URL first</h1>
        <p class="lede">
          Copy <code>.env.example</code> to <code>.env</code> and point it at a
          deployment you created with <code>npx create-baseclf</code>.
        </p>
      </main>
    </div>`;
  throw new Error('VITE_BASECLF_URL is not set');
}

const client = createClient(URL_FROM_ENV);

/** Set just before leaving for the provider, read when the browser comes back. */
const RETURNING = 'baseclf-example-returning';

/**
 * A session the reader supplied by hand, which is the only way to see the signed-in
 * half of this example today.
 *
 * 🔴 The reason is measured, not assumed. Better Auth ends its OAuth callback with
 * `setSessionCookie` and a redirect, so the session arrives as a cookie on the
 * deployment's origin. This page is a different origin: it cannot read that cookie,
 * and BaseCLF deliberately does not send `Access-Control-Allow-Credentials`, so it
 * cannot send one either. The redirect carries no token in its URL. The bearer plugin
 * does put `set-auth-token` on the response, but a browser following a redirect never
 * gives that response to a page.
 *
 * So a cross-origin single page application cannot finish the OAuth flow yet. Paste a
 * session token here to see what a signed-in reader sees. The README says where an
 * operator gets one, and what the open decision is.
 */
const PASTED_SESSION = new URLSearchParams(window.location.hash.slice(1)).get('session');
if (PASTED_SESSION !== null) {
  client.auth.setSession(PASTED_SESSION);
  window.history.replaceState({}, '', window.location.pathname);
  sessionStorage.removeItem(RETURNING);
}

/* -------------------------------------------------------------- rendering --- */

/**
 * Escapes a database value before it goes near innerHTML.
 *
 * ⚠️ Takes `unknown` on purpose. The type argument to `from<Post>()` is a claim the
 * caller makes, not a check the client performs: SQLite hands back whatever the
 * column holds, and this example declared `created_at` a string while the table
 * stores an integer. The first render threw on `.replace is not a function`. A
 * renderer that trusted the interface would have been trusting itself.
 */
function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/**
 * A row, with the verdict it earned.
 *
 * Every post the engine returned is one the caller may read, so the badge says
 * `visible`. A draft belonging to somebody else never arrives, which is why there is
 * no `blocked` badge here: this application cannot see what it was not sent, and
 * pretending otherwise would be inventing a distinction the server refuses to make.
 */
function postCard(post: Post): string {
  const verdict = post.status === 'published' ? 'allow' : 'attention';
  const label = post.status === 'published' ? 'published' : 'draft, yours';

  return `
    <article class="panel post">
      <div class="post__head">
        <h2 class="post__title">${text(post.title)}</h2>
        <span class="verdict verdict--${verdict}">${label}</span>
      </div>
      <p class="post__meta">${text(post.author_id)} · ${text(post.created_at)}</p>
      ${post.body === null ? '' : `<p class="post__body">${text(post.body)}</p>`}
    </article>`;
}

function shell(inner: string, who: string): string {
  return `
    <div class="page">
      <header class="bar">
        <span class="bar__name">Notes</span>
        <span class="bar__who">${who}</span>
      </header>
      <main class="main">
        <p class="lede">
          Nothing in the request below asks for published posts. It asks for posts.
          The rows that come back are the rows a policy on the deployment allows this
          caller to read, and signing in changes them without changing the request.
        </p>
        ${inner}
      </main>
      <footer class="foot">
        BaseCLF enforces policies on requests through this Worker. It enforces nothing
        on <code>wrangler d1 execute</code>, which writes straight to the database.
      </footer>
    </div>`;
}

/* ------------------------------------------------------------------ load --- */

async function render(): Promise<void> {
  const session = client.auth.getSession();
  const user = session === null ? null : ((await client.auth.getUser()).data?.user ?? null);

  const who =
    user === null
      ? `<button class="btn" id="sign-in" type="button">Sign in with GitHub</button>`
      : `<span class="bar__id">${text(user.email ?? user.id)}</span>
         <button class="btn btn--ghost" id="sign-out" type="button">Sign out</button>`;

  // 🔴 The three lines the whole example exists for. No status filter, no author
  // filter, no identity in the query. Ordering is the only thing asked for.
  const { data, error } = await client
    .from<Post>('posts')
    .select('id,title,body,status,author_id,created_at')
    .order('created_at', { ascending: false });

  if (error !== null) {
    root.innerHTML = shell(
      `<div class="panel empty">
         <p>The deployment refused the request: ${text(error.message)}</p>
       </div>`,
      who,
    );
    return;
  }

  // Came back from the provider and still has nothing. Say what happened, because a
  // page that silently looks signed out after a successful sign-in is the worst
  // version of this: the reader blames their GitHub account.
  const stranded =
    user === null && sessionStorage.getItem(RETURNING) === '1'
      ? `<div class="panel empty">
           <p>GitHub signed you in and the session did not reach this page. That is
              expected today and it is not your account: the deployment sets a cookie
              on its own origin, and a page on another origin can neither read it nor
              send it. See the README for the open decision and how to paste a session
              in the meantime.</p>
         </div>`
      : '';

  const posts = data ?? [];
  const inner =
    stranded +
    (posts.length === 0
      ? `<div class="panel empty">
           <p>No posts you can read. Either there are none, or none of them are yours.
              The engine answers both the same way on purpose.</p>
         </div>`
      : `<div class="posts">${posts.map(postCard).join('')}</div>`);

  root.innerHTML = shell(inner, who);

  document.querySelector('#sign-in')?.addEventListener('click', async () => {
    const { data: started, error: failed } = await client.auth.signInWithOAuth({
      provider: 'github',
      callbackURL: window.location.origin,
    });
    if (failed !== null || started === null) return;
    // Marks that the provider is about to send the browser back here, so the page
    // can tell "returned from GitHub with nothing" apart from "never went".
    sessionStorage.setItem(RETURNING, '1');
    window.location.href = started.url;
  });

  document.querySelector('#sign-out')?.addEventListener('click', async () => {
    await client.auth.signOut();
    await render();
  });
}

await render();
