import { PgCodecs, PostgresType } from "./codecs.js";
import { PgMaterializedView, PgView } from "./view.js";
import { entityKind } from "../entity.js";
import { RowsMapperGenerator, UpdateSet } from "../utils.js";
import { CodecsCollection } from "../codecs.js";
import { Query, SQL } from "../sql/sql.js";
import { BuildRelationalQueryResult, DBQueryConfigWithComment, RelationalRowsMapperGenerator, TableRelationalConfig, TablesRelationalConfig } from "../relations.js";
import { PgDeleteConfig, PgInsertConfig, PgUpdateConfig } from "./query-builders/index.js";
import { PgTable } from "./table.js";
import { PgSelectConfig } from "./query-builders/select.types.js";

//#region src/pg-core/dialect.d.ts
interface PgDialectConfig {
  codecs?: PgCodecs;
  useJitMappers?: boolean;
}
declare class PgDialect {
  static readonly [entityKind]: string;
  readonly codecs: CodecsCollection<PostgresType>;
  readonly mapperGenerators: {
    rows: RowsMapperGenerator;
    relationalRows: RelationalRowsMapperGenerator;
  };
  constructor(config?: PgDialectConfig);
  escapeName(name: string): string;
  escapeParam(num: number): string;
  escapeString(str: string): string;
  private buildWithCTE;
  buildDeleteQuery({
    table,
    where,
    returning,
    withList,
    comment,
    ignoreSelectionCastCodecs
  }: PgDeleteConfig): SQL;
  buildUpdateSet(table: PgTable, set: UpdateSet): SQL;
  buildUpdateQuery({
    table,
    set,
    where,
    returning,
    withList,
    from,
    joins,
    comment,
    ignoreSelectionCastCodecs
  }: PgUpdateConfig): SQL;
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
  private buildJoins;
  private buildFromTable;
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
    comment,
    ignoreSelectionCastCodecs
  }: PgSelectConfig): SQL;
  buildSetOperations(leftSelect: SQL, setOperators: PgSelectConfig['setOperators']): SQL;
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
    setOperator: PgSelectConfig['setOperators'][number];
  }): SQL;
  buildInsertQuery({
    table,
    values: valuesOrSelect,
    onConflict,
    returning,
    withList,
    select,
    overridingSystemValue_,
    comment,
    ignoreSelectionCastCodecs
  }: PgInsertConfig): SQL;
  buildRefreshMaterializedViewQuery({
    view,
    concurrently,
    withNoData
  }: {
    view: PgMaterializedView;
    concurrently?: boolean;
    withNoData?: boolean;
  }): SQL;
  sqlToQuery(sql: SQL, invokeSource?: 'indexes' | undefined): Query;
  _sqlToQuery(sql: SQL): Query;
  private nestedSelectionerror;
  private buildRqbColumn;
  private resolveSelection;
  private unwrapAllColumns;
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
    throughJoin,
    nested
  }: {
    schema: TablesRelationalConfig;
    table: PgTable | PgView;
    tableConfig: TableRelationalConfig;
    queryConfig?: DBQueryConfigWithComment<'many'> | true;
    relationWhere?: SQL;
    mode: 'first' | 'many';
    errorPath?: string;
    depth?: number;
    throughJoin?: SQL;
    nested?: boolean;
  }): BuildRelationalQueryResult;
}
//#endregion
export { PgDialect, PgDialectConfig };
//# sourceMappingURL=dialect.d.ts.map