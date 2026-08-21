import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sites } from "@openai/sites-vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// hosting.json is the demo host's private manifest and never reaches the
// public repository (it carries a real project id), so a fresh clone and CI
// build without it. Its only role here is naming optional local dev bindings,
// and a build with no bindings is exactly what those environments want.
// A static `import` of it took the whole config down on CI the moment the
// site workspace joined the pipeline.
const hostingPath = fileURLToPath(new URL("./.openai/hosting.json", import.meta.url));
const hostingAvailable = existsSync(hostingPath);
const { d1 = null, r2 = null }: { d1?: string | null; r2?: string | null } = hostingAvailable
  ? JSON.parse(readFileSync(hostingPath, "utf8"))
  : {};

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      // The sites plugin serves the demo host and reads the same private
      // manifest at closeBundle, so it only runs where the manifest exists.
      // CI and a fresh clone build without it, which is also what they want.
      ...(hostingAvailable ? [sites()] : []),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
