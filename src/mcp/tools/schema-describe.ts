/**
 * The columns, indexes and foreign keys of one table.
 *
 * ## Three refusals that have to look identical
 *
 * A name can fail here for three different reasons: the table does not exist, it
 * is an engine table, or it is the identity provider's. Telling them apart maps
 * the database one call at a time, which is what invariant I5 is about, so all
 * three go through `resolveTable` and come back as the same 404 with the same
 * sentence.
 *
 * ⚠️ Reusing `resolveTable` rather than writing the check again is the point. The
 * V2 lesson was that collapsing the status and the message is not enough while any
 * field still distinguishes the cases, and the way to not repeat it is to have one
 * implementation rather than two that agree today.
 *
 * ## This is the first surface that publishes column names
 *
 * `/_schema` reports counts only, and the REST path returns just the columns a
 * policy grants. Reporting names is a deliberate widening: an agent cannot write
 * `{"author_id": {"_eq": "$auth.uid"}}` without knowing the column is called
 * `author_id`. It is widened for the operator's own credential, on the operator's
 * own database, and it stops at names: `hasDefault` is a boolean because the
 * default value itself can carry a tenant id or an internal URL.
 */

import { z } from 'zod';

import { getCatalogue, isReservedTableName } from '../../db/index.js';
import { resolveTable } from '../../rest/allowlist.js';
import { BaseclfError } from '../../utils/errors.js';
import { runTool } from './result.js';
import type { McpToolEnv, ToolDefinition } from './types.js';

const INPUT = z.object({
  table: z.string().describe('The table to describe. Must be an application table.'),
});

const OUTPUT = z.object({
  table: z.string(),
  columns: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      notNull: z.boolean(),
      primaryKey: z.boolean(),
      /** Whether a default exists. The value itself is never reported. */
      hasDefault: z.boolean(),
    }),
  ),
  indexes: z.array(
    z.object({ name: z.string(), unique: z.boolean(), columns: z.array(z.string()) }),
  ),
  foreignKeys: z.array(
    z.object({
      column: z.string(),
      referencesTable: z.string(),
      referencesColumn: z.string(),
    }),
  ),
});

export function schemaDescribe(env: McpToolEnv): ToolDefinition {
  return {
    name: 'schema_describe',
    config: {
      title: 'Describe a table',
      description:
        'Report the columns, indexes and foreign keys of one application table. ' +
        'A referencesColumn of "rowid" means the reference points at the target primary key. ' +
        'Engine tables cannot be described.',
      inputSchema: INPUT,
      outputSchema: OUTPUT,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (args) =>
      runTool(async () => {
        const { table } = INPUT.parse(args);
        const catalogue = await getCatalogue(env.DB);

        // Throws the one 404 for all three refusals. Second layer below, from the
        // name alone, for the reason invariant I8 gives.
        const name = resolveTable(catalogue, table);
        const info = catalogue.tables.get(name);
        if (info === undefined || info.isSystem || isReservedTableName(name)) {
          // ⚠️ Throws rather than answering with an empty table. An empty answer
          // is a fail-open dressed as an edge case: the caller learns the name
          // resolved, and a later reader sees a refusal that returns data.
          throw new BaseclfError('UNKNOWN_IDENTIFIER', 404, {
            message: 'Not found.',
            detail: `"${name}" is not an application table.`,
          });
        }

        return {
          table: name,
          columns: [...info.columns.values()].map((column) => ({
            name: column.name,
            type: column.type,
            notNull: column.notNull,
            primaryKey: column.primaryKey,
            hasDefault: column.hasDefault,
          })),
          indexes: info.indexes.map((index) => ({
            name: index.name,
            unique: index.unique,
            columns: [...index.columns],
          })),
          // ⚠️ A foreign key names a second table, so it is a way back to one the
          // caller may not address. Describing `posts` would otherwise report
          // `author_id -> user.id` and hand back the name the listing withholds.
          foreignKeys: info.foreignKeys
            .filter((key) => !isReservedTableName(key.referencesTable))
            .map((key) => ({
              column: key.column,
              referencesTable: key.referencesTable,
              referencesColumn: key.referencesColumn,
            })),
        };
      }),
  };
}
