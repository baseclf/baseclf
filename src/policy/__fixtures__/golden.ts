/**
 * Compiled output, frozen.
 *
 * These are the exact statements the engine produces for six PostgREST
 * requests. They are checked in so that a change to the compiler has to be
 * looked at rather than discovered: any edit that alters the SQL will fail this
 * fixture and the diff is the review.
 *
 * Read them as documentation of the invariants, because that is what they are:
 *
 *   The policy and the client filter are separately parenthesised in every case
 *   that has both. That grouping is the whole of rule 00 invariant I3. Kysely
 *   emits `and` and `or` flat, so without it `policy and a or b` would parse as
 *   `(policy and a) or b` and an `or` in the query string would step outside
 *   the policy entirely.
 *
 *   Several permissive policies are OR'd inside one set of parentheses, which
 *   is how Postgres treats them.
 *
 *   Every value is a `?`. No literal appears in any statement, including the
 *   claims. The only text is identifiers and keywords.
 *
 *   A list is one parameter through json_each rather than one parameter per
 *   entry, so a long list cannot walk into D1's ceiling of a hundred.
 *
 *   Asking for a column changes which policies apply. Case three requests
 *   org_id, which read_published does not grant, so read_published is not in
 *   the predicate at all.
 */

export interface GoldenCase {
  readonly name: string;
  /** Role and uid the request runs as. */
  readonly role: string;
  readonly uid: string | null;
  /** The PostgREST query string, exactly as a client would send it. */
  readonly query: string;
  readonly sql: string;
  readonly parameters: readonly (string | number)[];
}

export const GOLDEN_CASES: readonly GoldenCase[] = Object.freeze([
  {
    name: 'anon reads published posts, filtered and ordered',
    role: 'anon',
    uid: null,
    query: 'select=id,title&status=eq.published&order=created_at.desc&limit=20',
    sql:
      'select "posts"."id", "posts"."title" from "posts" ' +
      'where ("posts"."status" = ?) and ("posts"."status" = ?) ' +
      'order by "posts"."created_at" desc limit ?',
    parameters: ['published', 'published', 20],
  },
  {
    name: 'author sees own rows through several permissive policies',
    role: 'authenticated',
    uid: 'u_ann',
    query: 'select=id,title',
    sql:
      'select "posts"."id", "posts"."title" from "posts" ' +
      'where ("posts"."status" = ? or "posts"."author_id" = ? or exists ' +
      '(select * from "org_members" where ("org_members"."org_id" = "posts"."org_id" ' +
      'and "org_members"."user_id" = ? and "org_members"."role" = ?))) limit ?',
    // u_ann appears twice: once for read_own and once for isOrgAdmin. Kysely's
    // SQLite compiler emits positional `?`, so a claim cannot be bound once and
    // reused by ordinal the way skills/policy-engine section 5 describes. The
    // hundred parameter guard still catches the case where that matters.
    parameters: ['published', 'u_ann', 'u_ann', 'admin', 100],
  },
  {
    name: 'requesting a column drops the policies that do not grant it',
    role: 'authenticated',
    uid: 'u_mod',
    query: 'select=id,org_id',
    sql:
      'select "posts"."id", "posts"."org_id" from "posts" ' +
      'where ("posts"."author_id" = ? or exists ' +
      '(select * from "org_members" where ("org_members"."org_id" = "posts"."org_id" ' +
      'and "org_members"."user_id" = ? and "org_members"."role" = ?))) limit ?',
    parameters: ['u_mod', 'u_mod', 'admin', 100],
  },
  {
    name: 'a client list goes through json_each, never expanded',
    role: 'anon',
    uid: null,
    query: 'select=id&id=in.(p1,p2,p3)',
    sql:
      'select "posts"."id" from "posts" ' +
      'where ("posts"."status" = ?) and ("posts"."id" in (select value from json_each(?))) limit ?',
    parameters: ['published', '["p1","p2","p3"]', 100],
  },
  {
    name: 'like escapes the wildcards the caller did not ask for',
    role: 'anon',
    uid: null,
    // The caller wants titles containing the literal text "50%_off". PostgREST
    // spells its wildcard `*`, so the `%` and `_` they typed are theirs.
    query: 'select=id&title=like.*50%25_off*',
    sql:
      'select "posts"."id" from "posts" ' +
      'where ("posts"."status" = ?) and ("posts"."title" like ? escape ?) limit ?',
    parameters: ['published', '%50\\%\\_off%', '\\', 100],
  },
  {
    name: 'an alias renames the output without changing what is granted',
    role: 'anon',
    uid: null,
    query: 'select=id,headline:title&order=body.asc.nullslast&offset=5',
    sql:
      'select "posts"."id", "posts"."title" as "headline" from "posts" ' +
      'where "posts"."status" = ? order by "posts"."body" asc nulls last limit ? offset ?',
    parameters: ['published', 100, 5],
  },
]);
