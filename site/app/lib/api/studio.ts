/**
 * The Studio's client for a real deployment.
 *
 * Components never call fetch themselves; this is the one place that knows the
 * MCP wire format, so a transport change is one file. The format is copied from
 * scripts/probe-mcp-tools.mjs in the engine repository, which measured it
 * against a live deployment: JSON-RPC over POST /mcp, the three Mcp-* headers
 * the transport requires, and answers that may arrive as JSON or as an SSE
 * stream, both of which are correct.
 *
 * The admin token lives in this object and, once a connection has been proven,
 * in the browser's saved session (see app/studio/session.ts for the scope and
 * the expiry that tempers it): not in a cookie, never in a URL. Disconnect
 * forgets it everywhere.
 */

const PROTOCOL_VERSION = "2026-07-28";

export interface SimulateInput {
  readonly table: string;
  readonly operation: "select" | "insert" | "update" | "delete";
  readonly role: string;
  readonly claims?: { readonly uid?: string; readonly email?: string };
  readonly body?: Readonly<Record<string, unknown>>;
}

export interface SimulateResult {
  readonly table: string;
  readonly operation: string;
  readonly role: string;
  readonly sql: string;
  readonly parameterCount?: number;
  readonly parametersWithheld: boolean;
  readonly policies: readonly string[];
  readonly columns: readonly string[];
}

export interface PolicyEntry {
  readonly name: string;
  readonly operation: string;
  readonly roles: readonly string[];
  readonly columns: readonly string[];
  readonly hasCheck: boolean;
  readonly serverSet: readonly string[];
}

export interface PolicyTable {
  readonly table: string;
  readonly enabled: boolean;
  readonly version: number;
  readonly policies: readonly PolicyEntry[];
}

export interface LintFinding {
  readonly code: string;
  readonly table: string;
  readonly policy: string;
  readonly detail: string;
  readonly remedy?: string;
}

/** One row of schema_list: every application table, exposed or not. */
export interface SchemaTable {
  readonly name: string;
  readonly columns: number;
  readonly indexes: number;
  readonly exposed: boolean;
}

/** schema_describe: names and shapes, never values. hasDefault is a boolean on purpose. */
export interface TableDetail {
  readonly table: string;
  readonly columns: readonly {
    readonly name: string;
    readonly type: string;
    readonly notNull: boolean;
    readonly primaryKey: boolean;
    readonly hasDefault: boolean;
  }[];
  readonly indexes: readonly {
    readonly name: string;
    readonly unique: boolean;
    readonly columns: readonly string[];
  }[];
  readonly foreignKeys: readonly {
    readonly column: string;
    readonly referencesTable: string;
    readonly referencesColumn: string;
  }[];
}

/**
 * The three ways a call ends, kept apart on purpose. `error` means the request
 * never reached the tool (network, CORS, token, protocol); `refusal` means the
 * engine ran and said no, which for a simulator is often the correct, passing
 * answer; `data` is a completed call.
 */
export type ToolAnswer<T> =
  | { readonly kind: "data"; readonly data: T }
  | { readonly kind: "refusal"; readonly message: string }
  | {
      readonly kind: "error";
      readonly message: string;
      /** Set when the deployment answered 429; from its Retry-After header. */
      readonly retryAfterSeconds?: number;
    };

interface RpcEnvelope {
  readonly result?: {
    readonly isError?: boolean;
    readonly content?: readonly { readonly text?: string }[];
    readonly structuredContent?: unknown;
    readonly tools?: readonly { readonly name?: string }[];
  };
  readonly error?: { readonly code?: number; readonly message?: string };
}

/** A response may be JSON or an SSE stream; the server chooses and both are correct. */
function parseBody(contentType: string, text: string): RpcEnvelope | null {
  try {
    if (contentType.includes("text/event-stream")) {
      const payload = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      return payload === "" ? null : (JSON.parse(payload) as RpcEnvelope);
    }
    return JSON.parse(text) as RpcEnvelope;
  } catch {
    return null;
  }
}

export class StudioClient {
  readonly origin: string;
  readonly #token: string;

  constructor(url: string, token: string) {
    this.origin = url.trim().replace(/\/+$/, "");
    // Trimmed for the same reason the CLI trims what it reads: a paste often
    // carries a trailing space, and a bearer token with invisible whitespace
    // fails every check with nothing anywhere mentioning whitespace.
    this.#token = token.trim();
  }

  async #rpc(method: string, params: Record<string, unknown>): Promise<Response> {
    const name = typeof params.name === "string" ? params.name : undefined;
    return fetch(`${this.origin}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        "mcp-method": method,
        ...(name === undefined ? {} : { "mcp-name": name }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
  }

  /**
   * The connection test is a real round trip, not a shape check on the token.
   * A 401 is the deployment refusing the token; a thrown fetch is usually CORS,
   * and the message says which setting decides that.
   */
  async connect(): Promise<{ readonly tools: readonly string[] } | { readonly error: string }> {
    let response: Response;
    try {
      response = await this.#rpc("tools/list", {});
    } catch {
      return {
        error:
          "Could not reach the deployment. Check the URL, and that this page's origin " +
          "is listed in the deployment's trusted origins.",
      };
    }

    if (response.status === 401) {
      return { error: "The deployment refused the token." };
    }

    const envelope = parseBody(response.headers.get("content-type") ?? "", await response.text());
    const tools = envelope?.result?.tools
      ?.map((tool) => tool.name)
      .filter((toolName): toolName is string => typeof toolName === "string");

    if (tools === undefined) {
      return { error: `The deployment answered ${response.status} without a tool list.` };
    }
    return { tools };
  }

  async #call<T>(name: string, args: Record<string, unknown>): Promise<ToolAnswer<T>> {
    let response: Response;
    try {
      response = await this.#rpc("tools/call", { name, arguments: args });
    } catch {
      return { kind: "error", message: "The deployment could not be reached." };
    }

    if (response.status === 401) {
      return { kind: "error", message: "The deployment refused the token." };
    }
    if (response.status === 429) {
      // The engine's limiter always sends Retry-After in whole seconds, and
      // exposes it through CORS precisely so this page can read it. No
      // automatic retry: the person decides when to press Run again.
      const declared = Number(response.headers.get("retry-after"));
      const wait = Number.isInteger(declared) && declared > 0 ? declared : 60;
      return {
        kind: "error",
        message: `The deployment is rate limiting this endpoint. Try again in ${wait}s.`,
        retryAfterSeconds: wait,
      };
    }

    const envelope = parseBody(response.headers.get("content-type") ?? "", await response.text());
    if (envelope === null) {
      return { kind: "error", message: `The answer was not readable (HTTP ${response.status}).` };
    }
    if (envelope.error !== undefined) {
      return { kind: "error", message: `JSON-RPC ${envelope.error.code}: ${envelope.error.message}` };
    }
    if (envelope.result === undefined) {
      return { kind: "error", message: `No result came back (HTTP ${response.status}).` };
    }
    if (envelope.result.isError === true) {
      const text = envelope.result.content?.map((block) => block.text ?? "").join("\n") ?? "";
      return { kind: "refusal", message: text.trim() === "" ? "Refused." : text.trim() };
    }
    return { kind: "data", data: envelope.result.structuredContent as T };
  }

  simulate(input: SimulateInput): Promise<ToolAnswer<SimulateResult>> {
    return this.#call<SimulateResult>("policy_simulate", { ...input });
  }

  policies(): Promise<ToolAnswer<{ readonly tables: readonly PolicyTable[] }>> {
    return this.#call("policy_list", {});
  }

  lint(): Promise<ToolAnswer<{ readonly findings: readonly LintFinding[]; readonly withheld: number }>> {
    return this.#call("policy_lint", {});
  }

  schema(): Promise<ToolAnswer<{ readonly tables: readonly SchemaTable[] }>> {
    return this.#call("schema_list", {});
  }

  describeTable(table: string): Promise<ToolAnswer<TableDetail>> {
    return this.#call<TableDetail>("schema_describe", { table });
  }
}

/** What one bridge run returns: real rows, and what reading them scanned. */
export interface BridgeRows {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowsRead?: number | null;
  readonly limit?: number;
}

/** Where `npx baseclf studio` listens. Loopback only, by that command's design. */
export const BRIDGE_URL = "http://127.0.0.1:4000";

/**
 * Ask the local bridge what this caller would be shown.
 *
 * The bridge takes the simulate input, never SQL: it compiles and runs the read
 * itself with the operator's own credential, on the operator's own machine. The
 * key it printed at startup rides on every request and lives in page memory
 * only, like the admin token.
 */
/**
 * Read the stored source document for one table from the bridge, so the
 * policies editor edits what is actually running. Null means not exposed yet.
 */
export async function readDocumentOnBridge(
  key: string,
  table: string,
): Promise<ToolAnswer<{ readonly document: Record<string, unknown> | null }>> {
  let response: Response;
  try {
    response = await fetch(`${BRIDGE_URL}/document?table=${encodeURIComponent(table)}`, {
      headers: { "x-bridge-key": key },
    });
  } catch {
    return {
      kind: "error",
      message: "The bridge could not be reached. Is npx baseclf studio running?",
    };
  }
  if (response.status === 401) return { kind: "error", message: "The bridge refused the key." };
  try {
    return { kind: "data", data: (await response.json()) as { document: Record<string, unknown> | null } };
  } catch {
    return { kind: "error", message: `The bridge answered ${response.status} without a body.` };
  }
}

/**
 * Apply a policy document through the bridge, which runs the CLI's own apply.
 * The page sends the document TEXT the operator edited, never SQL; the
 * engine's validator decides on the bridge before anything leaves the machine,
 * and a refusal comes back with the validator's own reason.
 */
export async function applyOnBridge(
  key: string,
  text: string,
): Promise<ToolAnswer<{ readonly applied: boolean; readonly lines: readonly string[] }>> {
  let response: Response;
  try {
    response = await fetch(`${BRIDGE_URL}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-key": key },
      body: JSON.stringify({ text }),
    });
  } catch {
    return {
      kind: "error",
      message: "The bridge could not be reached. Is npx baseclf studio running?",
    };
  }
  if (response.status === 401) return { kind: "error", message: "The bridge refused the key." };

  let body: { applied?: boolean; lines?: string[]; refusal?: string; error?: string };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { kind: "error", message: `The bridge answered ${response.status} without a body.` };
  }
  if (body.refusal !== undefined) return { kind: "refusal", message: body.refusal };
  if (body.applied !== undefined) {
    return { kind: "data", data: { applied: body.applied, lines: body.lines ?? [] } };
  }
  return { kind: "error", message: body.error ?? `The bridge answered ${response.status}.` };
}

export async function runOnBridge(
  key: string,
  input: { table: string; role: string; claims?: { uid?: string; email?: string } },
): Promise<ToolAnswer<BridgeRows>> {
  let response: Response;
  try {
    response = await fetch(`${BRIDGE_URL}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-key": key },
      body: JSON.stringify(input),
    });
  } catch {
    return {
      kind: "error",
      message: "The bridge could not be reached. Is npx baseclf studio running?",
    };
  }

  if (response.status === 401) {
    return { kind: "error", message: "The bridge refused the key." };
  }

  let body: { rows?: Record<string, unknown>[]; rowsRead?: number | null; limit?: number; refusal?: string; error?: string };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { kind: "error", message: `The bridge answered ${response.status} without a body.` };
  }

  if (body.refusal !== undefined) return { kind: "refusal", message: body.refusal };
  if (body.rows !== undefined) {
    return { kind: "data", data: { rows: body.rows, rowsRead: body.rowsRead, limit: body.limit } };
  }
  return { kind: "error", message: body.error ?? `The bridge answered ${response.status}.` };
}

/** One page of one table, as the operator. Never counted, only paged. */
export interface BrowsePage {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowsRead: number | null;
  readonly limit: number;
  readonly offset: number;
}

/**
 * Read one page of a table through the bridge, newest rows first.
 *
 * The operator's view: their own credential, no policy applied, which is why
 * the panel that renders this says so. The page sends a table name and an
 * offset, never SQL, and the bridge refuses engine tables and deep pages
 * (every skipped row is scanned, and rows read is what D1 bills).
 */
export async function browseOnBridge(
  key: string,
  table: string,
  offset: number,
): Promise<ToolAnswer<BrowsePage>> {
  let response: Response;
  try {
    response = await fetch(
      `${BRIDGE_URL}/rows?table=${encodeURIComponent(table)}&offset=${encodeURIComponent(String(offset))}`,
      { headers: { "x-bridge-key": key } },
    );
  } catch {
    return {
      kind: "error",
      message: "The bridge could not be reached. Is npx baseclf studio running?",
    };
  }
  if (response.status === 401) return { kind: "error", message: "The bridge refused the key." };

  let body: { rows?: Record<string, unknown>[]; rowsRead?: number | null; limit?: number; offset?: number; error?: string };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { kind: "error", message: `The bridge answered ${response.status} without a body.` };
  }
  if (body.rows !== undefined) {
    return {
      kind: "data",
      data: {
        rows: body.rows,
        rowsRead: body.rowsRead ?? null,
        limit: body.limit ?? body.rows.length,
        offset: body.offset ?? offset,
      },
    };
  }
  return { kind: "error", message: body.error ?? `The bridge answered ${response.status}.` };
}

/** What came back from one edit: the row as it now stands, and whether it was recorded. */
export interface EditedRow {
  readonly row: Record<string, unknown>;
  /**
   * False when the change was written and the audit entry was not.
   *
   * The bridge writes the two separately on purpose, so this is the case where
   * it knows something happened that its log does not show. It is surfaced
   * rather than swallowed because the operator is the only one who can act on
   * it.
   */
  readonly recorded: boolean;
  readonly warning?: string;
}

/**
 * Change one field of one row through the bridge, as the operator.
 *
 * The page sends a table, the row's whole primary key, the column, the value it
 * displayed, and the value to put there. Never SQL and never a filter: the
 * bridge builds the statement, and "change every row" is not something this
 * request can express.
 *
 * `expected` is what makes concurrency safe without a transaction. It goes into
 * the WHERE, so an edit against a value somebody else already changed writes
 * nothing and comes back as a refusal rather than overwriting their work.
 */
export async function editOnBridge(
  key: string,
  edit: {
    readonly table: string;
    readonly key: Readonly<Record<string, unknown>>;
    readonly column: string;
    readonly expected: unknown;
    readonly next: unknown;
  },
): Promise<ToolAnswer<EditedRow>> {
  let response: Response;
  try {
    response = await fetch(`${BRIDGE_URL}/rows`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-bridge-key": key },
      body: JSON.stringify(edit),
    });
  } catch {
    return {
      kind: "error",
      message: "The bridge could not be reached. Is npx baseclf studio running?",
    };
  }
  if (response.status === 401) return { kind: "error", message: "The bridge refused the key." };

  let body: {
    row?: Record<string, unknown>;
    recorded?: boolean;
    warning?: string;
    conflict?: string;
    error?: string;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { kind: "error", message: `The bridge answered ${response.status} without a body.` };
  }

  // A conflict is an answer, not a failure: somebody else changed the value, and
  // the person needs to see that sentence rather than a generic error.
  if (body.conflict !== undefined) return { kind: "refusal", message: body.conflict };

  if (body.row !== undefined) {
    return {
      kind: "data",
      data: { row: body.row, recorded: body.recorded !== false, warning: body.warning },
    };
  }
  return { kind: "error", message: body.error ?? `The bridge answered ${response.status}.` };
}

/** What Cloudflare recorded against the account for this one deployment. */
export interface UsageNumbers {
  readonly requests: number;
  readonly errors: number;
  /** Microseconds, as Cloudflare reports them. Null when the window has no data. */
  readonly cpuP50: number | null;
  readonly cpuP99: number | null;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly since: string;
  readonly until: string;
  readonly scriptName: string;
}

/**
 * Read the usage numbers through the bridge, or learn why they are not readable.
 *
 * These are the one thing on the Health screen the deployment cannot report about
 * itself: requests, errors, CPU and rows are recorded by Cloudflare against the
 * account. The bridge holds the operator's credential; this page never does.
 *
 * A refusal comes back as a `refusal`, not an error, and it is the expected outcome
 * rather than a rare one: the permission list `create-baseclf` prints does not
 * include `Account · Account Analytics · Read`, so a token built by following those
 * instructions exactly will land here. The message carries the permission so the
 * screen can name it instead of showing an empty panel.
 */
export async function usageOnBridge(key: string): Promise<ToolAnswer<UsageNumbers>> {
  let response: Response;
  try {
    response = await fetch(`${BRIDGE_URL}/usage`, { headers: { "x-bridge-key": key } });
  } catch {
    return {
      kind: "error",
      message: "The bridge could not be reached. Is npx baseclf studio running?",
    };
  }
  if (response.status === 401) return { kind: "error", message: "The bridge refused the key." };

  let body: { numbers?: UsageNumbers; refused?: string; permission?: string; error?: string };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { kind: "error", message: `The bridge answered ${response.status} without a body.` };
  }

  if (body.refused !== undefined) {
    // Cloudflare's own words, then the permission. Both, because the wording is
    // theirs to change and the permission is the thing a reader can act on.
    const needs =
      body.permission === undefined ? "" : ` The permission this needs is ${body.permission}.`;
    return { kind: "refusal", message: `Cloudflare would not answer: ${body.refused}.${needs}` };
  }
  if (body.numbers !== undefined) return { kind: "data", data: body.numbers };
  return { kind: "error", message: body.error ?? `The bridge answered ${response.status}.` };
}
