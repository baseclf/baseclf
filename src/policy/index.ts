export {
  type Assignment,
  compileCheck,
  type ResolvedWrite,
  resolveWrite,
} from './check-rewrite.js';
export {
  type Bindable,
  type CompileContext,
  combinePermissive,
  compilePredicate,
  jsonEachList,
  narrowWith,
} from './compile.js';

export { parseTableDefinition } from './parse.js';

export { applyPolicy, createPolicyPlugin, type PolicyPluginOptions } from './plugin.js';

export {
  getRegistry,
  loadRegistry,
  type PolicyMatch,
  type Registry,
  resetRegistry,
} from './registry.js';

export { POLICY_SCHEMA } from './schema.js';

export {
  ANONYMOUS,
  ANONYMOUS_ROLE,
  type AuthCtx,
  type ClaimRef,
  type CompareOperator,
  type ListExpr,
  type Literal,
  MAX_LIKE_PATTERN_BYTES,
  MAX_TRAVERSAL_DEPTH,
  OPERATIONS,
  type Operation,
  type PolicyDef,
  type Predicate,
  type TableDefinition,
  type ValueExpr,
} from './types.js';

export { validateTableDefinition } from './validate.js';

export {
  type BuiltWrite,
  buildWrite,
  type WriteOperation,
  type WriteRequest,
} from './write.js';
