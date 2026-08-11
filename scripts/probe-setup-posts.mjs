/**
 * Create the `posts` table this run tests `baseclf policy` against.
 *
 * The rows are chosen so a policy is observable from outside: two published and two
 * drafts, split across two authors. If the policy stops filtering, the count changes.
 *
 * Every value here is a fixed literal written by the administrator. Nothing is
 * interpolated, and this is the administrative path the README is explicit about:
 * writing to D1 directly goes around the engine.
 */
import { open } from './probe-d1-rest.mjs';

const db = await open();

await db.query(`
CREATE TABLE IF NOT EXISTS posts (
  id         TEXT    NOT NULL PRIMARY KEY,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  status     TEXT    NOT NULL,
  author_id  TEXT    NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS posts_status_idx ON posts (status);
CREATE INDEX IF NOT EXISTS posts_author_idx ON posts (author_id);
INSERT OR REPLACE INTO posts (id, title, body, status, author_id, created_at) VALUES
  ('p_1', 'Published by u_1', 'anyone may read this', 'published', 'u_1', 1),
  ('p_2', 'Draft by u_1',     'only u_1 may read this', 'draft',   'u_1', 2),
  ('p_3', 'Published by u_2', 'anyone may read this', 'published', 'u_2', 3),
  ('p_4', 'Draft by u_2',     'only u_2 may read this', 'draft',   'u_2', 4);
`);

for (const row of await db.rows('SELECT id, status, author_id FROM posts ORDER BY created_at')) {
  console.log(`  ${row.id}  ${row.status.padEnd(9)}  ${row.author_id}`);
}
