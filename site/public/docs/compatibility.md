# Compatibility

These rows mirror the compatibility tables in the engine repository's README, which are maintained against its tests.

- supabase-js query style: supported. Same query grammar; the 14 operators SQLite cannot run are refused by name.
- Email and password auth: off by default. Hashing one password costs ~58 ms CPU against the free plan's 10 ms per request.
- OAuth providers: supported. Google and GitHub, configured per deployment.
- Realtime subscriptions: planned. No CDC on D1; change events would be produced by the Worker, not the database.
- Postgres extensions: not applicable, because D1 is SQLite-based.
- R2 object storage: supported. Proxied through the Worker; no presigned URLs by design.

The four words above carry specific meanings. Supported means it runs on the shipped engine and is covered by its tests. Off by default means it exists and works, and the default follows a measured cost rather than a missing feature. Planned is roadmap language, not an available production feature. Not applicable is a property of SQLite rather than a gap.

The README tables in the engine repository are the source of truth; they list every refused operator and every place the client differs from supabase-js.
