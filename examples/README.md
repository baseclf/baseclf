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
| `authenticated` | published rows, plus their own | new rows, and `title`, `body`, `status` on their own |

`author_id` is absent from the `update_own` columns, so a caller cannot move a row out
of their own reach by rewriting its owner. It is absent from `write_own` too, and there
it is written by the engine instead: `"set": { "author_id": "$auth.uid" }` fills it from
the verified token, so a caller cannot create a row belonging to somebody else, and
sending an `author_id` in the body changes nothing.

Nobody has a `delete` policy, and a table with no policy for an operation refuses it
rather than allowing it.

⚠️ `write_own` is here because `examples/blog` needs it: signing in only visibly
changes what you can see if you own something, and the seeded rows belong to nobody
who can sign in. Applying this document gives your deployment a write path. Remove
that policy if you did not want one.

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
