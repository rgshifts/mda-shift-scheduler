import { entityKind } from "../entity.cjs";
import { Query } from "../sql/sql.cjs";
import { DrizzleTypeError } from "../utils.cjs";
import * as V1 from "../_relations.cjs";
import { AnyRelations, RelationalQueryMapperConfig } from "../relations.cjs";
import { Logger } from "../logger.cjs";
import { SQLiteSyncDialect } from "../sqlite-core/dialect.cjs";
import { PreparedQueryConfig, SQLiteExecuteMethod, SQLitePreparedQuery, SQLiteSession, SQLiteTransactionConfig } from "../sqlite-core/session.cjs";
import { SQLiteTransaction as SQLiteTransaction$1 } from "../sqlite-core/index.cjs";
import { SelectedFieldsOrdered } from "../sqlite-core/query-builders/select.types.cjs";
import { DatabaseSync, StatementResultingChanges, StatementSync } from "node:sqlite";

//#region src/node-sqlite/session.d.ts
interface NodeSQLiteSessionOptions {
  logger?: Logger;
  useJitMappers?: boolean;
}
type PreparedQueryConfig$1 = Omit<PreparedQueryConfig, 'statement' | 'run'>;
declare class NodeSQLiteSession<TFullSchema extends Record<string, unknown>, TRelations extends AnyRelations, TSchema extends V1.TablesRelationalConfig> extends SQLiteSession<'sync', StatementResultingChanges, TFullSchema, TRelations, TSchema> {
  private client;
  private relations;
  private schema;
  private options;
  static readonly [entityKind]: string;
  private logger;
  constructor(client: DatabaseSync, dialect: SQLiteSyncDialect, relations: TRelations, schema: V1.RelationalSchemaConfig<TSchema> | undefined, options?: NodeSQLiteSessionOptions);
  prepareQuery<T extends Omit<PreparedQueryConfig$1, 'run'>>(query: Query, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, customResultMapper: (rows: unknown[][]) => unknown): NodeSQLitePreparedQuery<T>;
  prepareRelationalQuery<T extends Omit<PreparedQueryConfig$1, 'run'>>(query: Query, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, customResultMapper: (rows: Record<string, unknown>[]) => unknown, config: RelationalQueryMapperConfig): NodeSQLitePreparedQuery<T, true>;
  transaction<T>(transaction: (tx: NodeSQLiteTransaction<TFullSchema, TRelations, TSchema>) => T, config?: SQLiteTransactionConfig): T;
}
declare class NodeSQLiteTransaction<TFullSchema extends Record<string, unknown>, TRelations extends AnyRelations, TSchema extends V1.TablesRelationalConfig> extends SQLiteTransaction$1<'sync', StatementResultingChanges, TFullSchema, TRelations, TSchema> {
  static readonly [entityKind]: string;
  transaction<T>(transaction: (tx: NodeSQLiteTransaction<TFullSchema, TRelations, TSchema>) => T extends Promise<any> ? DrizzleTypeError<"Sync drivers can't use async functions in transactions!"> : T): T;
}
declare class NodeSQLitePreparedQuery<T extends PreparedQueryConfig$1 = PreparedQueryConfig$1, TIsRqbV2 extends boolean = false> extends SQLitePreparedQuery<{
  type: 'sync';
  run: void;
  all: T['all'];
  get: T['get'];
  values: T['values'];
  execute: T['execute'];
}> {
  private stmt;
  private logger;
  private fields;
  private useJitMappers;
  private customResultMapper?;
  private isRqbV2Query?;
  private rqbConfig?;
  static readonly [entityKind]: string;
  private jitMapper?;
  constructor(stmt: StatementSync, query: Query, logger: Logger, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, useJitMappers: boolean | undefined, customResultMapper?: ((rows: TIsRqbV2 extends true ? Record<string, unknown>[] : unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown) | undefined, isRqbV2Query?: TIsRqbV2 | undefined, rqbConfig?: RelationalQueryMapperConfig | undefined);
  run(placeholderValues?: Record<string, unknown>): StatementResultingChanges;
  all(placeholderValues?: Record<string, unknown>): T['all'];
  private allRqbV2;
  get(placeholderValues?: Record<string, unknown>): T['get'];
  private getRqbV2;
  values(placeholderValues?: Record<string, unknown>): T['values'];
}
//#endregion
export { NodeSQLitePreparedQuery, NodeSQLiteSession, NodeSQLiteSessionOptions, NodeSQLiteTransaction };
//# sourceMappingURL=session.d.cts.map