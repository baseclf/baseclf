# Policy DSL

BaseCLF evaluates access on every protected request and turns expressions into parameterized SQL for D1.

- `$auth.sub`: current user identifier.
- `$auth.role`: resolved request role.
- `eq`, `neq`: equality checks.
- `and`, `or`: boolean composition.

Denied reads return only visible rows. Denied mutations return an authorization error. Exact error contracts are not final.
