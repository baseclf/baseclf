# BaseCLF

**Real row-level security for Cloudflare D1.**
`supabase-js` works unchanged. Runs in your own Cloudflare account.

> **Status: pre-alpha.** Reads and writes both work: policies compile into the
> query, and a write cannot move a row out of the caller's own reach.
> Authentication does not exist yet, so every request currently runs as the
> anonymous role. Nothing here is usable in production. See the roadmap below.

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
  "policies": [
    { "name": "read_published", "for": "select", "to": ["anon", "authenticated"],
      "using": { "status": { "_eq": "published" } } },

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

## Roadmap

| | |
|---|---|
| **V0** | Skeleton, D1 dialect, schema catalogue |
| **V1** | Policy engine, read path |
| **V2** | Policy engine, write path with `WITH CHECK` ← **you are here** |
| V3 | Auth: Google, GitHub, JWT |
| V4 | Storage on R2 |
| V5 | One-command deploy |
| V6 | MCP server |
| V7 | Studio, including the policy simulator |
| V8 | SDK, docs, sample application |

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
