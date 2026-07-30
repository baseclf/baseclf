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

export interface GoldenWriteCase {
  readonly name: string;
  readonly operation: 'insert' | 'update' | 'delete';
  readonly role: string;
  readonly uid: string | null;
  /** Query string carrying the client filter. Empty for an insert. */
  readonly query: string;
  readonly body: Readonly<Record<string, unknown>> | null;
  /** True when the fixture's owner-writable policy set is in force. */
  readonly ownerWritable: boolean;
  readonly sql: string;
  readonly parameters: readonly (string | number | null)[];
}

/**
 * The write path, frozen.
 *
 * Read the first and last entries together, because the difference between them
 * is the whole of V2.
 *
 * In both, USING appears as `"posts"."author_id" = ?`: is this row yours right
 * now. In the first, CHECK appears identically, because the update does not
 * touch author_id and a column that is not written has itself as its post-image.
 * In the last, author_id is something the caller may write, and CHECK has become
 * `? = ?`: the value being written, against the caller. Which is to say the
 * check stopped being about the stored row and started being about the row that
 * would exist afterwards, without anything else in the statement changing.
 *
 * That is what makes handing a row to somebody else impossible rather than
 * merely unimplemented, and it is why the parameters of the last case read
 * u_ann, u_bob, u_ann: yours now, theirs after, and you.
 */
export const GOLDEN_WRITE_CASES: readonly GoldenWriteCase[] = Object.freeze([
  {
    name: 'an update that does not touch the owner checks the column against itself',
    operation: 'update',
    role: 'authenticated',
    uid: 'u_ann',
    query: 'id=eq.p2',
    body: { title: 'renamed' },
    ownerWritable: false,
    sql:
      'update "posts" set "title" = ? ' +
      'where (("posts"."author_id" = ?) and ("posts"."author_id" = ?)) ' +
      'and ("posts"."id" = ?) returning "id", "title"',
    parameters: ['renamed', 'u_ann', 'u_ann', 'p2'],
  },
  {
    name: 'a delete carries the using clause and nothing else',
    operation: 'delete',
    role: 'authenticated',
    uid: 'u_ann',
    query: 'id=eq.p2',
    body: null,
    ownerWritable: false,
    // No check: there is no row afterwards for one to be about.
    sql: 'delete from "posts" where ("posts"."author_id" = ?) and ("posts"."id" = ?) returning "id"',
    parameters: ['u_ann', 'p2'],
  },
  {
    name: 'an insert is guarded, and the owner comes from the token',
    operation: 'insert',
    role: 'authenticated',
    uid: 'u_ann',
    query: '',
    // No author_id here. The policy sets it, and a body that carried one would
    // have been ignored rather than used.
    body: {
      id: 'p_new',
      title: 'Mine',
      body: null,
      status: 'draft',
      org_id: 'org_1',
      created_at: '2026-07-31',
    },
    ownerWritable: false,
    // The select has no FROM, so it yields one row or none, and the insert
    // happens entirely or not at all. There is no moment in which the row exists
    // and is then reconsidered, which is the only shape available on a database
    // with no interactive transaction.
    sql:
      'insert into "posts" ("id", "title", "body", "status", "org_id", "created_at", "author_id") ' +
      'select ?, ?, ?, ?, ?, ?, ? where ? = ? ' +
      'returning "id", "title", "body", "status", "author_id", "org_id", "created_at"',
    parameters: ['p_new', 'Mine', null, 'draft', 'org_1', '2026-07-31', 'u_ann', 'u_ann', 'u_ann'],
  },
  {
    name: 'an update that may touch the owner checks the new value instead',
    operation: 'update',
    role: 'authenticated',
    uid: 'u_ann',
    query: 'id=eq.p2',
    body: { title: 'renamed', author_id: 'u_bob' },
    ownerWritable: true,
    sql:
      'update "posts" set "title" = ?, "author_id" = ? ' +
      'where (("posts"."author_id" = ?) and (? = ?)) ' +
      'and ("posts"."id" = ?) returning "id", "title", "author_id"',
    // renamed, the new owner, the caller, the new owner again, the caller
    // again, the id. The fourth and fifth are the check, and they do not match,
    // so RETURNING is empty and the request is a 404.
    parameters: ['renamed', 'u_bob', 'u_ann', 'u_bob', 'u_ann', 'p2'],
  },
]);
