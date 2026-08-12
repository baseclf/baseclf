/**
 * What a tool is, expressed without the SDK's types leaking through the project.
 *
 * The SDK's `registerTool` signature is generic over the schema types and changes
 * shape between the current overload and the deprecated one. Describing a tool
 * with a plain object here keeps every tool file free of that, and keeps the one
 * place that touches the SDK small enough to read.
 */

import type { ZodType } from 'zod';

import type { McpAuthEnv } from '../auth.js';
import type { ToolResult } from './result.js';

/**
 * What the tools need from the environment.
 *
 * ⚠️ `McpAuthEnv` deliberately named only `MCP_TOKEN`, because until there were
 * tools the endpoint needed nothing else. The binding was there the whole time:
 * `handleMcp` is called with the worker's full `Env`, so this widens the type to
 * match what already arrives rather than wiring anything new.
 */
export interface McpToolEnv extends McpAuthEnv {
  readonly DB: D1Database;
}

/** The four annotations, required on every tool with no exceptions. */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly config: {
    readonly title: string;
    readonly description: string;
    readonly inputSchema: ZodType;
    /**
     * Required, not optional.
     *
     * ⚠️ Declaring it obliges the handler to return `structuredContent`; the SDK
     * answers `-32602` otherwise. `toolSuccess` is what satisfies that, which is
     * why no tool builds its own result.
     */
    readonly outputSchema: ZodType;
    readonly annotations: ToolAnnotations;
  };
  /**
   * ⚠️ Takes `unknown` and parses again inside.
   *
   * The SDK validates against `inputSchema` before calling, so the second parse
   * is not the safety check. It is what turns a validated value into a typed one
   * without an `as` across the boundary, which `rules/03` section D asks for.
   */
  readonly handler: (args: unknown) => Promise<ToolResult>;
}
