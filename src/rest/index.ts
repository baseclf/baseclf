export {
  ALIAS_PATTERN,
  columnReference,
  type FilterOperator,
  LIKE_ESCAPE_CHARACTER,
  resolveAlias,
  resolveColumn,
  resolveNullPlacement,
  resolveOperator,
  resolveSortDirection,
  resolveTable,
  SQL_COMPARISON,
  toLikePattern,
} from './allowlist.js';

export { type BuildInput, buildClientFilter, buildSelect } from './build.js';

export {
  assertIdentifiersAreReal,
  collectTableNames,
  type ExecuteOptions,
  type ExecuteResult,
  executeStatement,
  extractQuotedIdentifiers,
  type IdentifierScope,
} from './execute.js';

export {
  type ConditionNode,
  DEFAULT_PAGE_SIZE,
  type FilterNode,
  MAX_FILTER_DEPTH,
  MAX_FILTERS,
  MAX_IN_LIST_ITEMS,
  MAX_ORDER_ITEMS,
  MAX_PAGE_SIZE,
  MAX_QUERY_STRING_BYTES,
  MAX_SELECT_ITEMS,
  type OrderItem,
  type ParsedQuery,
  parseQueryString,
  type SelectItem,
} from './parse-query.js';

export {
  operationForMethod,
  REST_PREFIX,
  type ReadRequest,
  readTable,
  tableFromPath,
  type WriteRequestInput,
  writeTable,
} from './router.js';
