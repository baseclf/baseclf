/**
 * Policy problems that cost money or fail quietly.
 *
 * D1 bills by rows scanned rather than rows returned, so a policy filtering on an
 * unindexed column is a full scan on every request, charged every time. That is
 * why the lint exists at all, and why `remedy` carries a ready `CREATE INDEX`.
 *
 * ## The leak this tool has to filter, which is not obvious
 *
 * A finding does not have to be about the table being linted. A policy reaching
 * through `_exists` into `memberships` produces a finding whose `table` is
 * `memberships`, and a join table is usually the least exposed thing in the
 * database. So linting a table the caller may address can hand back the name of
 * one they may not, along with a `CREATE INDEX` naming its columns.
 *
 * ⚠️ It is an indirect channel: nobody asked about `memberships`, and the answer
 * mentions it anyway. Findings about a reserved table are dropped, and the count
 * of what was dropped is reported rather than silently swallowed, because a lint
 * that quietly returns less than it found reads as a clean bill of health.
 */

import { z } from 'zod';

import { getCatalogue, isReservedTableName } from '../../db/index.js';
import { getRegistry, lintTable } from '../../policy/index.js';
import { runTool } from './result.js';
import type { McpToolEnv, ToolDefinition } from './types.js';

const OUTPUT = z.object({
  findings: z.array(
    z.object({
      code: z.string(),
      table: z.string(),
      /** Qualified as `table.policy`, so a finding is readable on its own. */
      policy: z.string(),
      detail: z.string(),
      remedy: z.string().optional(),
    }),
  ),
  /**
   * Findings withheld because they name a table the caller may not address.
   *
   * ⚠️ Reported on purpose. A lint that drops results without saying so is a lint
   * that reads as "nothing to fix".
   */
  withheld: z.number().int(),
});

export function policyLint(env: McpToolEnv): ToolDefinition {
  return {
    name: 'policy_lint',
    config: {
      title: 'Lint policies',
      description:
        'Report policy problems: columns used in a predicate with no index, which D1 ' +
        'bills as a full scan on every request; negation on a nullable column; and ' +
        'predicates wide enough to risk the expression depth limit.',
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
        const [catalogue, registry] = await Promise.all([
          getCatalogue(env.DB),
          getRegistry(env.DB),
        ]);

        const all = [...registry.definitions.values()]
          .filter((definition) => !isReservedTableName(definition.table))
          .flatMap((definition) =>
            lintTable(catalogue, definition).map((finding) => ({
              code: finding.code,
              table: finding.table,
              // The engine reports a bare policy name because it lints one table
              // at a time. Across tables that is ambiguous, so it is qualified
              // here the same way the CLI qualifies it.
              policy: `${definition.table}.${finding.policy}`,
              detail: finding.detail,
              ...(finding.remedy === undefined ? {} : { remedy: finding.remedy }),
            })),
          );

        const findings = all.filter((finding) => !isReservedTableName(finding.table));

        return {
          findings: findings.sort((left, right) =>
            `${left.policy}${left.code}`.localeCompare(`${right.policy}${right.code}`),
          ),
          withheld: all.length - findings.length,
        };
      }),
  };
}
