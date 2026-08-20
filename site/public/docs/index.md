# BaseCLF documentation

BaseCLF assembles authentication, D1, R2 storage, instant APIs, and row-level policies into one Cloudflare-native workflow, deployed into your own Cloudflare account.

> The commands, policy documents, and API behavior described here match the shipped engine: `create-baseclf`, `baseclf policy`, and the `baseclf-js` client are on npm. Studio screens in the preview still run on fixture data.

## Start here

- [Quickstart](./quickstart.md)
- [Policy DSL](./policies.md)
- [Compatibility](./compatibility.md)

## Boundaries

- BaseCLF runs in your Cloudflare account; it is not a hosted database service.
- Direct database access (`wrangler d1 execute`, the D1 console) bypasses the policy engine by design.
- Compatibility rows mirror the engine repository's README tables, which are maintained against its tests.
