export {
  batch,
  createDb,
  D1Dialect,
  type D1Executor,
  execute,
} from './dialect.js';

export {
  assertExecutable,
  assertParameterBudget,
  assertPlaceholdersMatchParameters,
  assertSingleStatement,
  assertStatementLength,
  blankQuotedRegions,
  type CompiledStatement,
  countBoundVariables,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_BYTES,
} from './guards.js';

export {
  AUTH_TABLES,
  type Catalogue,
  type ColumnInfo,
  type ForeignKeyInfo,
  getCatalogue,
  type IndexInfo,
  introspect,
  isReservedTableName,
  resetCatalogue,
  SYSTEM_TABLE_PREFIX,
  type TableInfo,
} from './introspect.js';
