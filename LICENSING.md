# Licensing

BaseCLF is split across three licences. The split is deliberate and follows the
same reasoning Sentry publishes for its own projects: anything that gets bundled
into your application must be maximally permissive, and anything you merely run
can carry a stronger licence.

| Component | Licence | Why |
|---|---|---|
| **Core engine** (`src/`) | Apache-2.0 | The policy engine, the REST layer, auth, storage. This is the product and it is open source. Apache adds an express patent grant that MIT lacks. |
| **Client SDKs** (`@baseclf/js` and friends) | MIT | These are compiled into your application. Anything less permissive creates a licence-compatibility problem for your users, which is a real adoption cost for zero benefit. |
| **CLI** | Apache-2.0 | A tool you run, not a dependency you ship. |
| **MCP server** | Apache-2.0, no feature gates | No licence-key checks in publicly readable code. That model is trivially bypassed and has ended badly for everyone who tried it. |
| **Hosted control plane** | Not published | If it is ever built, its value is that we run it, not that you can read it. |

## Why not AGPL or a source-available licence

The strip-mining scenario those licences exist to prevent cannot happen here.
BaseCLF runs only on Cloudflare Workers, D1 and R2, inside your account. There is
no hyperscaler that could host it as a competing managed service, because the
only company positioned to do that is Cloudflare, and a licence would not stop
them.

Meanwhile AGPL section 13 would frighten exactly the people we want: developers
shipping a product on top of this. It would protect nothing we sell and cost us
the adoption we need.

## Contributions

Contributions are accepted under the **Developer Certificate of Origin**. Sign
off your commits:

```bash
git commit -s -m "your message"
```

There is no CLA. Apache-2.0 inbound already gives the project the headroom a CLA
would otherwise be needed for.

## Trademark

The BaseCLF name and logo are not covered by these licences. You may say your
product works with BaseCLF. Do not name a fork BaseCLF.
