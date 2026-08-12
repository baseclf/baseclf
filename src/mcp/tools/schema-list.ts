/**
 * What tables exist, and which of them the API will serve.
 *
 * ## The filter is the whole tool
 *
 * `getCatalogue` returns every table in the database, engine tables included, and
 * flags them rather than dropping them. So a consumer that forgets to filter
 * publishes `_policies`, `_exposed_tables`, and the identity provider's storage.
 * That is not hypothetical: `/_schema` shipped that way and served `user`,
 * `session`, `account`, `verification` and `jwks` to anybody who asked, until it
 * was measured on 2026-08-12.
 *
 * Both checks are here for the reason invariant I8 gives: `isSystem` is decided
 * when the catalogue is built, `isReservedTableName` is decided from the name, and
 * asking the same source twice is one check written twice.
 *
 * ## Why unexposed tables are listed
 *
 * A table with no policy is listed with `exposed: false` rather than hidden. An
 * agent asked to write a policy for `posts` has to be able to see `posts`, and
 * hiding it would leave probing as the only way to find out it is there. What the
 * flag prevents is exactly that probing: the answer is in the listing, so nothing
 * is learned by calling `schema_describe` in a loop.
 *
 * ⚠️ This differs from the REST path on purpose. There, an unexposed table is
 * indistinguishable from one that does not exist, because the caller is anonymous
 * and mapping the database is the attack. Here the caller holds the operator's
 * secret and owns the database.
 */

import { z } from 'zod';

import { getCatalogue, isReservedTableName } from '../../db/index.js';
import { getRegistry } from '../../policy/index.js';
import { runTool } from './result.js';
import type { McpToolEnv, ToolDefinition } from './types.js';

const OUTPUT = z.object({
  tables: z.array(
    z.object({
      name: z.string(),
      columns: z.number().int(),
      indexes: z.number().int(),
      /** True when a policy document exposes it, so `/rest/v1` will answer for it. */
      exposed: z.boolean(),
    }),
  ),
});

export function schemaList(env: McpToolEnv): ToolDefinition {
  return {
    name: 'schema_list',
    config: {
      title: 'List tables',
      description:
        'List the application tables in the database, with whether each one is exposed ' +
        'through the REST API. Engine tables are never listed.',
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
        // ⚠️ The registry is loaded even though only `exposed` needs it, and a
        // broken registry fails the whole call rather than dropping the field.
        // Answering without it would report every table as unexposed, which reads
        // as a fact rather than as a failure.
        const [catalogue, registry] = await Promise.all([
          getCatalogue(env.DB),
          getRegistry(env.DB),
        ]);

        const tables = [...catalogue.tables.values()]
          .filter((table) => !table.isSystem && !isReservedTableName(table.name))
          .map((table) => ({
            name: table.name,
            columns: table.columns.size,
            indexes: table.indexes.length,
            exposed: registry.definitions.get(table.name)?.enabled === true,
          }))
          // Sorted so repeated calls produce identical text. The MCP guidance is
          // about prompt cache hits; the reason worth more here is that a diff
          // between two calls then means something changed.
          .sort((left, right) => left.name.localeCompare(right.name));

        return { tables };
      }),
  };
}
