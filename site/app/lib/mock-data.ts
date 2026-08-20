export const mockProject = {
  name: "launch-notes",
  endpoint: "https://launch-notes.baseclf.workers.dev",
  database: "launch-notes-prod",
  environment: "production",
  status: "connected",
} as const;

export const mockSimulatorRows = [
  { id: "p_01", title: "Launch notes", author: "Maya", status: "published", visible: true },
  { id: "p_02", title: "Team draft", author: "Leo", status: "draft", visible: false },
  { id: "p_03", title: "Public roadmap", author: "Maya", status: "published", visible: true },
  { id: "p_04", title: "Private brief", author: "Leo", status: "draft", visible: false },
] as const;

export const mockPolicies = [
  { name: "read_published", operation: "select", role: "authenticated", table: "posts", state: "active" },
  { name: "read_own_drafts", operation: "select", role: "authenticated", table: "posts", state: "attention" },
  { name: "write_own_posts", operation: "insert, update", role: "authenticated", table: "posts", state: "active" },
] as const;

export const mockClaims = `{
  "sub": "usr_maya_chen",
  "role": "authenticated",
  "email": "maya@example.dev"
}`;

export const mockSql = `SELECT
  "posts"."id",
  "posts"."title",
  "posts"."author_id",
  "posts"."status"
FROM "posts"
WHERE (
  "posts"."status" = ?1
  OR "posts"."author_id" = ?2
);`;

export const mockParameters = [
  { placeholder: "?1", value: "published" },
  { placeholder: "?2", value: "usr_maya_chen" },
] as const;

export const mockTables = [
  { name: "posts", rows: 128, policies: 3, state: "attention" },
  { name: "profiles", rows: 46, policies: 2, state: "active" },
  { name: "comments", rows: 384, policies: 4, state: "active" },
] as const;

export const mockUsers = [
  { id: "usr_maya_chen", name: "Maya Chen", email: "maya@example.dev", provider: "Google", state: "active" },
  { id: "usr_leo_martins", name: "Leo Martins", email: "leo@example.dev", provider: "GitHub", state: "active" },
  { id: "usr_ana_silva", name: "Ana Silva", email: "ana@example.dev", provider: "Email", state: "disabled" },
] as const;

export const mockStorageObjects = [
  { name: "avatars/maya.webp", type: "image/webp", size: "84 KB", access: "private" },
  { name: "documents/launch-notes.pdf", type: "application/pdf", size: "128 KB", access: "team" },
  { name: "public/brand-mark.png", type: "image/png", size: "22 KB", access: "public" },
] as const;

export const mockHealth = {
  databaseSize: "42.8 MB",
  rowsRead: "184,220",
  rowsWritten: "3,418",
  requests: "24,681",
  failures: "38",
  period: "Last 7 days",
} as const;

export const mockExamplePosts = [
  { id: "post_01", title: "The first protected request", excerpt: "A practical look at policy-filtered reads on D1.", date: "Aug 12" },
  { id: "post_02", title: "Why ownership stays in your account", excerpt: "Workers, D1, and R2 remain under your Cloudflare account.", date: "Aug 08" },
] as const;

export const mockCompatibility = [
  ["supabase-js query style", "Supported", "Same query grammar; the 14 operators SQLite cannot run are refused by name."],
  ["Email and password auth", "Off by default", "Hashing one password costs ~58 ms CPU against the free plan's 10 ms per request."],
  ["OAuth providers", "Supported", "Google and GitHub, configured per deployment."],
  ["Realtime subscriptions", "Planned", "No CDC on D1; change events would be produced by the Worker, not the database."],
  ["Postgres extensions", "Not applicable", "D1 is SQLite-based, not Postgres."],
  ["R2 object storage", "Supported", "Proxied through the Worker; no presigned URLs by design."],
] as const;

export const mockProvisioningSteps = [
  { label: "Cloudflare session", detail: "Account access confirmed" },
  { label: "D1 database", detail: "field-notes-db" },
  { label: "R2 bucket", detail: "field-notes-files" },
  { label: "Worker subdomain", detail: "field-notes.baseclf.workers.dev" },
  { label: "Signing secret", detail: "Generated and stored" },
  { label: "Policy schema", detail: "Base tables applied" },
  { label: "Worker deployment", detail: "Uploading application bundle" },
  { label: "Scheduled maintenance", detail: "Waiting" },
  { label: "Health check", detail: "Waiting for endpoint" },
] as const;

export const mockProjectServices = [
  { name: "Database", resource: "field-notes-db", state: "Ready", detail: "3 tables · 9 policies" },
  { name: "Authentication", resource: "2 providers", state: "Review", detail: "Redirect URI needs copying" },
  { name: "Storage", resource: "field-notes-files", state: "Ready", detail: "0 objects" },
  { name: "Instant API", resource: "/rest/v1", state: "Ready", detail: "Protected by default" },
] as const;

export const mockActivity = [
  { time: "Just now", event: "Health check passed", actor: "BaseCLF" },
  { time: "2 min ago", event: "read_published policy applied", actor: "Maya" },
  { time: "4 min ago", event: "Project provisioned", actor: "BaseCLF" },
] as const;

export const mockApiResponse = `[
  {
    "id": "post_01",
    "title": "The first protected request",
    "status": "published"
  },
  {
    "id": "post_02",
    "title": "Why ownership stays in your account",
    "status": "published"
  }
]`;

export const mockRequestLogs = [
  { id: "req_7f3a", time: "14:32:08.418", method: "GET", path: "/rest/v1/posts", status: 200, duration: "42 ms", severity: "info", region: "SIN", role: "authenticated", message: "2 rows returned after policy filter" },
  { id: "req_7f39", time: "14:31:54.102", method: "POST", path: "/rest/v1/posts", status: 404, duration: "18 ms", severity: "warning", region: "SIN", role: "anon", message: "Insert refused; no policy grants anon this write, answered not found" },
  { id: "req_7f38", time: "14:31:12.776", method: "GET", path: "/api/auth/get-session", status: 200, duration: "27 ms", severity: "info", region: "HKG", role: "authenticated", message: "Session resolved for usr_maya_chen" },
  { id: "req_7f37", time: "14:29:45.201", method: "GET", path: "/storage/v1/app-files/report.pdf", status: 404, duration: "31 ms", severity: "error", region: "SIN", role: "authenticated", message: "No object behind that name, answered not found" },
  { id: "req_7f36", time: "14:28:19.930", method: "PATCH", path: "/rest/v1/profiles", status: 200, duration: "55 ms", severity: "info", region: "NRT", role: "authenticated", message: "1 row updated" },
] as const;

export const mockFunctions = [
  { name: "send-welcome-email", trigger: "HTTP", path: "/functions/v1/send-welcome-email", state: "deployed", updated: "8 min ago" },
  { name: "cleanup-expired-sessions", trigger: "Scheduled", path: "scheduled()", state: "deployed", updated: "2 hours ago" },
  { name: "sync-profile-photo", trigger: "HTTP", path: "/functions/v1/sync-profile-photo", state: "draft", updated: "Yesterday" },
] as const;

export const mockSchedules = [
  { expression: "0 3 * * *", label: "Daily at 03:00 UTC", target: "cleanup-expired-sessions", state: "active" },
  { expression: "0 */6 * * *", label: "Every 6 hours", target: "refresh-public-cache", state: "paused" },
] as const;

export const mockEnvironments = [
  { name: "Production", worker: "field-notes", branch: "main", state: "active" },
  { name: "Preview", worker: "field-notes-preview", branch: "preview", state: "active" },
] as const;

export const mockSecrets = [
  { name: "GOOGLE_CLIENT_SECRET", environment: "Production", updated: "Aug 18", state: "configured" },
  { name: "GITHUB_CLIENT_SECRET", environment: "Production", updated: "Aug 17", state: "configured" },
  { name: "EMAIL_API_TOKEN", environment: "Production", updated: "Not set", state: "missing" },
] as const;

export const mockSqlHistory = [
  { name: "Published posts", query: "SELECT id, title, status, updated_at\nFROM posts\nWHERE status = 'published'\nORDER BY updated_at DESC\nLIMIT 50;", duration: "38 ms", rows: 3 },
  { name: "Active profiles", query: "SELECT id, display_name, plan\nFROM profiles\nWHERE disabled_at IS NULL\nLIMIT 100;", duration: "51 ms", rows: 3 },
  { name: "Draft count", query: "SELECT COUNT(*) AS drafts\nFROM posts\nWHERE status = 'draft';", duration: "17 ms", rows: 1 },
] as const;

export const mockSqlResults = [
  { id: "post_01", title: "The first protected request", status: "published", updated_at: "2026-08-18 14:20:08" },
  { id: "post_02", title: "Why ownership stays in your account", status: "published", updated_at: "2026-08-17 09:44:51" },
  { id: "post_04", title: "Shipping the policy simulator", status: "published", updated_at: "2026-08-15 18:02:12" },
] as const;

export const mockMigrations = [
  { version: "0007", name: "add_post_visibility", state: "pending", author: "Maya", created: "12 min ago", statements: 3 },
  { version: "0006", name: "index_profiles_email", state: "applied", author: "Leo", created: "Aug 18", statements: 2 },
  { version: "0005", name: "create_comments", state: "applied", author: "Maya", created: "Aug 16", statements: 6 },
  { version: "0004", name: "add_storage_policies", state: "applied", author: "BaseCLF", created: "Aug 15", statements: 4 },
] as const;

export const mockRestorePoints = [
  { time: "Today, 14:32 UTC", bookmark: "00000085…91a683", note: "Current state" },
  { time: "Today, 12:00 UTC", bookmark: "00000082…5f9d10", note: "Before migration 0007" },
  { time: "Yesterday, 18:00 UTC", bookmark: "00000079…cab204", note: "Daily export created" },
] as const;

export const mockDataJobs = [
  { name: "launch-notes-2026-08-18.sql", kind: "Export", destination: "R2 / baseclf-exports", state: "Complete", size: "41.8 MB" },
  { name: "seed-profiles.sql", kind: "Import", destination: "launch-notes-prod", state: "Complete", size: "820 KB" },
] as const;

export const mockWebhooks = [
  { name: "New user → CRM", event: "auth.user.created", endpoint: "https://hooks.example.dev/users", state: "active", success: "99.8%" },
  { name: "Post published", event: "db.posts.published", endpoint: "https://api.example.dev/index", state: "active", success: "97.4%" },
  { name: "Failed payment", event: "billing.payment.failed", endpoint: "https://hooks.example.dev/billing", state: "paused", success: "—" },
] as const;

export const mockQueues = [
  { name: "email-delivery", consumer: "send-email", backlog: 14, retries: 2, state: "healthy" },
  { name: "search-index", consumer: "index-post", backlog: 183, retries: 9, state: "attention" },
  { name: "webhook-dlq", consumer: "No consumer", backlog: 4, retries: 0, state: "review" },
] as const;

export const mockDeployments = [
  { version: "v18", hash: "c91b5a7", message: "Add policy audit events", actor: "Maya", time: "18 min ago", traffic: 100, state: "active" },
  { version: "v17", hash: "7e0f231", message: "Improve auth callback", actor: "Leo", time: "Yesterday", traffic: 0, state: "ready" },
  { version: "v16", hash: "089a42c", message: "Storage policy fix", actor: "Maya", time: "Aug 17", traffic: 0, state: "ready" },
] as const;

export const mockTeamMembers = [
  { name: "Maya Chen", email: "maya@example.dev", role: "Owner", access: "All projects", state: "active" },
  { name: "Leo Martins", email: "leo@example.dev", role: "Developer", access: "Production + Preview", state: "active" },
  { name: "Ana Silva", email: "ana@example.dev", role: "Analyst", access: "Read-only", state: "invited" },
] as const;

export const mockApiKeys = [
  { name: "Browser client", prefix: "bclf_public_7pk…", scope: "Public API", lastUsed: "2 min ago", created: "Aug 12" },
  { name: "CI deploy", prefix: "bclf_secret_9da…", scope: "Deployments: write", lastUsed: "Yesterday", created: "Aug 08" },
  { name: "Analytics export", prefix: "bclf_secret_2mh…", scope: "Logs: read", lastUsed: "Never", created: "Aug 18" },
] as const;

export const mockUsage = [
  { label: "API requests", value: "184.2K", limit: "1M included", percent: 18 },
  { label: "D1 rows read", value: "2.8M", limit: "Mock allowance", percent: 42 },
  { label: "R2 storage", value: "1.7 GB", limit: "10 GB mock cap", percent: 17 },
  { label: "Function invocations", value: "24.6K", limit: "100K included", percent: 25 },
] as const;

export const mockInvoices = [
  { period: "August 2026", amount: "$24.00", state: "Projected", date: "Sep 01" },
  { period: "July 2026", amount: "$19.00", state: "Paid", date: "Aug 01" },
] as const;

export const mockRealtimeChannels = [
  { name: "room:launch-notes", connections: 18, events: 1284, presence: true },
  { name: "project:updates", connections: 7, events: 442, presence: false },
  { name: "user:usr_maya_chen", connections: 2, events: 86, presence: false },
] as const;
