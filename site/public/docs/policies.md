# Policy DSL

Policies are JSON documents. The engine compiles them into parameterized SQL and attaches the predicate to every request; a table with no document refuses every caller.

- `$auth.uid`: the verified user id from the JWT, bound as a SQL parameter. Absent means the `anon` role.
- `$auth.email`: the verified email, bound as a SQL parameter.
- `$auth.app.*`: server-set metadata; policies may trust it.
- `$auth.user.*`: user-editable metadata. Refused when the document is saved, because reading it in a policy would be self-service escalation.
- Operators: `_eq _neq _gt _gte _lt _lte _like _is_null _in _and _or _not _exists`. Every value is a bound parameter; `_in` compiles through `json_each` so a list costs one parameter.

A denied read simply lacks the rows. A write that matches nothing answers 404 whether the row was absent or the policy withheld it; the two cases are deliberately indistinguishable. Writes compile to single guarded statements, so there is no partial state.

D1 bills rows scanned, not rows returned: `baseclf policy lint` names unindexed policy columns and hands back the `CREATE INDEX` to paste.
