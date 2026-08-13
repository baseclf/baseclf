/**
 * What a request would compile to, without running it.
 *
 * This is the tool no other MCP server has, and the reason is that no other one
 * has row-level security to simulate. An agent writing a policy has, until now,
 * had exactly one way to find out whether it does what it meant: write it, apply
 * it, and read a table with real data in it. That is a slow loop, and on a
 * production database it is a loop with a blast radius.
 *
 * ## The write paths are the ones worth having
 *
 * A read compiles to a WHERE and is fairly easy to reason about by eye. An
 * update does not. SQLite has no WITH CHECK and D1 has no interactive
 * transaction, so the condition on the row as it will be is compiled by
 * rewriting every column reference in the check into its post-image, and the
 * result is a statement whose safety is not obvious from reading the policy that
 * produced it. The question an author actually has is "can somebody hand a row
 * to another user with this", and the answer lives in whether one term compiled
 * to `"posts"."author_id" = ?` or to `? = ?`. That is what this prints.
 *
 * ## It never runs anything
 *
 * The statement is built through the same path a real request takes and then
 * handed to `prepareStatement`, which compiles and checks it. `executeStatement`
 * is the function that would send it to D1, and it is deliberately not called
 * here. So the synthetic identity below cannot read or change a row: not because
 * a check forbids it, but because nothing in this file is capable of it.
 *
 * That also settles what the claims argument is. It is a *hypothesis*, not a
 * credential, and it never has to be trusted, because the only thing it can
 * affect is the text of a statement nobody executes.
 *
 * ⚠️ `AuthCtx` carries `role`, `uid`, `email` and `app`, and no `user` field
 * exists on it at all. Invariant I4 forbids `user_metadata` in a policy, and on
 * this path it is satisfied by the type rather than by a check: there is no shape
 * a caller could send that would put user-controlled metadata into a predicate.
 *
 * ## What it reports, and the one thing it withholds
 *
 * 🔴 Every value in a policy is a bound parameter, which invariant I7 requires
 * for other reasons entirely and which turns out to be exactly the seam this tool
 * needs. The SQL carries structure and identifiers; the parameters carry the
 * literals the policy author wrote, which is where a tenant id or an allowlisted
 * domain lives. So the two can be reported separately, and they are.
 *
 * The SQL is reported by default. It names application tables and columns, which
 * is the same class of information `schema_describe` already publishes to this
 * same caller, holding this same credential, about this same database. The write
 * paths add nothing to that class: the policy names come from `policy_list` and
 * the returned columns from `schema_describe`.
 *
 * The parameter values are withheld by default and returned only when the caller
 * passes `includeParameterValues`. That is the escape hatch `policy_list` was
 * documented as needing: publishing the literals stays a decision the operator
 * makes per call, rather than a default that quietly lands in every transcript.
 * `parametersWithheld` says so out loud, because a tool that returns less than it
 * has without mentioning it is the same failure `policy_lint` avoids by counting.
 *
 * ⚠️ On a write the values also include whatever `body` the caller passed in,
 * which is theirs already, and the server-set columns resolved from the synthetic
 * claims, which are also theirs. Nothing from a stored row can appear: no row is
 * ever read.
 *
 * ## What it does not do
 *
 * No lint findings. `policy_lint` already answers that, with a reserved-table
 * filter that had to be tested; a second copy here would be a second thing to
 * keep in step, which is the shape invariant I8 was just re-learned through.
 */

import { z } from 'zod';

import { getCatalogue, isReservedTableName } from '../../db/index.js';
import type { Catalogue } from '../../db/introspect.js';
import type { AuthCtx } from '../../policy/index.js';
import { applyPolicy, getRegistry } from '../../policy/index.js';
import type { Registry } from '../../policy/registry.js';
import { buildWrite, type WriteOperation } from '../../policy/write.js';
import { resolveTable } from '../../rest/allowlist.js';
import { buildClientFilter, buildSelect } from '../../rest/build.js';
import { prepareStatement } from '../../rest/execute.js';
import { parseQueryString, type SelectItem } from '../../rest/parse-query.js';
import { BaseclfError } from '../../utils/errors.js';
import { runTool } from './result.js';
import type { McpToolEnv, ToolDefinition } from './types.js';

const OPERATIONS = ['select', 'insert', 'update', 'delete'] as const;

const INPUT = z.object({
  table: z.string().describe('The application table to simulate against.'),
  role: z
    .string()
    .describe('The role to simulate, as it would arrive in the JWT. For example "anon".'),
  operation: z
    .enum(OPERATIONS)
    .optional()
    .describe('Which request to simulate. Defaults to "select".'),
  claims: z
    .object({
      uid: z.string().nullable().optional().describe('Stands in for $auth.uid.'),
      email: z.string().nullable().optional().describe('Stands in for $auth.email.'),
      app: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Stands in for app_metadata, read as $auth.app.*. Never user_metadata.'),
    })
    .optional()
    .describe('A hypothetical identity. Nothing is executed, so nothing is trusted.'),
  body: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'The row a caller would send, for insert and update. Columns the policy does not ' +
        'grant are refused here exactly as they would be in a real request.',
    ),
  query: z
    .string()
    .optional()
    .describe(
      'A PostgREST query string, without the leading "?". For example ' +
        '"status=eq.draft&select=id,title". Filters narrow a select, update or delete, ' +
        'and are refused on an insert because there is no existing row to filter.',
    ),
  includeParameterValues: z
    .boolean()
    .optional()
    .describe(
      'Return the bound parameter values as well as the SQL. Off by default: the values ' +
        'carry literals the policy author wrote, such as tenant ids.',
    ),
});

const OUTPUT = z.object({
  table: z.string(),
  operation: z.enum(OPERATIONS),
  role: z.string(),
  /** The statement D1 would receive, with a placeholder for every value. */
  sql: z.string(),
  parameterCount: z.number().int(),
  /** Present only when the caller asked for it. */
  parameters: z.array(z.unknown()).optional(),
  /** True when there were values and they were not returned. Never silent. */
  parametersWithheld: z.boolean(),
  /**
   * The policies that let this request through, combined with OR.
   *
   * This is the answer to "why would this be allowed", which is the question a
   * policy author actually has.
   */
  policies: z.array(z.string()),
  /**
   * What comes back: the columns a select reads, or the ones RETURNING hands
   * back on a write.
   */
  columns: z.array(z.string()),
});

interface Simulation {
  readonly node: Parameters<typeof prepareStatement>[0]['node'];
  readonly aliases: ReadonlySet<string>;
  readonly policies: readonly string[];
  readonly columns: readonly string[];
}

interface Scope {
  readonly catalogue: Catalogue;
  readonly registry: Registry;
  readonly auth: AuthCtx;
  readonly table: string;
  readonly query: string | undefined;
}

/**
 * The read path with the database taken out, in the order `readTable` runs it.
 *
 * Anything that reimplemented a step would be simulating itself rather than the
 * engine; the agreement tests in tools.test.ts are what keep that honest.
 */
function simulateRead(scope: Scope): Simulation {
  const { catalogue, registry, auth, table } = scope;
  const parsed = parseQueryString(new URLSearchParams(scope.query ?? ''));

  const columns: readonly SelectItem[] =
    parsed.select ??
    registry
      .resolve(table, 'select', auth.role, null)
      .columns.map((column) => ({ column, alias: null }));

  const node = buildSelect({ catalogue, table, parsed, columns });
  // Throws when no policy covers this pair. Fail-closed here is not a copy of
  // the real path's fail-closed, it is the same code reaching the same
  // conclusion, which is the only version worth simulating.
  const policied = applyPolicy(node, { registry, catalogue, auth, operation: 'select' });

  const aliases = new Set<string>();
  for (const item of columns) {
    if (item.alias !== null) aliases.add(item.alias);
  }

  // Resolved again to report which policies matched. Safe to ask separately
  // because `selectedColumns` unwraps an alias to the column underneath, so this
  // asks the question with the same column set the transformer used.
  const match = registry.resolve(
    table,
    'select',
    auth.role,
    columns.map((item) => item.column),
  );

  return {
    node: policied,
    aliases,
    policies: match.policies.map((policy) => policy.name),
    columns: [...match.columns],
  };
}

/** The write path with the database taken out, in the order `writeTable` runs it. */
function simulateWrite(
  scope: Scope,
  operation: WriteOperation,
  body: ReadonlyMap<string, unknown>,
): Simulation {
  const { catalogue, registry, auth, table } = scope;
  const parsed = parseQueryString(new URLSearchParams(scope.query ?? ''));

  // Refused rather than dropped, the same way the router refuses it. A filter
  // that is silently ignored reads, to the caller, exactly like one that was
  // applied, and here that would mean simulating a statement nobody would send.
  if (operation === 'insert' && parsed.filters.length > 0) {
    throw new BaseclfError('UNSUPPORTED_QUERY', 400, {
      message: 'An insert does not take a filter.',
    });
  }

  const filter = operation === 'insert' ? null : buildClientFilter(catalogue, table, parsed);

  const built = buildWrite({ registry, catalogue, auth, table, operation, body, filter });

  return {
    node: built.node,
    // A write names no aliases: RETURNING hands back real columns.
    aliases: new Set(),
    policies: built.policies.map((policy) => policy.name),
    columns: [...built.columns],
  };
}

export function policySimulate(env: McpToolEnv): ToolDefinition {
  return {
    name: 'policy_simulate',
    config: {
      title: 'Simulate a request',
      description:
        'Compile the statement a request would produce under a hypothetical identity, without ' +
        'running it and without touching any data. Works for select, insert, update and ' +
        'delete. Reports the SQL, how many parameters it binds, which policies matched, and ' +
        'which columns come back. On an update the WITH CHECK term shows whether the policy ' +
        'lets a row change owner. Parameter values are withheld unless asked for. A table ' +
        'with no policy for the role is refused, exactly as a real request would be.',
      inputSchema: INPUT,
      outputSchema: OUTPUT,
      // ⚠️ Still read-only, and still not destructive, even though three of the
      // four operations it simulates are writes. The annotation is about what
      // this tool does, not about what it describes: it compiles a statement and
      // stops. Nothing here can change a row, which the test counting statements
      // sent to D1 is what actually holds, since an annotation is a hint to a
      // client rather than an enforcement of anything.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (args) =>
      runTool(async () => {
        const input = INPUT.parse(args);
        const [catalogue, registry] = await Promise.all([
          getCatalogue(env.DB),
          getRegistry(env.DB),
        ]);

        // The same three refusals collapsed into one, for the reason invariant I5
        // gives, and the same second layer from the name alone that invariant I8
        // asks for. Written the way `schema_describe` writes it, because a caller
        // must not be able to tell this tool's refusals from that one's either.
        const table = resolveTable(catalogue, input.table);
        const info = catalogue.tables.get(table);
        if (info === undefined || info.isSystem || isReservedTableName(table)) {
          throw new BaseclfError('UNKNOWN_IDENTIFIER', 404, {
            message: 'Not found.',
            detail: `"${table}" is not an application table.`,
          });
        }

        const auth: AuthCtx = {
          role: input.role,
          uid: input.claims?.uid ?? null,
          email: input.claims?.email ?? null,
          app: input.claims?.app ?? {},
        };

        const operation = input.operation ?? 'select';
        const scope: Scope = { catalogue, registry, auth, table, query: input.query };

        const simulation =
          operation === 'select'
            ? simulateRead(scope)
            : simulateWrite(scope, operation, new Map(Object.entries(input.body ?? {})));

        // Compiles and runs every guard: identifiers against the catalogue, the
        // hundred parameter ceiling, placeholder agreement, statement length.
        // ⚠️ `prepareStatement` and not `executeStatement`. That one word is the
        // difference between a simulator and a request.
        const compiled = prepareStatement({
          node: simulation.node,
          catalogue,
          scope: { aliases: new Set(simulation.aliases) },
        });

        const withheld = input.includeParameterValues !== true && compiled.parameters.length > 0;

        return {
          table,
          operation,
          role: auth.role,
          sql: compiled.sql,
          parameterCount: compiled.parameters.length,
          ...(input.includeParameterValues === true
            ? { parameters: [...compiled.parameters] }
            : {}),
          parametersWithheld: withheld,
          policies: [...simulation.policies],
          columns: [...simulation.columns],
        };
      }),
  };
}
