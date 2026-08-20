# Quickstart

Two one-time things first: `npx baseclf login` (the credential stays on your machine), and switch on R2 in the Cloudflare dashboard, because it is off on a new account.

```sh
npx baseclf login
npx create-baseclf
```

It asks two questions: a project name and your frontend origin. The signing secret is generated, never asked for.

A fresh deployment exposes nothing. Save a policy document and apply it:

```json
{
  "table": "posts",
  "enabled": true,
  "policies": [
    {
      "name": "read_published",
      "for": "select",
      "to": ["anon"],
      "using": { "status": { "_eq": "published" } },
      "columns": ["id", "title", "body", "status", "author_id", "created_at"]
    }
  ]
}
```

```sh
npx baseclf policy apply posts.json --project your-project
curl https://your-project.your-subdomain.workers.dev/rest/v1/posts
```

Published rows come back; drafts were never granted. A policy change lands within about thirty seconds. Direct database access (`wrangler d1 execute`, the D1 console) bypasses the engine by design.
