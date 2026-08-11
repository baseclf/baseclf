# Policy documents

Two documents, both run against a live deployment on 2026-08-12. One is accepted and
one is refused, and the refused one is here because what the engine will not store is
as much a part of the interface as what it will.

## `posts.policy.json`: accepted

Exposes a `posts` table through `baseclf policy apply`:

```bash
baseclf policy apply examples/posts.policy.json
```

It uses **binds**, which are named predicates written once and referred to by
`{"$bind": "name"}`. `isPublished` is shared by two policies and `isAuthor` by two more,
so a change to what "the author" means is a change in one place rather than four.

What it grants:

| Role | May read | May write |
|---|---|---|
| `anon` | rows whose `status` is `published` | nothing |
| `authenticated` | published rows, plus their own | `title`, `body`, `status` on their own rows |

`author_id` is absent from the `update_own` columns, so a caller cannot move a row out
of their own reach by rewriting its owner. Nobody has an `insert` or `delete` policy, and
a table with no policy for an operation refuses it rather than allowing it.

The table it expects:

```sql
CREATE TABLE posts (
  id         TEXT    NOT NULL PRIMARY KEY,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  status     TEXT    NOT NULL,
  author_id  TEXT    NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
```

Index the columns a policy names. D1 bills for rows scanned rather than rows returned,
so a policy on an unindexed column is a full scan on every request, charged every time.

## `posts.refused.policy.json`: refused, on purpose

Identical except for one bind that reads `$auth.user.id`. Applying it prints:

```
✗ That document was refused.
  Policies may not read user metadata.
```

`user_metadata` is writable by the end user, so a policy that read it would let anyone
grant themselves anything. The refusal happens while the document is being stored rather
than when it is used, and before the command asks the network for anything.

The bind in that file is **referenced by no policy**, which is the part worth noticing.
Parsing a document only exercises the binds some policy uses, so an unreferenced one
would otherwise be written unchecked and break on the day somebody referred to it, in a
deployment, pointing at a file edited weeks earlier.
