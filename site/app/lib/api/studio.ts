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
 * The admin token lives in this object in memory and nowhere else: not in
 * localStorage, not in a cookie, never in a URL. Closing the tab forgets it,
 * which is the right default for a credential that grants schema reads.
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

/**
 * The three ways a call ends, kept apart on purpose. `error` means the request
 * never reached the tool (network, CORS, token, protocol); `refusal` means the
 * engine ran and said no, which for a simulator is often the correct, passing
 * answer; `data` is a completed call.
 */
export type ToolAnswer<T> =
  | { readonly kind: "data"; readonly data: T }
  | { readonly kind: "refusal"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

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
    this.#token = token;
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
}
