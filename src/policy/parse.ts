/**
 * Untrusted JSON in, policy AST out.
 *
 * This file is the only place a policy document is interpreted. Everything it
 * accepts is a shape the compiler already knows how to emit safely; everything
 * else throws here rather than being carried further as a maybe.
 *
 * Two rules are enforced at this level because they need no knowledge of the
 * database:
 *
 *   - `$auth.user.*` is rejected outright (rule 00, invariant I4). It comes from
 *     `user_metadata`, which the end user can write, so a policy that read it
 *     would let anyone promote themselves. It must be impossible to store, not
 *     merely impossible to run.
 *   - A string beginning with `$` that is not a token we know is an error, never
 *     a literal. Silently treating `$auth.uidd` as the text "$auth.uidd" would
 *     turn a typo into a predicate that quietly matches nothing, or worse.
 *
 * Whether a column exists, and whether it can be NULL, is decided in
 * validate.ts, which has the catalogue.
 */

import { PolicyError } from '../utils/errors.js';
import {
  type ClaimRef,
  type CompareOperator,
  type ListExpr,
  type Literal,
  OPERATIONS,
  type Operation,
  type PolicyDef,
  type Predicate,
  type ServerSet,
  type TableDefinition,
  type ValueExpr,
} from './types.js';

/** Guards against a policy document nested deeply enough to be expensive to walk. */
const MAX_PREDICATE_DEPTH = 16;

/** How many `$bind` hops may be followed before we call it a cycle. */
const MAX_BIND_DEPTH = 8;

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

const COMPARE_OPERATORS: Readonly<Record<string, CompareOperator>> = Object.freeze({
  _eq: '_eq',
  _neq: '_neq',
  _gt: '_gt',
  _gte: '_gte',
  _lt: '_lt',
  _lte: '_lte',
});

const COLUMN_OPERATORS = new Set([...Object.keys(COMPARE_OPERATORS), '_in', '_is_null', '_like']);
const STRUCTURAL_OPERATORS = new Set(['_and', '_or', '_not', '_exists']);

function invalid(detail: string): PolicyError {
  // The message stays vague on purpose. Policy documents are authored through
  // an admin path, and `detail` is what reaches the log; a client that somehow
  // triggers this learns nothing about the schema.
  return new PolicyError('INVALID_EXPR', 400, {
    message: 'Policy document is not valid.',
    detail,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLiteral(value: unknown): value is Literal {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function soleKey(object: Record<string, unknown>, context: string): string {
  const keys = Object.keys(object);
  if (keys.length !== 1) {
    throw invalid(
      `${context} must hold exactly one key, found ${keys.length}. ` +
        'Combine conditions with an explicit _and rather than listing them side by side.',
    );
  }
  // Object.keys on a non-empty object always yields a first entry; the check
  // above proves the length, and this keeps noUncheckedIndexedAccess happy.
  return keys[0] as string;
}

/**
 * Turns a `$...` string into a claim or an outer-column reference.
 *
 * `$auth.role` is included even though the role also selects which policies
 * apply: comparing against it inside a predicate is legitimate.
 */
function parseToken(token: string): ValueExpr {
  if (token.startsWith('$auth.user.')) {
    throw new PolicyError('FORBIDDEN_CLAIM', 400, {
      message: 'Policies may not read user metadata.',
      detail:
        `Policy references "${token}". user_metadata is writable by the end user, so a policy ` +
        'that trusted it could be used to escalate privileges. Move the value to app_metadata ' +
        'and read it as $auth.app.* instead.',
    });
  }

  if (token === '$auth.uid') return { kind: 'claim', ref: { source: 'uid' } };
  if (token === '$auth.email') return { kind: 'claim', ref: { source: 'email' } };
  if (token === '$auth.role') return { kind: 'claim', ref: { source: 'role' } };

  if (token.startsWith('$auth.app.')) {
    const key = token.slice('$auth.app.'.length);
    if (!IDENTIFIER_PATTERN.test(key)) {
      throw invalid(`"${token}" has an app_metadata key that is not a plain identifier.`);
    }
    return { kind: 'claim', ref: { source: 'app', key } };
  }

  if (token.startsWith('$row.')) {
    const column = token.slice('$row.'.length);
    if (!IDENTIFIER_PATTERN.test(column)) {
      throw invalid(`"${token}" does not name a column.`);
    }
    return { kind: 'outerColumn', column };
  }

  throw invalid(
    `"${token}" is not a token this engine knows. Valid tokens are $auth.uid, $auth.email, ` +
      '$auth.role, $auth.app.<key> and $row.<column>. A value that should be the literal text ' +
      'cannot begin with $.',
  );
}

function parseValue(raw: unknown, context: string): ValueExpr {
  if (typeof raw === 'string' && raw.startsWith('$')) {
    return parseToken(raw);
  }
  if (isLiteral(raw)) {
    return { kind: 'literal', value: raw };
  }
  throw invalid(`${context} needs a literal or a token, received ${typeof raw}.`);
}

function parseClaimOnly(raw: unknown, context: string): ClaimRef {
  const parsed = parseValue(raw, context);
  if (parsed.kind !== 'claim') {
    throw invalid(`${context} needs a claim such as $auth.app.<key>.`);
  }
  return parsed.ref;
}

function parseList(raw: unknown, context: string): ListExpr {
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isLiteral(entry)) {
        throw invalid(`${context} may only contain literals.`);
      }
      if (typeof entry === 'string' && entry.startsWith('$')) {
        throw invalid(`${context} may not contain tokens; put the whole list in a claim instead.`);
      }
    }
    return { kind: 'literalList', values: raw as readonly Literal[] };
  }
  // A claim holding an array. One bound parameter regardless of length, because
  // it goes through json_each. Never expanded into IN (?,?,?).
  return { kind: 'claim', ref: parseClaimOnly(raw, context) };
}

interface ParseContext {
  /** Raw bind bodies, by name, as they appeared in the document. */
  readonly binds: Readonly<Record<string, unknown>>;
  /** Bind names currently being expanded, used to catch a cycle. */
  readonly expanding: readonly string[];
  readonly depth: number;
}

function deeper(context: ParseContext): ParseContext {
  if (context.depth + 1 > MAX_PREDICATE_DEPTH) {
    throw invalid(`Policy expression nests deeper than ${MAX_PREDICATE_DEPTH} levels.`);
  }
  return { ...context, depth: context.depth + 1 };
}

function parseColumnCondition(column: string, raw: unknown): Predicate {
  if (!IDENTIFIER_PATTERN.test(column)) {
    throw invalid(`"${column}" is not a usable column name.`);
  }
  if (!isPlainObject(raw)) {
    throw invalid(`Condition on "${column}" must be an object such as { "_eq": ... }.`);
  }

  const operator = soleKey(raw, `Condition on "${column}"`);
  const argument = raw[operator];

  if (!COLUMN_OPERATORS.has(operator)) {
    throw invalid(
      `"${operator}" is not an operator that applies to a column. ` +
        `Available: ${[...COLUMN_OPERATORS].sort().join(', ')}.`,
    );
  }

  const compare = COMPARE_OPERATORS[operator];
  if (compare !== undefined) {
    return {
      kind: 'compare',
      column,
      operator: compare,
      value: parseValue(argument, `"${column}" ${operator}`),
    };
  }

  if (operator === '_in') {
    return { kind: 'in', column, values: parseList(argument, `"${column}" _in`) };
  }

  if (operator === '_is_null') {
    if (typeof argument !== 'boolean') {
      throw invalid(`"${column}" _is_null takes true or false.`);
    }
    return { kind: 'isNull', column, expected: argument };
  }

  // _like. The pattern length is checked in the compiler, where a claim's value
  // is finally known; D1 rejects patterns over fifty bytes.
  return { kind: 'like', column, pattern: parseValue(argument, `"${column}" _like`) };
}

function parseOperandList(raw: unknown, operator: string, context: ParseContext): Predicate[] {
  if (!Array.isArray(raw)) {
    throw invalid(`${operator} takes an array of conditions.`);
  }
  if (raw.length === 0) {
    // An empty _and is vacuously true, which is a policy that grants everything
    // while looking like it grants nothing. An empty _or is vacuously false and
    // is almost always a mistake. Neither is worth allowing.
    throw invalid(
      `${operator} was given an empty array. Write "using": true if every row is meant to match.`,
    );
  }
  return raw.map((entry) => parsePredicate(entry, deeper(context)));
}

function parseExists(raw: unknown, context: ParseContext): Predicate {
  if (!isPlainObject(raw)) {
    throw invalid('_exists takes an object with _table and _where.');
  }

  const table = raw['_table'];
  const where = raw['_where'];

  if (typeof table !== 'string' || !IDENTIFIER_PATTERN.test(table)) {
    throw invalid('_exists needs a _table naming a table.');
  }
  if (where === undefined) {
    // Without a correlation this is "does the other table have any row at all",
    // which is never what someone means and leaks existence across tenants.
    throw invalid('_exists needs a _where. An uncorrelated EXISTS is not a permission check.');
  }

  return { kind: 'exists', table, where: parsePredicate(where, deeper(context)) };
}

function parseBindReference(name: unknown, context: ParseContext): Predicate {
  if (typeof name !== 'string' || !IDENTIFIER_PATTERN.test(name)) {
    throw invalid('$bind takes the name of a bind.');
  }
  if (!Object.hasOwn(context.binds, name)) {
    throw invalid(`$bind "${name}" is not defined on this table.`);
  }
  if (context.expanding.includes(name)) {
    throw invalid(`$bind "${name}" refers to itself, directly or through another bind.`);
  }
  if (context.expanding.length + 1 > MAX_BIND_DEPTH) {
    throw invalid(`$bind nesting is deeper than ${MAX_BIND_DEPTH} levels.`);
  }

  return parsePredicate(context.binds[name], {
    ...deeper(context),
    expanding: [...context.expanding, name],
  });
}

function parsePredicate(raw: unknown, context: ParseContext): Predicate {
  // The only way to say "every row", and it has to be written out. A missing
  // key never means this.
  if (raw === true) return { kind: 'all' };

  if (!isPlainObject(raw)) {
    throw invalid('A condition must be an object, or the literal true.');
  }

  const key = soleKey(raw, 'A condition');
  const argument = raw[key];

  if (key === '$bind') return parseBindReference(argument, context);

  if (key === '_and') {
    return { kind: 'and', operands: parseOperandList(argument, '_and', context) };
  }
  if (key === '_or') {
    return { kind: 'or', operands: parseOperandList(argument, '_or', context) };
  }
  if (key === '_not') {
    return { kind: 'not', operand: parsePredicate(argument, deeper(context)) };
  }
  if (key === '_exists') return parseExists(argument, context);

  if (key.startsWith('_')) {
    throw invalid(
      `"${key}" is not an operator. Column names beginning with an underscore cannot be used ` +
        `in a policy. Structural operators are: ${[...STRUCTURAL_OPERATORS].sort().join(', ')}.`,
    );
  }
  if (key.startsWith('$')) {
    throw invalid(`"${key}" is not a directive. Only $bind is available here.`);
  }

  return parseColumnCondition(key, argument);
}

function parseStringArray(raw: unknown, field: string, pattern: RegExp): readonly string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalid(`"${field}" must be a non-empty array.`);
  }
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string' || !pattern.test(entry)) {
      throw invalid(`"${field}" contains an entry that is not a plain identifier.`);
    }
    if (seen.has(entry)) {
      throw invalid(`"${field}" lists "${entry}" twice.`);
    }
    seen.add(entry);
  }
  return Object.freeze([...(raw as string[])]);
}

function parseOperation(raw: unknown): Operation {
  if (typeof raw !== 'string' || !OPERATIONS.includes(raw as Operation)) {
    throw invalid(`"for" must be one of ${OPERATIONS.join(', ')}.`);
  }
  return raw as Operation;
}

/**
 * `"set": { "author_id": "$auth.uid" }`.
 *
 * Values are claims or constants. `$row` is refused: there is no enclosing row
 * to be relative to, and a server-set value that depended on the row being
 * written would be circular.
 */
function parseServerSet(raw: unknown, policyName: string): readonly ServerSet[] {
  if (raw === undefined) return Object.freeze([]);
  if (!isPlainObject(raw)) {
    throw invalid(`Policy "${policyName}" has a "set" that is not an object.`);
  }

  const entries: ServerSet[] = [];
  for (const [column, value] of Object.entries(raw)) {
    if (!IDENTIFIER_PATTERN.test(column)) {
      throw invalid(`Policy "${policyName}" sets "${column}", which is not a column name.`);
    }
    const parsed = parseValue(value, `Policy "${policyName}" set "${column}"`);
    if (parsed.kind === 'outerColumn') {
      throw invalid(`Policy "${policyName}" cannot use $row in "set".`);
    }
    entries.push(Object.freeze({ column, value: parsed }));
  }

  return Object.freeze(entries);
}

function parsePolicy(raw: unknown, context: ParseContext): PolicyDef {
  if (!isPlainObject(raw)) throw invalid('Each policy must be an object.');

  const name = raw['name'];
  if (typeof name !== 'string' || !IDENTIFIER_PATTERN.test(name)) {
    throw invalid('Each policy needs a "name" that is a plain identifier.');
  }

  const operation = parseOperation(raw['for']);
  const roles = parseStringArray(raw['to'], 'to', ROLE_PATTERN);
  const columns = parseStringArray(raw['columns'], 'columns', IDENTIFIER_PATTERN);

  // "using" is required, including on insert, where it is the only sensible
  // reading of "which existing rows this policy is about" being irrelevant:
  // an insert policy states `true` and carries its condition in "check".
  // Making it required is the point. An absent predicate would have to default
  // to something, and every possible default is either "all rows" (a silent
  // hole) or "no rows" (a policy that does nothing while looking present).
  if (!Object.hasOwn(raw, 'using')) {
    throw invalid(
      `Policy "${name}" has no "using". Write it out, using true if every row is meant to match.`,
    );
  }

  const using = parsePredicate(raw['using'], context);
  const check = Object.hasOwn(raw, 'check') ? parsePredicate(raw['check'], context) : null;
  const set = parseServerSet(raw['set'], name);

  // A column cannot be both something the caller writes and something the
  // server writes. Whichever the engine picked, the other reading would be a
  // reasonable thing for a policy author to have believed.
  for (const entry of set) {
    if (columns.includes(entry.column)) {
      throw invalid(
        `Policy "${name}" lists "${entry.column}" in both "columns" and "set". ` +
          'A column is written by the caller or by the server, not by whichever runs first.',
      );
    }
  }

  if (set.length > 0 && (operation === 'select' || operation === 'delete')) {
    throw invalid(`Policy "${name}" has a "set", which a ${operation} policy cannot use.`);
  }

  return Object.freeze({ name, operation, roles, using, check, columns, set });
}

/**
 * Parse one table's policy document.
 *
 * `binds` are named predicates the policies may reuse; they are expanded in
 * place here so that nothing downstream has to resolve a name.
 */
export function parseTableDefinition(raw: unknown): TableDefinition {
  if (!isPlainObject(raw)) throw invalid('A policy document must be an object.');

  const table = raw['table'];
  if (typeof table !== 'string' || !IDENTIFIER_PATTERN.test(table)) {
    throw invalid('A policy document needs a "table".');
  }

  const rawBinds = raw['binds'];
  if (rawBinds !== undefined && !isPlainObject(rawBinds)) {
    throw invalid('"binds" must be an object.');
  }
  const binds = (rawBinds ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(binds)) {
    if (!IDENTIFIER_PATTERN.test(name)) {
      throw invalid(`Bind name "${name}" is not a plain identifier.`);
    }
  }

  const rawPolicies = raw['policies'];
  if (!Array.isArray(rawPolicies)) {
    throw invalid('"policies" must be an array.');
  }

  const context: ParseContext = { binds, expanding: [], depth: 0 };
  const policies = rawPolicies.map((entry) => parsePolicy(entry, context));

  const names = new Set<string>();
  for (const policy of policies) {
    if (names.has(policy.name)) {
      throw invalid(`Two policies on "${table}" are both named "${policy.name}".`);
    }
    names.add(policy.name);
  }

  const version = raw['version'];
  if (version !== undefined && (typeof version !== 'number' || !Number.isInteger(version))) {
    throw invalid('"version" must be an integer.');
  }

  return Object.freeze({
    table,
    // Anything other than an explicit true leaves the table unexposed.
    enabled: raw['enabled'] === true,
    version: version ?? 0,
    policies: Object.freeze(policies),
  });
}
