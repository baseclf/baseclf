# Example: a reader for one table

The smallest thing that shows what BaseCLF does. One table, one request, and two
different answers depending on who is asking.

```ts
const { data } = await client
  .from('posts')
  .select('id,title,body,status,author_id,created_at')
  .order('created_at', { ascending: false });
```

There is no `status = published` in there, and no author id. A signed-out visitor
gets the published posts. Sign in and the same three lines also return your own
drafts. The narrowing happens in the engine, from policies stored next to the data,
and this application cannot reach it or widen it.

That is the whole demonstration. Everything else in `src/` is layout.

## Running it

You need a deployment of your own:

```bash
npx create-baseclf
```

Then expose a table on it, which the [repository quickstart](../../README.md#getting-started)
walks through. Then:

```bash
cp .env.example .env
```

Put your deployment address in `.env`, and:

```bash
npm install
npm run dev
```

## The port matters, and it is the thing that catches people

A browser sends an `Origin` header, and a BaseCLF deployment answers only origins it
was told about. That list is set when the deployment is created: `create-baseclf`
asks for your front end origin as one of its two questions, well before you have
started a dev server and learned which port it took.

This example pins **4321** in `vite.config.ts` rather than taking Vite's default of
5173, because 4321 is an origin the deployment used while writing this already knew.
Every request from 5173 failed with:

```
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

which reads like the API is down rather than like a list needing one more line.

**Whichever port you use has to be the origin your deployment knows.** Change one and
change the other.

## Signing in does not finish yet, and here is exactly why

The sign-in button starts the flow correctly and GitHub really does sign you in. The
session then does not reach this page, and that is a gap in BaseCLF rather than
anything about your account or this example.

Measured, in this order:

1. `sign-in/social` answers with a URL. That half works from any allowed origin.
2. GitHub redirects to the deployment, and Better Auth ends its callback with
   `setSessionCookie` and a redirect. The session is a **cookie on the deployment's
   origin**.
3. This page is a different origin. It cannot read that cookie.
4. It cannot send one either. BaseCLF deliberately does not return
   `Access-Control-Allow-Credentials`, because bearer tokens are the transport and
   ambient cookies are the thing that design avoids.
5. The redirect carries no token in its URL, and putting one there would write a
   session into browser history, referrer headers and every log along the way.
6. Better Auth's bearer plugin does add `set-auth-token` to the response, but a
   browser following a redirect never hands that response to a page.

So the flow needs one more decision on the server side, and it is a real decision
rather than an oversight. Until then, paste a session token into the address bar to
see the signed-in half:

```
http://localhost:4321/#session=YOUR_SESSION_TOKEN
```

An operator gets one from a sign-in made outside a browser, where the header is
readable.

**One thing this did fix.** `set-auth-token` was not in the deployment's
`Access-Control-Expose-Headers`, so even a password sign-in could not have worked
from a browser: the response arrives, the client reads the header, and the browser
hands back `null`. Rows missing, no error. It is on the list now, which needs a
redeploy of your Worker to take effect.

## Two things worth copying, and one worth not

**Copy:** every value that comes out of the database is rendered through a small
escaping helper that takes `unknown`. The type argument to `from<Post>()` is a claim
the caller makes, not a check the client performs. This example declared
`created_at` a string, the column is an integer, and the first render threw. A
renderer that trusts the interface is trusting itself.

**Copy:** the page says what happened when sign-in comes back empty, instead of
looking signed out. A reader who just authorised an application on GitHub and lands
on a signed-out page blames their account. The measured explanation costs six lines.

**Do not copy:** the visual language. This uses `_design_system/theme.css` from the
repository, which is BaseCLF's own, because building it was how we found out whether
that design system works at all. It found a missing button. Your application should
look like your application.

## What it does not show

Writing. The read path is the one worth seeing first, because a policy that narrows
a read is the thing people do not believe until they watch it happen. The write path
is harder to demonstrate in a screenshot and easier to get wrong in an example.
