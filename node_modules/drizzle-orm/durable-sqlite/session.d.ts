import { entityKind } from "../entity.js";
import { DrizzleTypeError } from "../utils.js";
import { Query } from "../sql/sql.js";
import { Logger } from "../logger.js";
import * as V1 from "../_relations.js";
import { AnyRelations, RelationalQueryMapperConfig } from "../relations.js";
import { SQLiteSyncDialect, SQLiteTransaction } from "../sqlite-core/index.js";
import { PreparedQueryConfig, SQLiteExecuteMethod, SQLitePreparedQuery, SQLiteSession, SQLiteTransactionConfig } from "../sqlite-core/session.js";
import { SelectedFieldsOrdered } from "../sqlite-core/query-builders/select.types.js";

//#region src/durable-sqlite/session.d.ts
interface SQLiteDOSessionOptions {
  logger?: Logger;
  useJitMappers?: boolean;
}
type PreparedQueryConfig$1 = Omit<PreparedQueryConfig, 'statement' | 'run'>;
declare class SQLiteDOSession<TFullSchema extends Record<string, unknown>, TRelations extends AnyRelations, TSchema extends V1.TablesRelationalConfig> extends SQLiteSession<'sync', SqlStorageCursor<Record<string, SqlStorageValue>>, TFullSchema, TRelations, TSchema> {
  private client;
  private relations;
  private schema;
  private options;
  static readonly [entityKind]: string;
  private logger;
  constructor(client: DurableObjectStorage, dialect: SQLiteSyncDialect, relations: TRelations, schema: V1.RelationalSchemaConfig<TSchema> | undefined, options?: SQLiteDOSessionOptions);
  prepareQuery<T extends Omit<PreparedQueryConfig$1, 'run'>>(query: Query, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, customResultMapper?: (rows: unknown[][]) => unknown): SQLiteDOPreparedQuery<T>;
  prepareRelationalQuery<T extends Omit<PreparedQueryConfig$1, 'run'>>(query: Query, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, customResultMapper: (rows: Record<string, unknown>[]) => unknown, config: RelationalQueryMapperConfig): SQLiteDOPreparedQuery<T, true>;
  transaction<T>(transaction: (tx: SQLiteTransaction<'sync', SqlStorageCursor<Record<string, SqlStorageValue>>, TFullSchema, TRelations, TSchema>) => T, _config?: SQLiteTransactionConfig): T;
}
declare class SQLiteDOTransaction<TFullSchema extends Record<string, unknown>, TRelations extends AnyRelations, TSchema extends V1.TablesRelationalConfig> extends SQLiteTransaction<'sync', SqlStorageCursor<Record<string, SqlStorageValue>>, TFullSchema, TRelations, TSchema> {
  static readonly [entityKind]: string;
  transaction<T>(transaction: (tx: SQLiteDOTransaction<TFullSchema, TRelations, TSchema>) => T extends Promise<any> ? DrizzleTypeError<"Sync drivers can't use async functions in transactions!"> : T): T;
}
declare class SQLiteDOPreparedQuery<T extends PreparedQueryConfig$1 = PreparedQueryConfig$1, TIsRqbV2 extends boolean = false> extends SQLitePreparedQuery<{
  type: 'sync';
  run: void;
  all: T['all'];
  get: T['get'];
  values: T['values'];
  execute: T['execute'];
}> {
  private client;
  private logger;
  private fields;
  private useJitMappers;
  private customResultMapper?;
  private isRqbV2Query?;
  private rqbConfig?;
  static readonly [entityKind]: string;
  private jitMapper?;
  constructor(client: DurableObjectStorage, query: Query, logger: Logger, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, useJitMappers: boolean | undefined, customResultMapper?: ((rows: TIsRqbV2 extends true ? Record<string, unknown>[] : unknown[][]) => unknown) | undefined, isRqbV2Query?: TIsRqbV2 | undefined, rqbConfig?: RelationalQueryMapperConfig | undefined);
  run(placeholderValues?: Record<string, unknown>): SqlStorageCursor<Record<string, SqlStorageValue>>;
  all(placeholderValues?: Record<string, unknown>): T['all'];
  private allRqbV2;
  get(placeholderValues?: Record<string, unknown>): T['get'];
  private getRqbV2;
  values(placeholderValues?: Record<string, unknown>): T['values'];
}
//#endregion
export { SQLiteDOPreparedQuery, SQLiteDOSession, SQLiteDOSessionOptions, SQLiteDOTransaction };
//# sourceMappingURL=session.d.ts.map