/**
 * Which tables are exposed, and what each policy grants.
 *
 * ## What this deliberately does not return: the predicates
 *
 * A `using` expression is not only structure. `{"tenant_id": {"_eq": "acme-prod-42"}}`
 * is a legal policy, and the literal in it is a real value from the operator's
 * business. So are org ids, allowlisted email domains, and feature flag strings.
 *
 * ⚠️ Invariant I9 does not cover this, and that is worth stating rather than
 * assuming. I9 is about bound parameters at query time. These values were baked
 * into a policy document when somebody wrote it and travel out through an entirely
 * different door. The invariant set has a gap here, and this tool is the first
 * thing that would have walked through it.
 *
 * Predicates also name columns the REST path never returns: a policy can filter on
 * `deleted_at` or `is_internal` while granting only `id` and `title`. And an
 * `_exists` names a second table, which is frequently a join table nobody exposed.
 *
 * So the answer is the shape of the grant and not its contents: who, which
 * operation, which columns, enabled or not. An agent reasoning about "can an anon
 * caller read this table" has what it needs. An agent that needs the predicate
 * reads the policy document in the repository, which is where `skills/mcp-server`
 * section 8 puts authoring anyway: MCP for runtime, files for authoring.
 *
 * ⚠️ This is a judgement call, not a measurement. If it turns out agents cannot do
 * useful work without predicates, the way back is an explicit `include_expressions`
 * argument, so that publishing them is a decision the operator makes per call
 * rather than a default sitting in every transcript.
 */

import { z } from 'zod';

import { isReservedTableName } from '../../db/index.js';
import { getRegistry } from '../../policy/index.js';
import { runTool } from './result.js';
import type { McpToolEnv, ToolDefinition } from './types.js';

const OUTPUT = z.object({
  tables: z.array(
    z.object({
      table: z.string(),
      enabled: z.boolean(),
      version: z.number().int(),
      policies: z.array(
        z.object({
          name: z.string(),
          operation: z.string(),
          roles: z.array(z.string()),
          columns: z.array(z.string()),
          /** Whether the policy carries a WITH CHECK predicate for the post-image. */
          hasCheck: z.boolean(),
          /** Columns the server fills in itself, which a caller can never write. */
          serverSet: z.array(z.string()),
        }),
      ),
    }),
  ),
});

export function policyList(env: McpToolEnv): ToolDefinition {
  return {
    name: 'policy_list',
    config: {
      title: 'List policies',
      description:
        'List the exposed tables and the shape of each policy: operation, roles, granted ' +
        'columns, whether it has a WITH CHECK, and which columns the server sets. ' +
        'Predicates are not returned; read the policy document for those.',
      inputSchema: z.object({}),
      outputSchema: OUTPUT,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: () =>
      runTool(async () => {
        const registry = await getRegistry(env.DB);

        const tables = [...registry.definitions.values()]
          // The loader already drops these, so this is the second independent
          // check invariant I8 asks for rather than the only one.
          .filter((definition) => !isReservedTableName(definition.table))
          .map((definition) => ({
            table: definition.table,
            // ⚠️ Reported rather than filtered. A disabled table is configuration
            // somebody chose, and hiding it makes "no policy" and "switched off"
            // look the same to the one caller entitled to tell them apart.
            enabled: definition.enabled,
            version: definition.version,
            policies: definition.policies
              .map((policy) => ({
                name: policy.name,
                operation: policy.operation,
                roles: [...policy.roles],
                columns: [...policy.columns],
                hasCheck: policy.check !== null,
                serverSet: policy.set.map((entry) => entry.column),
              }))
              .sort((left, right) => left.name.localeCompare(right.name)),
          }))
          .sort((left, right) => left.table.localeCompare(right.table));

        return { tables };
      }),
  };
}
