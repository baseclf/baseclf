# BaseCLF

**Real row-level security for Cloudflare D1.**
PostgREST-shaped queries, on your own Cloudflare account.

> **Status: pre-alpha.** Reads and writes both work: policies compile into the
> query, and a write cannot move a row out of the caller's own reach. Sign-in with
> Google or GitHub works, tokens are ES256, and file uploads land in R2 under a key
> the server builds rather than one the caller sends. A policy is a JSON document
> you store with one command. There is a client library in this repository, not yet
> published to npm. There is no admin UI and no migration tooling. Nothing here is
> usable in production. See the roadmap below.

> **This is not a drop-in for `supabase-js`, and an earlier version of this line
> said it was.** The query grammar is the same shape, and several things people
> reach for in that client do not exist here at all: there is no anonymous key, no
> `upsert`, no bulk insert, no relationship embeds, and fourteen PostgREST filters
> are refused because SQLite has no regular expressions, arrays or ranges. Each
> refusal names its reason. There are two lists, because they answer two
> questions: [Where BaseCLF differs from PostgREST](#where-baseclf-differs-from-postgrest)
> is about the URL grammar and applies to anything that calls the API, and
> [Where the client differs from supabase-js](#where-the-client-differs-from-supabase-js)
> is about the client in `sdk/`, which refuses the same things before sending them.

---

## Getting started

One command, against your own Cloudflare account. It creates a database, a bucket
and a Worker, deploys the engine onto them, and waits until the address answers
before telling you it is done.

Two things have to be true before that command will get anywhere. Both are one-time
and both are free.

### 1. Log in to Cloudflare

```bash
npx baseclf login
```

This wraps Cloudflare's own OAuth flow. The credential stays on your machine, and
BaseCLF has no OAuth app of its own and never sees your account.

`npx wrangler login` does the same flow and works too. The wrapper adds two things
worth having on the first run. It refuses to start when a `CLOUDFLARE_API_TOKEN` in
your shell or in a nearby `.env` would win over the login and make it do nothing,
which is otherwise silent. And it names the account you actually landed on, which the
browser flow never tells you and which decides whose bill this ends up on.

### 2. Switch on R2

R2 is off on a new Cloudflare account. Until it is switched on, the API refuses to
create a bucket and refuses even to list them, so provisioning stops at that step.

In the Cloudflare dashboard: left sidebar, **R2 Object Storage**, then the button to
enable it. The free tier covers ten gigabytes. It is a one-time thing, and the button
does not appear again afterwards.

If you skip this, `create-baseclf` stops with the same instruction and keeps
everything it has already made, so you can enable R2 and run it again.

### Then run it

```bash
npx create-baseclf
```

### What it asks

Two questions, both with a default you can accept by pressing enter.

| Question | Why it is asked |
|---|---|
| Project name | It names the database, the bucket and the Worker on your account, and every `baseclf policy` command afterwards takes it as `--project`. A name that collides takes over an existing deployment on the next run rather than making a second one. |
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

The cron trigger is the one item that can be refused without stopping the rest. Free
plans allow five per account across every Worker on it, so an account already at five
gets everything else and a note saying what is missing. The API works without it. What
does not run is the hourly sweep, so the rate limit table grows until you add one.

### Running it again

Safe, and it is the way to update a deployment. The database, the bucket and the
signing secret are kept. The secret is never regenerated, because a new one would
invalidate every session and every token already issued.

### First, a table to expose

BaseCLF governs tables. It does not create them, and there is no migration tooling
yet, so the schema is yours to make and yours to change.

Two ways, both fine:

- **The Cloudflare dashboard.** Storage and Databases, then D1, then your database,
  then the Console tab. Paste the SQL and run it. Nothing to install.
- **`wrangler d1 execute <project> --remote --file schema.sql`**, if you would rather
  stay in a terminal.

```sql
CREATE TABLE posts (
  id         TEXT    NOT NULL PRIMARY KEY,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  status     TEXT    NOT NULL,
  author_id  TEXT    NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX posts_status    ON posts(status);
CREATE INDEX posts_author_id ON posts(author_id);

INSERT INTO posts (id, title, body, status, author_id, created_at) VALUES
  ('p_1', 'Published by u_1', 'anyone may read this',   'published', 'u_1', 1),
  ('p_2', 'Draft by u_1',     'only u_1 may read this', 'draft',     'u_1', 2),
  ('p_3', 'Published by u_2', 'anyone may read this',   'published', 'u_2', 3),
  ('p_4', 'Draft by u_2',     'only u_2 may read this', 'draft',     'u_2', 4);
```

Four rows, two of them drafts. The split is what makes the next two steps show you
anything: a policy applied to an empty table returns an empty list whether it works or
not.

The two indexes are not decoration. D1 bills by rows scanned rather than rows
returned, so a policy that filters on a column with no index is a full table scan on
every request, charged every time. `baseclf policy lint` checks for exactly this and
hands back the `CREATE INDEX` to paste.

> The caveat table further down says `wrangler d1 execute` bypasses the engine, and
> it does. That is the right warning for reading and writing rows, where going around
> the policies is the whole danger. It is not a warning about `CREATE TABLE`: policies
> govern rows, not schemas, and there is nothing for them to bypass here.
>
> The four rows above are row writes, so that warning does reach them, and the answer
> is that it does not matter here rather than that it does not apply. Nothing governs
> what the owner of a database puts in it. Policies decide what a **caller** may read
> and write through the API, and seeding your own table from your own console is not
> a caller. It stops being harmless the moment your users' rows arrive the same way.

### Then expose a table

A deployment on its own exposes nothing. That is the point: a table absent from the
policy tables is a table nobody can reach, so there is no state where you forgot to
turn security on.

Write what may be read, and by whom. Save this as `posts.json`:

```json
{
  "table": "posts",
  "enabled": true,
  "policies": [
    {
      "name": "read_published",
      "for": "select",
      "to": ["anon"],
      "using": { "status": { "_eq": "published" } },
      "columns": ["id", "title", "body", "status", "author_id", "created_at"]
    }
  ]
}
```

That grants one thing to one role: a caller who is not signed in may read published
rows. Drafts are not excluded by a rule, they are simply never granted, which is the
same distinction that makes a table with no document unreachable rather than open.
`examples/posts.policy.json` in this repository carries the fuller set, including what
a signed-in caller may read and what they may write.

```bash
npx baseclf policy apply posts.json --project your-project-name
```

`--project` names the deployment, and it is the same name you gave `create-baseclf`,
which is also the name of the database. It defaults to `baseclf`, so you can leave it
off only if you accepted that default. Every `policy` command takes it.

It refuses the document before it stores anything if the policy breaks a rule: a
reference to `user_metadata`, which the end user can write, or a column that does not
exist in your schema. Both are checked by the same code the engine runs, not by a
second copy of it.

### See it working

Give it half a minute first. A deployment answers from the policies it has already
loaded and re-reads once those are about thirty seconds old, so a request sent the
instant `apply` returns can still be answered under what came before. Here that is a
table nobody had exposed yet, and the answer for one of those is a refusal, so an
early request returns `404` rather than everything. The section on changing a policy
below has the detail.

```bash
curl https://your-project.your-subdomain.workers.dev/rest/v1/posts
```

```json
[{"id":"p_1","title":"Published by u_1","body":"anyone may read this","status":"published","author_id":"u_1","created_at":1},
 {"id":"p_3","title":"Published by u_2","body":"anyone may read this","status":"published","author_id":"u_2","created_at":3}]
```

Four rows in the table, two came back, and there is no filter in the URL. The two
drafts were not left out by the query. They are outside what this caller was granted,
so there is no request they can write that reaches those rows. That is the whole
product, and it is the one thing worth checking before reading further.

Two limits on what that output proves, since it is easy to read more into it. It shows
the `anon` path only, because signing in needs an OAuth app you have not set up yet.
And it says nothing about writes: `wrangler d1 execute` and the D1 console still write
straight to the database, and always will. See the caveat table below.

To see what is exposed, and what is exposed but has no rules and therefore refuses
every request:

```bash
npx baseclf policy list --project your-project-name
```

Applying is safe to repeat and is how you change a policy. It replaces every rule on
that table. While it runs the table is not exposed at all, so an interrupted run
leaves it closed rather than half open.

### What the policy will cost to run

D1 bills for rows **scanned**, not rows returned. A policy predicate runs on every
request to that table, so a policy column with no index is not a latency problem that
shows up under load. It is a line on a bill, every request, for as long as the policy
exists.

```bash
npx baseclf policy lint --project your-project-name
```

It names the policy, says which column has no index, and gives you the statement:

```
▲ posts.update_own: "author_id" has no index, so every request that runs this
  policy scans "posts" in full. D1 bills for rows scanned.

CREATE INDEX "posts_author_id_idx" ON "posts" ("author_id");
```

The walkthrough above indexes both columns its policy touches, so you will see
nothing there. That is what a quiet linter looks like, and it is worth running once
after every policy you write rather than once at the start.

`apply` runs the same checks on the document it just stored, so you see this at the
moment you write the policy rather than on a bill later. It also warns when `_neq` is
used on a nullable column, where NULL rows are excluded rather than matched, and when
a policy is wide enough to approach the expression limit D1 refuses at.

None of it is a refusal. An index is a cost, not a permission, and the engine does not
overrule you on it. What it cannot do is run the query planner, so a policy it is quiet
about can still be slow.

To stop exposing a table and delete its rules:

```bash
npx baseclf policy rm posts --confirm --project your-project-name
```

The rules are not stored anywhere else, so keep the document that made them. Without
`--confirm` the command prints what it would delete and stops, before it asks your
account for anything.

**A change is not instant. It lands within about thirty seconds.** A deployment that
has already loaded its policies answers from what it loaded, and it re-reads once that
is half a minute old. So a change may take effect sooner, and it will not take longer.

That bound is new, and it is worth knowing what it replaced. Before it, a deployment
kept its policies until the instance happened to recycle, and nothing forced it sooner.
Measured against a live deployment twice on the same day, with nothing changed between
the runs: once a removed table was still answering anonymous requests 393 seconds after
the command reported success, and once it stopped after 57. A quiet deployment was the
slowest, because an instance with little traffic has little reason to be recycled.

Two things the bound does not give you:

- It is not fleet-wide invalidation. Every instance re-reads on its own schedule, so
  during the window some may have the change and others may not.
- It is a property of the **deployed engine**, not of the CLI. A deployment created by
  an older version of `create-baseclf` does not have it. Redeploy to get it.

If you are **narrowing** a policy, including removing one, verify from outside before
you rely on it rather than trusting the window.

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

## What is rate limited, and what is not

Counters live in D1, so every instance of your Worker shares them. Over the limit is
a `429` with a `Retry-After` header, which a client is meant to obey.

| Path | Budget | Counted against |
|---|---|---|
| Sign-in, sign-up, password and email changes | 20 a minute | the caller's address |
| Everything else under `/api/auth` | 100 a minute | the caller's address |
| Storage upload and delete | 60 a minute | the account, or the address when signed out |
| Storage download | 600 a minute | the account, or the address when signed out |
| **`/rest/v1`** | **nothing** | |

Storage counts against the account rather than the address because carrier NAT puts
thousands of unrelated people behind one address, and a budget they take from each
other is worse than no budget. The auth endpoints have no account to count against
yet, which is the whole point of them.

`/rest/v1` is deliberately not limited, and it is the line worth reading twice. The
data plane exists to be called often, and a number invented here would be one every
application built on this has to live inside. Volumetric protection for a data API
belongs in front of the Worker, where Cloudflare's own rate limiting can see it.
Storage is limited because an upload keeps costing after it returns.

None of these numbers is measured. They are set where somebody doing the thing by
hand will never meet them and a loop will, and they are not a defence against a
distributed attack.

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

## Where the client differs from supabase-js

The table above is about the URL grammar, so it applies to anything that calls the
API, `curl` included. This one is about the client in `sdk/`, for people arriving
with the other client in their fingers.

Its surface was read off this engine rather than off that client, which is why the
list is this long. A client whose most familiar calls produce requests the server
rejects is worse than no client: it turns "this product does not do that" into
"this product is broken". So the calls below either exist and behave differently,
or refuse locally with the reason, before a request goes out.

| Call | On supabase-js | Here |
|---|---|---|
| `createClient(url, anonKey)` | The second argument is an anonymous key | **There is no anonymous key anywhere in this product.** The second argument is options. Identity is a bearer JWT, and no token is the `anon` role. Prefer passing `token` as a function: tokens last fifteen minutes, so a client holding one from construction works all through development and starts failing in production for a reason nothing reports. |
| `.upsert()` | Supported | **Not here.** Nothing in the engine compiles `ON CONFLICT`. |
| `.insert([...])` with many rows | Supported | **Refused before sending**, for the reason in the table above. |
| `.rpc()` | Calls a Postgres function | **Not here.** SQLite has no stored procedures. A route in the Worker is the replacement. |
| `.or('id.eq.1,name.eq.x')` | Takes the group as a raw string | **Takes conditions as objects**, `{column, operator, value, negated}`, so an operator this backend does not have is refused while the line is being written rather than at the round trip. Flat only: the server parses a nested `or(a,and(b,c))` and the builder does not emit one. |
| `.not(column, operator, value)` | Supported | **Same shape.** On a column holding nulls it gives SQL's answer rather than the intuitive one: `NOT (col = 'x')` is null where the column is null, and a null predicate does not pass a `WHERE`, so those rows are in neither the filter nor its opposite. |
| `.textSearch()`, `.contains()`, `.overlaps()`, the range filters | Supported | **Refused by name**, fourteen of them, each carrying its own reason. |
| `.range(from, to)` | Supported | Use `.limit()` and `.offset()`. The server clamps to 1000 rather than refusing, so a larger number is not an error; it is a number that quietly does not mean what it says. |
| `.single()` | Raises unless the result is exactly one row | **Raises on more than one, and not on zero.** Zero is not an error because the engine answers "no such row" and "not yours" identically on purpose, so raising on empty would invent a distinction the server refuses to make. |
| `.maybeSingle()` | Returns null for zero rows | **Not here.** `.single()` already does this for the zero case. |
| `.select('author:users(name)')` | Embeds the related table | **Refused before sending.** |
| `.auth.signInWithOAuth()` | One call, and the library redirects | **Three steps.** It returns `{url}` and the caller navigates. The callback lands somewhere this client never sees, so the application reads the session there and hands it back with `setSession`. |
| `.auth.signInWithPassword()`, `.auth.signUp()` | On by default | **Off on most deployments, deliberately.** Hashing one password costs about 58 ms of CPU against a free plan's 10 ms per request, so it stays off unless somebody switched it on. A refusal here is usually that rather than a wrong password. |
| `.auth.getSession()` | Asks the server and returns a session object | **Returns the session token this client is holding**, without a request. |
| `.auth.onAuthStateChange()` | Supported | **Not here.** |
| `.auth.refreshSession()` | Supported | **Not here, and not needed.** `getToken()` mints a fresh fifteen-minute JWT from the session when the one it holds is close to expiring. |
| Providers | Many | **Google and GitHub.** |
| `.storage.from().upload(path, file)` | The caller chooses the path | **The caller sends a file name and the server builds the key**, from a prefix template resolved against claims it verified. So `upload` returns the key instead of accepting one, and a traversal is not expressible rather than checked for. |
| `.storage.from().list()` | Supported | **Not here.** There is no list operation on the server either, and it is the place a slightly wide prefix leaks the most at once. |
| `.createSignedUrl()`, `.getPublicUrl()` | Supported | **Not here, and this one is a decision rather than a gap.** A signed URL is a capability handed out in advance: once issued it cannot be reconsidered, and nothing about the request that redeems it reaches the policy engine. R2 egress through the Worker is free, so the proxy costs nothing the signature would save. |
| `.storage.from().remove([paths])` | Takes a list | **One file per call.** |
| The content type on an upload | | **A declaration, not an inspection.** Nothing reads the bytes to confirm it. |
| `.channel()` and realtime subscriptions | Supported | **Not here, and not planned on D1.** There is no change data capture, no logical replication and no LISTEN/NOTIFY, so there is nothing to subscribe to. Any change event would have to be produced by the Worker that made the change. |
| `.functions.invoke()` | Supported | **Not here.** Write a route in the Worker. |

One thing it has that the other client does not: it threads D1's session bookmark
through every request, so a read after a write sees that write without anybody
asking for it. Turn it off with `sessionConsistency: false`.

## Constraints worth knowing before you commit

These were measured against a real D1 database, not read from documentation.

- **100 bound parameters per statement.** Lists go through
  `IN (SELECT value FROM json_each(?1))`, which costs one.
- **No interactive transactions.** `batch()` is the only transaction primitive.
  It does roll back on failure.
- **`rows_read` counts rows scanned, not returned.** An unindexed policy column
  is a recurring bill, not a latency problem. Every response carries an
  `x-baseclf-rows-read` header so you can see it, and `baseclf policy lint` names
  the columns that will cause it.
- **10 GB per database, and Cloudflare says it cannot be raised.**
- **Double-quoted string literals are enabled.** A misspelled column returns the
  string instead of raising, so every identifier is matched against the live
  catalogue before a query is built.
- **A policy change is not instant. It lands within about thirty seconds.** Each
  Worker instance answers from the policies it has loaded and re-reads once those
  are half a minute old, so a change may take effect sooner and will not take
  longer. Widening is harmless; **narrowing is the case to be careful with**,
  because until an instance re-reads, the old and wider rule is the one being
  served. This is a bound, not fleet-wide invalidation: instances re-read on their
  own schedules, so inside the window some have the change and others do not. It is
  also a property of the deployed engine rather than of the CLI, so a deployment
  created by an older `create-baseclf` does not have it until you redeploy.
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
| **V5** | One-command deploy | shipped |
| **V6** | MCP server | five tools live on a deployment, including the policy simulator |
| V7 | Studio | |
| **V8** | SDK, docs, sample application | **client library in `sdk/`: queries, writes, sign-in and files. Packages as `baseclf-js`, not published yet** ← **you are here** |

What "shipped" means here: it runs, it has tests, and V5 was proved by
provisioning a deployment onto an empty Cloudflare account with one command and
then asking it whether it worked. It does not mean anybody other than the author
has used it.

### What the client library does and does not have

It is in `sdk/`, it publishes as `baseclf-js` under MIT rather than the engine's
Apache-2.0, and it is not on npm yet. It has `from().select()` with the ten
filters this backend can run, `not` and `or` over those same ten, `insert`,
`update`, `delete`, sign-in with a provider or a password, and uploads and
downloads. It declares no dependencies, because it imports none.

Everything it does not have, and every place it behaves differently from the
client it resembles, is in
[Where the client differs from supabase-js](#where-the-client-differs-from-supabase-js).

Its tests run against the real Worker rather than a stand-in, because the job of
a client is to emit requests the server accepts, and a test that checks a URL
against a model of the grammar only tests the model.

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
