/**
 * The tool registry, and the one place that touches the SDK.
 *
 * Four read-only tools. Every one of them declares all four annotations and an
 * `outputSchema`, with no exceptions, which is the bar `skills/mcp-server`
 * section 5 sets and the reason `ToolDefinition` makes both mandatory rather than
 * optional.
 *
 * ## Read-only means not registered, not refused
 *
 * There are no write tools yet. When there are, the way to withhold them is to
 * leave them out of this list rather than to refuse them when called: a model
 * cannot call what it cannot see, and a refusal at call time still puts the name
 * in front of it. The SDK does have `disable()`, measured on 2026-08-12, but under
 * `createMcpHandler` the server is rebuilt per request, so filtering here is both
 * simpler and the only version with nothing to keep in step.
 */

import type { McpServer } from '@modelcontextprotocol/server';

import { policyLint } from './policy-lint.js';
import { policyList } from './policy-list.js';
import { schemaDescribe } from './schema-describe.js';
import { schemaList } from './schema-list.js';
import type { McpToolEnv, ToolDefinition } from './types.js';

/**
 * Every tool, in a stable order.
 *
 * Sorted by name rather than left in declaration order so that `tools/list`
 * answers identically across calls and across deployments. The MCP guidance frames
 * that as a prompt cache win; the reason that matters more here is that two
 * listings can be compared, and a difference means something actually changed.
 */
export function toolDefinitions(env: McpToolEnv): readonly ToolDefinition[] {
  return [policyLint(env), policyList(env), schemaDescribe(env), schemaList(env)].sort(
    (left, right) => left.name.localeCompare(right.name),
  );
}

export function registerTools(server: McpServer, env: McpToolEnv): void {
  for (const tool of toolDefinitions(env)) {
    server.registerTool(tool.name, tool.config, tool.handler);
  }
}

export type { McpToolEnv, ToolDefinition } from './types.js';
