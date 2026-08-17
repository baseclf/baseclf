# baseclf-js

The client for a [BaseCLF](https://github.com/baseclf/baseclf) deployment: queries,
writes, sign-in and files against your own Cloudflare account.

**Status: pre-alpha.** Nothing here is usable in production.

```bash
npm install baseclf-js
```

```js
import { createClient } from 'baseclf-js';

const client = createClient('https://your-worker.workers.dev');

const { data, error } = await client.from('posts').select('*').eq('status', 'published');
```

There is no anonymous key. Identity is a bearer JWT and no token is the `anon` role,
so the query above returns whatever your policies grant an anonymous caller, which may
be nothing. Pass a token as a function rather than a string: they last fifteen minutes,
so a client holding one from construction works all through development and starts
failing in production for a reason nothing reports.

```js
const client = createClient(url, { token: () => sessionStorage.getItem('jwt') });
```

Or let it sign people in and hold the session itself:

```js
const { data } = await client.auth.signInWithOAuth({
  provider: 'github',
  callbackURL: 'https://your-app.example/callback',
});
window.location.href = data.url;
```

## What it is not

It is not a drop-in for `supabase-js`. The query grammar is the same shape, and
several things people reach for in that client do not exist on this backend at all:
no anonymous key, no `upsert`, no bulk insert, no relationship embeds, no `rpc`, no
realtime, and fourteen PostgREST filters are refused because SQLite has no regular
expressions, arrays or ranges.

Every one of those refuses locally, with its reason, before a request goes out. A
client whose most familiar calls produce requests the server rejects is worse than no
client: it turns "this product does not do that" into "this product is broken".

The full list, twenty-two rows and measured rather than remembered, is
[Where the client differs from supabase-js](https://github.com/baseclf/baseclf#where-the-client-differs-from-supabase-js).

## What it has that the other one does not

It threads D1's session bookmark through every request, so a read after a write sees
that write without anybody asking for it. Turn it off with `sessionConsistency: false`
if some other thing already guarantees ordering.

## Filters can only narrow

The engine ANDs whatever you send onto the policy predicate. There is no filter here
that widens what a caller may see, and one naming a column they may not read is a
refusal rather than a wider result. That is a property of the deployment rather than
of this package, and this package cannot change it.

## Licence

MIT. The engine it talks to is Apache-2.0.
