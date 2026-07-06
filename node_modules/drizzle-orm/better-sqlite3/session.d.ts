import { entityKind } from "../entity.js";
import { DrizzleTypeError } from "../utils.js";
import { Query } from "../sql/sql.js";
import { Logger } from "../logger.js";
import { Cache } from "../cache/core/index.js";
import * as V1 from "../_relations.js";
import { SQLiteSyncDialect } from "../sqlite-core/dialect.js";
import { AnyRelations, RelationalQueryMapperConfig } from "../relations.js";
import { SQLiteTransaction } from "../sqlite-core/index.js";
import { PreparedQueryConfig, SQLiteExecuteMethod, SQLitePreparedQuery, SQLiteSession, SQLiteTransactionConfig } from "../sqlite-core/session.js";
import { Database, RunResult, Statement } from "better-sqlite3";
import { WithCacheConfig } from "../cache/core/types.js";
import { SelectedFieldsOrdered } from "../sqlite-core/query-builders/select.types.js";

//#region src/better-sqlite3/session.d.ts
interface BetterSQLiteSessionOptions {
  logger?: Logger;
  cache?: Cache;
  useJitMappers?: boolean;
}
type PreparedQueryConfig$1 = Omit<PreparedQueryConfig, 'statement' | 'run'>;
declare class BetterSQLiteSession<TFullSchema extends Record<string, unknown>, TRelations extends AnyRelations, TSchema extends V1.TablesRelationalConfig> extends SQLiteSession<'sync', RunResult, TFullSchema, TRelations, TSchema> {
  private client;
  private relations;
  private schema;
  private options;
  static readonly [entityKind]: string;
  private logger;
  private cache;
  constructor(client: Database, dialect: SQLiteSyncDialect, relations: TRelations, schema: V1.RelationalSchemaConfig<TSchema> | undefined, options?: BetterSQLiteSessionOptions);
  prepareQuery<T extends Omit<PreparedQueryConfig$1, 'run'>>(query: Query, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, customResultMapper?: (rows: unknown[][]) => unknown, queryMetadata?: {
    type: 'select' | 'update' | 'delete' | 'insert';
    tables: string[];
  }, cacheConfig?: WithCacheConfig): PreparedQuery<T>;
  prepareRelationalQuery<T extends Omit<PreparedQueryConfig$1, 'run'>>(query: Query, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, customResultMapper: (rows: Record<string, unknown>[]) => unknown, config: RelationalQueryMapperConfig): PreparedQuery<T, true>;
  transaction<T>(transaction: (tx: BetterSQLiteTransaction<TFullSchema, TRelations, TSchema>) => T, config?: SQLiteTransactionConfig): T;
}
declare class BetterSQLiteTransaction<TFullSchema extends Record<string, unknown>, TRelations extends AnyRelations, TSchema extends V1.TablesRelationalConfig> extends SQLiteTransaction<'sync', RunResult, TFullSchema, TRelations, TSchema> {
  static readonly [entityKind]: string;
  transaction<T>(transaction: (tx: BetterSQLiteTransaction<TFullSchema, TRelations, TSchema>) => T extends Promise<any> ? DrizzleTypeError<"Sync drivers can't use async functions in transactions!"> : T): T;
}
declare class PreparedQuery<T extends PreparedQueryConfig$1 = PreparedQueryConfig$1, TIsRqbV2 extends boolean = false> extends SQLitePreparedQuery<{
  type: 'sync';
  run: RunResult;
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
  constructor(stmt: Statement, query: Query, logger: Logger, cache: Cache, queryMetadata: {
    type: 'select' | 'update' | 'delete' | 'insert';
    tables: string[];
  } | undefined, cacheConfig: WithCacheConfig | undefined, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, useJitMappers: boolean | undefined, customResultMapper?: ((rows: TIsRqbV2 extends true ? Record<string, unknown>[] : unknown[][]) => unknown) | undefined, isRqbV2Query?: TIsRqbV2 | undefined, rqbConfig?: RelationalQueryMapperConfig | undefined);
  run(placeholderValues?: Record<string, unknown>): RunResult;
  all(placeholderValues?: Record<string, unknown>): T['all'];
  get(placeholderValues?: Record<string, unknown>): T['get'];
  private allRqbV2;
  private getRqbV2;
  values(placeholderValues?: Record<string, unknown>): T['values'];
}
//#endregion
export { BetterSQLiteSession, BetterSQLiteSessionOptions, BetterSQLiteTransaction, PreparedQuery };
//# sourceMappingURL=session.d.ts.map