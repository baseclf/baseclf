# BaseCLF documentation

BaseCLF assembles authentication, D1, R2 storage, instant APIs, and row-level policies into one Cloudflare-native workflow, deployed into your own Cloudflare account.

> The commands, policy documents, and API behavior described here match the shipped engine: `create-baseclf`, `baseclf policy`, and the `baseclf-js` client are on npm. Studio opens on fixture data; connecting a deployment makes every screen read that deployment for real: Simulator, Policies, Tables, Auth, Storage, and Health. Storage shows the rules rather than the objects, because a directory belongs to a caller and Studio has no identity. Health reports the checks the deployment can run on itself; usage numbers are recorded against your Cloudflare account and are not read there.

## Start here

- [Quickstart](./quickstart.md)
- [Policy DSL](./policies.md)
- [Compatibility](./compatibility.md)

## Boundaries

- BaseCLF runs in your Cloudflare account; it is not a hosted database service.
- Direct database access (`wrangler d1 execute`, the D1 console) bypasses the policy engine by design.
- Compatibility rows mirror the engine repository's README tables, which are maintained against its tests.
