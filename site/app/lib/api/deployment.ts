/**
 * The deployment's public surfaces, read without any credential.
 *
 * Overview composes three endpoints every BaseCLF worker serves to anybody:
 * `/health` (the running version), `/api/auth/_diagnose` (what is configured,
 * with warnings), and `/_schema` (application tables, counts only). The API
 * Explorer sends anonymous REST requests. None of this needs the admin token,
 * which is why these helpers take an origin string rather than a client.
 *
 * The response shapes are copied from the engine source, not guessed:
 * `src/index.ts` (`/health`, `describeSchema`) and `src/auth/diagnose.ts`
 * (`DiagnoseReport`), read on 2026-08-21.
 */

export interface HealthReport {
  readonly status: string;
  readonly version: string;
}

export interface ProviderReport {
  readonly configured: boolean;
  readonly missing: readonly string[];
  readonly redirect_uri: string;
}

export interface DiagnoseReport {
  readonly ok: boolean;
  readonly secret_configured: boolean;
  readonly email_password_enabled: boolean;
  /** `BETTER_AUTH_URL` reduced to its origin. Empty when it is not a URL. */
  readonly base_url_config: string;
  readonly base_url_actual: string;
  readonly base_url_matches: boolean;
  /**
   * The origins allowed to call this deployment from a browser. Read on the
   * Auth screen because a sign-in that fails for a missing origin fails in the
   * browser's console, where the person configuring it is not looking.
   */
  readonly trusted_origins: readonly string[];
  readonly providers: Readonly<Record<string, ProviderReport>>;
  readonly bindings: readonly { readonly name: string; readonly present: boolean }[];
  readonly warnings: readonly string[];
}

export interface SchemaTableSummary {
  readonly name: string;
  readonly columns: number;
  readonly indexes: number;
  readonly foreignKeys: number;
}

export interface DeploymentReading {
  readonly health: HealthReport;
  readonly diagnose: DiagnoseReport;
  readonly tables: readonly SchemaTableSummary[];
}

async function readJson<T>(origin: string, path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} answered ${response.status}.`);
  return (await response.json()) as T;
}

/**
 * All three public reads, together. One failure fails the reading: an Overview
 * built from two of three sources would present absence as fact.
 */
export async function readDeployment(
  origin: string,
): Promise<{ kind: "data"; reading: DeploymentReading } | { kind: "error"; message: string }> {
  try {
    const [health, diagnose, schema] = await Promise.all([
      readJson<HealthReport>(origin, "/health"),
      readJson<DiagnoseReport>(origin, "/api/auth/_diagnose"),
      readJson<{ tables: SchemaTableSummary[] }>(origin, "/_schema"),
    ]);
    return { kind: "data", reading: { health, diagnose, tables: schema.tables } };
  } catch (cause) {
    return {
      kind: "error",
      message:
        cause instanceof Error && cause.message !== ""
          ? `Could not read the deployment. ${cause.message}`
          : "Could not read the deployment.",
    };
  }
}

/**
 * The diagnostic on its own, for a screen that wants only this and wants to
 * re-read it after the operator changes something. Separate from
 * `readDeployment` on purpose: that one fails as a unit because an Overview
 * built from two of three sources presents absence as fact, while the Auth
 * screen has exactly one source and nothing to be partial about.
 */
export async function readDiagnose(
  origin: string,
): Promise<{ kind: "data"; diagnose: DiagnoseReport } | { kind: "error"; message: string }> {
  try {
    return { kind: "data", diagnose: await readJson<DiagnoseReport>(origin, "/api/auth/_diagnose") };
  } catch (cause) {
    return {
      kind: "error",
      message:
        cause instanceof Error && cause.message !== ""
          ? `Could not read the deployment's auth configuration. ${cause.message}`
          : "Could not read the deployment's auth configuration.",
    };
  }
}

/** What one anonymous REST request came back with, headers included. */
export interface RestExchange {
  readonly status: number;
  readonly durationMs: number;
  readonly body: string;
  /** From x-baseclf-rows-read: what D1 scanned to answer, which is what D1 bills. */
  readonly rowsRead: string | null;
  /** From x-d1-bookmark: the read-replication session token, present on data answers. */
  readonly bookmark: string | null;
}

/**
 * Send one anonymous GET and report exactly what happened. No token is ever
 * attached: the explorer shows what the public sees, and the two response
 * headers are readable because the engine lists them in
 * Access-Control-Expose-Headers.
 */
export async function sendAnonymousRead(
  origin: string,
  path: string,
): Promise<{ kind: "data"; exchange: RestExchange } | { kind: "error"; message: string }> {
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, { headers: { accept: "application/json" } });
  } catch {
    return {
      kind: "error",
      message:
        "The deployment could not be reached. Check the URL, and that this page's origin is in its trusted origins.",
    };
  }

  const raw = await response.text();
  let body = raw;
  try {
    body = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // Not JSON; show it as it came.
  }

  return {
    kind: "data",
    exchange: {
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      body,
      rowsRead: response.headers.get("x-baseclf-rows-read"),
      bookmark: response.headers.get("x-d1-bookmark"),
    },
  };
}
