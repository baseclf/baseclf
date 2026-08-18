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

## Two things worth copying, and one worth not

**Copy:** every value that comes out of the database is rendered through a small
escaping helper that takes `unknown`. The type argument to `from<Post>()` is a claim
the caller makes, not a check the client performs. This example declared
`created_at` a string, the column is an integer, and the first render threw. A
renderer that trusts the interface is trusting itself.

**Copy:** the sign-in flow is three steps rather than one. `signInWithOAuth` returns
a URL, the application navigates to it, and the provider sends the reader back to a
callback this client never saw. The application reads the session there and hands it
over with `setSession`.

**Do not copy:** the visual language. This uses `_design_system/theme.css` from the
repository, which is BaseCLF's own, because building it was how we found out whether
that design system works at all. It found a missing button. Your application should
look like your application.

## What it does not show

Writing. The read path is the one worth seeing first, because a policy that narrows
a read is the thing people do not believe until they watch it happen. The write path
is harder to demonstrate in a screenshot and easier to get wrong in an example.
