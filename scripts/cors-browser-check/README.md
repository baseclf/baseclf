# CORS check, in a real browser

No HTTP client enforces CORS. `curl`, `fetch` from Node, `Invoke-WebRequest`
and every test runner read the headers back correctly and then ignore them, so
a deployment whose allowlist does nothing at all passes every test that is not
a browser. This deployment did exactly that once already: 383 unit tests were
green while no origin in the world could reach it.

So this harness serves one identical page from two ports and lets Chrome
decide.

## Running it

```
node scripts/cors-browser-check/server.mjs
```

Then open both, and compare:

- <http://localhost:4321> is listed in `BETTER_AUTH_TRUSTED_ORIGINS`
- <http://localhost:4322> is deliberately not

The page is byte-for-byte the same on both, so every difference in outcome
comes from the browser applying the allowlist rather than from anything the
page did.

Edit `API` at the top of `index.html` to point at the deployment under test,
and make sure the trusted port is in that deployment's
`BETTER_AUTH_TRUSTED_ORIGINS`. Port 3000 is avoided on purpose: it is the
default in `wrangler.jsonc` and is usually already taken by something else.

## What it checks, and why each one is here

| Check | What only a browser can tell you |
|---|---|
| Simple GET | The response is readable at all |
| Preflighted GET with `Authorization` | The path every signed-in client takes, which a simple GET never exercises |
| Preflighted GET with an unlisted header | That `Access-Control-Allow-Headers` is a limit rather than a decoration. It must fail from **both** origins |
| `Retry-After` read off a 429 | Two things at once: that a refusal carries CORS headers, and that the header is exposed rather than hidden |
| A header that is not exposed reads as null | That the exposed list is a list and not everything |

From the untrusted port every one of them must be blocked, and the browser
console should say so in as many words:

```
Access to fetch at 'https://<deployment>/health' from origin
'http://localhost:4322' has been blocked by CORS policy: Response to preflight
request doesn't pass access control check: No 'Access-Control-Allow-Origin'
header is present on the requested resource.
```

## What it does not cover

It runs against one browser. Safari and Firefox agree with Chrome on the parts
of the specification used here, but that is read from the specification rather
than measured.

It also exercises the rate limiter, so running it repeatedly will spend the
credential budget for the address it runs from.
