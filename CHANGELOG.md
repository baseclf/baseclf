# Changelog

Notable changes to the published packages: `create-baseclf`, `baseclf` (the same
bytes under a second name, because `npx` resolves a package rather than a binary),
and `baseclf-js` (the client). All three carry the same version number.

This file starts at 0.5.0. Releases before it are in the git history and in the
commit that bumped each version; nothing was reconstructed here after the fact,
because a changelog written from memory is a claim nobody can check.

The website and Studio deploy separately from npm and are noted under their own
heading when a release changes them.

## 0.5.0

### Breaking: a storage document that does not say `enabled: true` applies as disabled

`baseclf storage apply` used to treat an absent `enabled` field as on. It now
requires the word: anything other than an explicit `true` leaves the bucket off.

The old argument was that a document written in order to grant something should
not need a line saying so. That argument was fine and still lost, because
`src/policy/parse.ts` has always read the same field on a table document the other
way, so one product had two apply paths disagreeing about one field name, and no
document said which was which. Absent now means closed on both paths.

What this does and does not touch:

- Rows already stored do not change. A bucket that is on stays on.
- Only a **new** apply of a document that omits the field changes meaning, and it
  changes toward closed.
- `apply` prints the state the bucket landed in, and no longer prints the "use it"
  addresses for a bucket that is off, so the closed default cannot pass silently.

To keep a bucket enabled, add the line:

```json
{ "bucket": "avatars", "enabled": true, "rules": [] }
```

### Added: Health reports what kind of failure, not just how many

The bridge route `GET /usage` now returns `failures`, a list of
`{ status, requests }` read from the `status` dimension of Cloudflare's
`workersInvocationsAdaptive` dataset. The Studio Health screen lists them instead
of printing one error total.

The distinction is the point: `exceededResources` means the platform killed the
request, and `scriptThrewException` means the code threw and the detail is in
`wrangler tail`. Those are two different mornings for whoever is on call.

- Status strings are shown verbatim rather than translated. The vocabulary is not
  a closed set: `exceededResources` was first observed on 2026-08-25, and filtering
  against a known list would make the next new kind arrive as silence.
- The screen states that these numbers are sampled rather than counted. The
  dataset name says "Adaptive" for a reason: measured against known request counts
  it reported 15 for 31 sent and 60 for 40 sent, so read it as an estimate.
- A deployment running an older bridge sends no `failures`. The screen says so,
  rather than implying there is nothing to look at.

### Fixed: the CLI stopped describing a line nobody wrote

`baseclf policy apply` said "The document says enabled is false" for a document
that had no `enabled` field at all, so it reported a line the author never wrote.
It now says "The document does not set enabled to true", which is true for both
the absent and the explicit case, and is the same sentence `baseclf storage apply`
prints for the same state.

### Website and Studio

Shipped separately from npm.

- The landing page CTAs point at paths that exist. "Start building" and "Create a
  project" led to a screen that opens by saying it is not in this build, while the
  real path (`npx create-baseclf`) has been on npm for some time; they now open the
  quickstart. Links into preview screens say "Preview" rather than "Open".
- Settings stopped pretending. The General tab no longer offers a toggle for
  "Deny without a policy", which is a security invariant of the engine rather than
  a setting anyone can switch off, and its inputs are read only. The Admin token
  and Secrets tabs are unchanged: they were already real surfaces.
- The docs sentence claiming usage numbers "are not read there" had been wrong
  since 2026-08-23, when Health gained a button that reads them through the local
  bridge. Corrected on the page, in its Markdown twin, and in the Studio guide bar.
