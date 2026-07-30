# BaseCLF

**Real row-level security for Cloudflare D1.**
`supabase-js` works unchanged. Runs in your own Cloudflare account.

> **Status: pre-alpha.** The read path works: policies compile into queries and
> `GET /rest/v1/:table` serves them. Writes and authentication do not exist yet,
> so every request currently runs as the anonymous role. Nothing here is usable
> in production. See the roadmap below.

---

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
   SET "title" = ?1, "status" = ?2
 WHERE "posts"."id" = ?3
   AND "posts"."author_id" = ?4      -- pre-image
   AND "posts"."author_id" = ?5      -- post-image, so ownership cannot be transferred
RETURNING "id", "title", "status";
```

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
| `fts` and friends | Full text search | **Refused for now.** Needs an FTS5 table, which V1 does not expose. |
| `select=*` | Every column the table has | **Every column your policies grant**, resolved when the request is built. A migration cannot widen an existing response. |
| Relationship embeds | Supported | **Not yet.** They arrive when they can be given a policy each rather than an approximation of one. |
| A column you may not read | Distinguishable from one that does not exist | **Both are 404 with the same message.** The difference would be a way to map the schema. |
| Value types | Inferred by Postgres | Bound as text and left to SQLite's column affinity, except bare `true` and `false`, which bind 1 and 0. Quote a value to keep it text. |

## Constraints worth knowing before you commit

These were measured against a real D1 database, not read from documentation.

- **100 bound parameters per statement.** Lists go through
  `IN (SELECT value FROM json_each(?1))`, which costs one.
- **No interactive transactions.** `batch()` is the only transaction primitive.
  It does roll back on failure.
- **`rows_read` counts rows scanned, not returned.** An unindexed policy column
  is a recurring bill, not a latency problem. The linter flags them.
- **10 GB per database, and Cloudflare says it cannot be raised.**
- **Double-quoted string literals are enabled.** A misspelled column returns the
  string instead of raising, so every identifier is matched against the live
  catalogue before a query is built.

## Roadmap

| | |
|---|---|
| **V0** | Skeleton, D1 dialect, schema catalogue |
| **V1** | Policy engine, read path ← **you are here** |
| V2 | Policy engine, write path with `WITH CHECK` |
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
```

Tests run in workerd, not a Node emulation. The behaviours this design depends
on, `RETURNING`, batch rollback, the parameter ceiling, do not exist in a generic
SQLite driver, so a test against a fake would prove nothing.

## Licence

Apache-2.0 for the engine, MIT for the client SDKs. See
[LICENSING.md](./LICENSING.md).
