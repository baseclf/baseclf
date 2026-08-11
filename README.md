# BaseCLF

**Real row-level security for Cloudflare D1.**
`supabase-js` works unchanged. Runs in your own Cloudflare account.

> **Status: pre-alpha.** Reads and writes both work: policies compile into the
> query, and a write cannot move a row out of the caller's own reach. Sign-in with
> Google or GitHub works, tokens are ES256, and file uploads land in R2 under a key
> the server builds rather than one the caller sends. A policy is a JSON document
> you store with one command. There is no admin UI, no client SDK and no migration
> tooling yet. Nothing here is usable in production. See the roadmap below.

---

## Getting started

One command, against your own Cloudflare account. It creates a database, a bucket
and a Worker, deploys the engine onto them, and waits until the address answers
before telling you it is done.

```bash
npx create-baseclf
```

### Two things to do first

Both are one-time and both are free. The second one is where people get stuck,
because nothing mentions it until a bucket fails to create.

**1. Log in to Cloudflare.**

```bash
npx wrangler login
```

This runs Cloudflare's own OAuth flow. The credential stays on your machine.
BaseCLF has no OAuth app of its own and never sees your account.

If you have `CLOUDFLARE_API_TOKEN` set in your shell or in a `.env` beside you, that
token wins over the login and the login has no effect. `npx baseclf login` refuses to
start rather than let that happen quietly, and tells you how to clear it.

**2. Switch on R2.**

R2 is off on a new Cloudflare account. Until it is switched on, the API refuses to
create a bucket and refuses even to list them, so provisioning stops at that step.

In the Cloudflare dashboard: left sidebar, **R2 Object Storage**, then the button to
enable it. The free tier covers ten gigabytes. It is a one-time thing, and the button
does not appear again afterwards.

If you skip this, `create-baseclf` stops with the same instruction and keeps
everything it has already made, so you can enable R2 and run it again.

### What it asks

Two questions, both with a default you can accept by pressing enter.

| Question | Why it is asked |
|---|---|
| Project name | It names the database, the bucket and the Worker on your account. A name that collides takes over an existing deployment on the next run rather than making a second one. |
| Frontend origin | Where your app runs. Without it a browser on any other origin cannot call the API at all, and the error it shows says nothing about this setting. |

The signing secret is generated, not asked for. Which OAuth provider you want is
deliberately not asked either: setting one up means leaving the terminal, and the
deployment is finished and answering before that comes up.

### What it creates

| On your account | Named |
|---|---|
| D1 database | your project name |
| R2 bucket | your project name, with `-objects` on the end |
| Worker | your project name |
| A `workers.dev` address | `<project>.<subdomain>.workers.dev` |
| A signing secret | generated, set once, never regenerated |
| An hourly cron trigger | sweeps the rate limit table and reconciles storage |

### Running it again

Safe, and it is the way to update a deployment. The database, the bucket and the
signing secret are kept. The secret is never regenerated, because a new one would
invalidate every session and every token already issued.

### Then expose a table

A deployment on its own exposes nothing. That is the point: a table absent from the
policy tables is a table nobody can reach, so there is no state where you forgot to
turn security on.

Write what may be read, and by whom:

```json
{
  "table": "posts",
  "enabled": true,
  "policies": [
    {
      "name": "read_own",
      "for": "select",
      "to": ["authenticated"],
      "using": { "author_id": { "_eq": "$auth.uid" } },
      "columns": ["id", "title", "body", "author_id"]
    }
  ]
}
```

```bash
npx baseclf policy apply posts.json
```

It refuses the document before it stores anything if the policy breaks a rule: a
reference to `user_metadata`, which the end user can write, or a column that does not
exist in your schema. Both are checked by the same code the engine runs, not by a
second copy of it.

To see what is exposed, and what is exposed but has no rules and therefore refuses
every request:

```bash
npx baseclf policy list
```

Applying is safe to repeat and is how you change a policy. It replaces every rule on
that table. While it runs the table is not exposed at all, so an interrupted run
leaves it closed rather than half open.

To stop exposing a table and delete its rules:

```bash
npx baseclf policy rm posts --confirm
```

The rules are not stored anywhere else, so keep the document that made them. Without
`--confirm` the command prints what it would delete and stops, before it asks your
account for anything.

**A change is not instant, and there is no bound on how long it takes.** A deployment
that has already loaded its policies keeps them until that instance recycles, and
nothing today forces it sooner. Measured against a live deployment twice on the same
day, with nothing changed between the runs: once a removed table was still answering
anonymous requests 393 seconds after the command reported success, and once it stopped
after 57.

The spread is the point. It is however long that instance happens to live, so no
figure here would be a limit you could plan against. If you are **narrowing** a policy,
including removing one, treat the old rules as still live and verify from outside
before you rely on it. A quiet deployment is the slowest, because an instance with
little traffic has little reason to be recycled.

### When something looks wrong

```bash
npx baseclf doctor https://your-worker.workers.dev
```

It checks that the address answers, that the engine's tables exist, that the key set
is present and reports ES256, and what the deployment thinks its CORS and provider
configuration is. A brand new address takes about half a minute before it answers,
while its certificate is issued, and `doctor` says so rather than calling it broken.

---

## What a policy looks like on the write side

```jsonc
{
  "name": "update_own", "for": "update", "to": ["authenticated"],
  "using": { "author_id": { "_eq": "$auth.uid" } },   // rows you may touch
  "check": { "author_id": { "_eq": "$auth.uid" } },   // what they may become
  "columns": ["title", "body", "status"]              // author_id is not here
}
```

`set` is the other half. A column named there is written by the server from a
verified claim, and a request body that carries it is ignored rather than
obeyed:

```jsonc
{
  "name": "insert_own", "for": "insert", "to": ["authenticated"],
  "using": true,
  "check": { "author_id": { "_eq": "$auth.uid" } },
  "columns": ["title", "body", "status"],
  "set": { "author_id": "$auth.uid" }
}
```

### Naming a condition you use more than once

The same predicate tends to appear in several policies on a table, and four copies of
what "the author" means is four places to change it and three places to get it wrong.
A `binds` block names one:

```jsonc
{
  "table": "posts",
  "enabled": true,
  "binds": {
    "isPublished": { "status": { "_eq": "published" } },
    "isAuthor": { "author_id": { "_eq": "$auth.uid" } }
  },
  "policies": [
    { "name": "read_published", "for": "select", "to": ["anon"],
      "using": { "$bind": "isPublished" },
      "columns": ["id", "title", "body", "status", "author_id"] },
    { "name": "read_own_or_published", "for": "select", "to": ["authenticated"],
      "using": { "_or": [{ "$bind": "isPublished" }, { "$bind": "isAuthor" }] },
      "columns": ["id", "title", "body", "status", "author_id"] }
  ]
}
```

A bind is a condition, not a macro. It is expanded where it is referenced, it may be
nested inside `_and` and `_or`, and a bind that refers to itself, directly or through
another bind, is refused rather than followed.

Every bind is checked when the document is stored, **including one no policy refers
to**. An unchecked bind sitting in the database is one that breaks on the day somebody
first uses it, in a deployment, pointing at a file edited weeks earlier.

The complete versions of both documents, one accepted and one refused, are in
[`examples/`](examples/), along with the table they expect. Both were run against a
live deployment.

## The problem

Cloudflare gives you every piece of infrastructure a backend needs, cheaper and
closer to the user than the alternatives. What it does not give you is the
application layer.

D1 is SQLite, and SQLite has no row-level security. So the moment you want a
browser to read from your database, you are writing authorisation logic by hand
in a Worker, on every route, forever. That is the easiest place in a codebase to
make a quiet mistake, and a quiet mistake there is a data leak.

BaseCLF is the layer that closes that gap.

## What it will do

Declare a policy once, as data:

```jsonc
{
  "table": "posts",
  "enabled": true,          // absent or false means nobody can reach it
  "policies": [
    { "name": "read_published", "for": "select", "to": ["anon", "authenticated"],
      "using": { "status": { "_eq": "published" } },
      "columns": ["id", "title", "body", "status", "author_id"] },

    { "name": "update_own", "for": "update", "to": ["authenticated"],
      "using": { "author_id": { "_eq": "$auth.uid" } },
      "check": { "author_id": { "_eq": "$auth.uid" } },
      "columns": ["title", "body", "status"] }
  ]
}
```

The engine compiles it into the query, with every value bound:

```sql
UPDATE "posts"
   SET "title" = ?
 WHERE ("posts"."author_id" = ?      -- using: the row as it is
    AND "posts"."author_id" = ?)     -- check: the row as it will be
   AND ("posts"."id" = ?)            -- what the caller asked for
RETURNING "id", "title";
```

The two `author_id` terms look the same because this update does not touch
`author_id`, so the value it will hold afterwards is the value it holds now. Put
`author_id` in the policy's `columns` and the second term compiles to `? = ?`
instead, comparing the new owner against the caller. Handing a row to somebody
else stops being possible for a structural reason rather than because a column
list happened to leave it out.

Run `npm run demo:v2` to watch that happen.

Your frontend never sees any of it:

```ts
const { data } = await baseclf.from('posts').select('*').eq('status', 'published');
```

## What BaseCLF does not enforce

This table stays on the front page on purpose. A security tool that only
advertises its strengths is not one you should trust.

| Path | Enforced? |
|---|---|
| Requests through the BaseCLF Worker | **Yes.** Every query is compiled with its policy predicate attached. |
| `wrangler d1 execute` | **No.** It talks to D1 directly and bypasses the engine entirely. |
| The Cloudflare dashboard SQL console | **No.** Same reason. |
| Any other Worker holding a `D1:Edit` token | **No.** D1 tokens are account-scoped, not per-database. |
| A migration you run yourself | **No.** Migrations are a sanctioned bypass. |

BaseCLF enforces policy at the query layer. It cannot enforce anything about a
connection it is not part of. Scope your API tokens accordingly.

## Where BaseCLF differs from PostgREST

Same query grammar, different database underneath. These are the places that
matters, and none of them is a bug we plan to fix.

| Behaviour | On PostgREST | Here |
|---|---|---|
| `like` | Case sensitive | **Case insensitive for ASCII**, because that is what SQLite's `LIKE` does. `like` and `ilike` are the same operator here. |
| `ilike` outside ASCII | Folds case | **Does not.** `'A' LIKE 'a'` is true; the same comparison on any accented, Greek or Cyrillic letter is false. Measured, not assumed. |
| `match`, `imatch` | Regular expressions | **Refused.** SQLite has no `REGEXP`. |
| `cs`, `cd`, `ov`, `sl`, `sr`, `nxr`, `nxl`, `adj` | Arrays and ranges | **Refused.** SQLite has neither type. |
| `fts` and friends | Full text search | **Refused for now.** Needs an FTS5 table, which this does not expose yet. |
| `select=*` | Every column the table has | **Every column your policies grant**, resolved when the request is built. A migration cannot widen an existing response. |
| Relationship embeds | Supported | **Not yet.** They arrive when they can be given a policy each rather than an approximation of one. |
| A column you may not read | Distinguishable from one that does not exist | **Both are 404 with the same message.** The difference would be a way to map the schema. |
| Value types | Inferred by Postgres | Bound as text and left to SQLite's column affinity, except bare `true` and `false`, which bind 1 and 0. Quote a value to keep it text. |
| Bulk insert | Supported | **Not yet.** One row per request. A bulk write cannot be made all or nothing here: each row carries its own guard, and D1 has no transaction to undo the rows that did land. |
| `Prefer: return=representation` | Returns rows subject to the SELECT policy | Returns the primary key plus the columns the write touched. SQLite's `RETURNING` takes no `WHERE`, so a read policy cannot be applied to it; rather than approximate that, the result is narrowed to what the caller already supplied. |
| Several policies on one write | `USING` clauses OR'd, `WITH CHECK` clauses OR'd separately | Each policy's `using` is paired with its own `check`, and the pairs are OR'd. A write has to be permitted end to end by one policy. Stricter, and it means a refusal can name the policy. |

## Constraints worth knowing before you commit

These were measured against a real D1 database, not read from documentation.

- **100 bound parameters per statement.** Lists go through
  `IN (SELECT value FROM json_each(?1))`, which costs one.
- **No interactive transactions.** `batch()` is the only transaction primitive.
  It does roll back on failure.
- **`rows_read` counts rows scanned, not returned.** An unindexed policy column
  is a recurring bill, not a latency problem. Every response carries an
  `x-baseclf-rows-read` header so you can see it; the linter that warns about it
  automatically is not built yet.
- **10 GB per database, and Cloudflare says it cannot be raised.**
- **Double-quoted string literals are enabled.** A misspelled column returns the
  string instead of raising, so every identifier is matched against the live
  catalogue before a query is built.
- **A policy change is not instant, and nothing bounds the delay.** Each Worker
  instance reads the policies once and keeps them until it recycles. Storing a new
  policy does not reach an instance that has already started, so an instance can go
  on answering under the previous rules. Widening is harmless; **narrowing is the
  case to be careful with**, because the old, wider rule is the one still being
  served. A fleet-wide invalidation is on the roadmap and is not built.
- **Two people applying a policy to the same table at the same time can leave the
  union of both.** Permissive policies are combined with OR, so the result is wider
  than either person wrote. The second one to finish is told its write failed, which
  is the only signal. Applying again replaces whatever is there.

## Roadmap

| | | |
|---|---|---|
| **V0** | Skeleton, D1 dialect, schema catalogue | shipped |
| **V1** | Policy engine, read path | shipped |
| **V2** | Policy engine, write path with `WITH CHECK` | shipped |
| **V3** | Auth: Google, GitHub, JWT | shipped |
| **V4** | Storage on R2 | shipped |
| **V5** | One-command deploy | shipped ← **you are here** |
| V6 | MCP server | |
| V7 | Studio, including the policy simulator | |
| V8 | SDK, docs, sample application | |

What "shipped" means here: it runs, it has tests, and V5 was proved by
provisioning a deployment onto an empty Cloudflare account with one command and
then asking it whether it worked. It does not mean anybody other than the author
has used it.

## Development

```bash
npm install
npm run check           # typecheck, lint and test
npm test                # vitest, inside workerd with a real D1 binding
npm run build           # wrangler dry run
npm run measure:bundle  # bundle cost against the Workers script limit
npm run demo:v1         # same request, two identities, two different queries
npm run demo:v2         # three updates, and why the third one does nothing
```

Tests run in workerd, not a Node emulation. The behaviours this design depends
on, `RETURNING`, batch rollback, the parameter ceiling, do not exist in a generic
SQLite driver, so a test against a fake would prove nothing.

## Licence

Apache-2.0 for the engine, MIT for the client SDKs. See
[LICENSING.md](./LICENSING.md).
