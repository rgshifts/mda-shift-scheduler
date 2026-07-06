import { MySqlDeleteConfig } from "./query-builders/delete.js";
import { MySqlTable } from "./table.js";
import { MySqlUpdateConfig } from "./query-builders/update.js";
import { MySqlInsertConfig } from "./query-builders/insert.js";
import { MySqlView } from "./view.js";
import { MySqlSession } from "./session.js";
import { MySqlSelectConfig } from "./query-builders/select.types.js";
import { entityKind } from "../entity.js";
import { RowsMapperGenerator, UpdateSet, make$ReturningResponseMapper } from "../utils.js";
import { Query, SQL } from "../sql/sql.js";
import { MigrationConfig, MigrationMeta, MigratorInitFailResponse } from "../migrator.js";
import { BuildRelationalQueryResult, DBQueryConfigWithComment, RelationalRowsMapperGenerator, TableRelationalConfig, TablesRelationalConfig } from "../relations.js";

//#region src/mysql-core/dialect.d.ts
interface MySqlDialectConfig {
  escapeParam?: (num: number) => string;
  useJitMappers?: boolean;
}
declare class MySqlDialect {
  static readonly [entityKind]: string;
  readonly mapperGenerators: {
    rows: RowsMapperGenerator;
    relationalRows: RelationalRowsMapperGenerator;
    $returning: typeof make$ReturningResponseMapper;
  };
  constructor(config?: MySqlDialectConfig);
  migrate(migrations: MigrationMeta[], session: MySqlSession, config: Omit<MigrationConfig, 'migrationsSchema'>): Promise<void | MigratorInitFailResponse>;
  escapeName(name: string): string;
  escapeParam(_num: number): string;
  escapeString(str: string): string;
  private buildWithCTE;
  buildDeleteQuery({
    table,
    where,
    returning,
    withList,
    limit,
    orderBy,
    comment
  }: MySqlDeleteConfig): SQL;
  buildUpdateSet(table: MySqlTable, set: UpdateSet): SQL;
  buildUpdateQuery({
    table,
    set,
    where,
    returning,
    withList,
    limit,
    orderBy,
    comment
  }: MySqlUpdateConfig): SQL;
  /**
   * Builds selection SQL with provided fields/expressions
   *
   * Examples:
   *
   * `select <selection> from`
   *
   * `insert ... returning <selection>`
   *
   * If `isSingleTable` is true, then columns won't be prefixed with table name
   */
  private buildSelection;
  private buildLimit;
  private buildOrderBy;
  private buildIndex;
  buildSelectQuery({
    withList,
    fields,
    fieldsFlat,
    where,
    having,
    table,
    joins,
    orderBy,
    groupBy,
    limit,
    offset,
    lockingClause,
    distinct,
    setOperators,
    useIndex,
    forceIndex,
    ignoreIndex,
    comment
  }: MySqlSelectConfig): SQL;
  buildSetOperations(leftSelect: SQL, setOperators: MySqlSelectConfig['setOperators']): SQL;
  buildSetOperationQuery({
    leftSelect,
    setOperator: {
      type,
      isAll,
      rightSelect,
      limit,
      orderBy,
      offset
    }
  }: {
    leftSelect: SQL;
    setOperator: MySqlSelectConfig['setOperators'][number];
  }): SQL;
  buildInsertQuery({
    table,
    values: valuesOrSelect,
    ignore,
    onConflict,
    select,
    comment
  }: MySqlInsertConfig): {
    sql: SQL;
    generatedIds: Record<string, unknown>[];
  };
  sqlToQuery(sql: SQL, invokeSource?: 'indexes' | undefined): Query;
  private nestedSelectionerror;
  private buildRqbColumn;
  private unwrapAllColumns;
  private getSelectedTableColumns;
  private buildColumns;
  buildRelationalQuery({
    schema,
    table,
    tableConfig,
    queryConfig: config,
    relationWhere,
    mode,
    errorPath,
    depth,
    isNestedMany,
    throughJoin,
    nested
  }: {
    schema: TablesRelationalConfig;
    table: MySqlTable | MySqlView;
    tableConfig: TableRelationalConfig;
    queryConfig?: DBQueryConfigWithComment<'many'> | true;
    relationWhere?: SQL;
    mode: 'first' | 'many';
    errorPath?: string;
    depth?: number;
    isNestedMany?: boolean;
    throughJoin?: SQL;
    nested?: boolean;
  }): BuildRelationalQueryResult;
}
//#endregion
export { MySqlDialect, MySqlDialectConfig };
//# sourceMappingURL=dialect.d.ts.map