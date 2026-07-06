import { SQLiteCloudRunResult } from "./driver.cjs";
import { entityKind } from "../entity.cjs";
import { Query, SQL } from "../sql/sql.cjs";
import * as V1 from "../_relations.cjs";
import { AnyRelations, RelationalQueryMapperConfig } from "../relations.cjs";
import { WithCacheConfig } from "../cache/core/types.cjs";
import { Logger } from "../logger.cjs";
import { SQLiteAsyncDialect } from "../sqlite-core/dialect.cjs";
import { PreparedQueryConfig, Result, SQLiteExecuteMethod, SQLitePreparedQuery, SQLiteSession, SQLiteTransactionConfig } from "../sqlite-core/session.cjs";
import { Cache } from "../cache/core/index.cjs";
import { SQLiteTransaction as SQLiteTransaction$1 } from "../sqlite-core/index.cjs";
import { SelectedFieldsOrdered } from "../sqlite-core/query-builders/select.types.cjs";
import { Database } from "@sqlitecloud/drivers";

//#region src/sqlite-cloud/session.d.ts
interface SQLiteCloudSessionOptions {
  logger?: Logger;
  cache?: Cache;
  useJitMappers?: boolean;
}
type PreparedQueryConfig$1 = Omit<PreparedQueryConfig, 'statement' | 'run'>;
declare class SQLiteCloudSession<TFullSchema extends Record<string, unknown>, TRelations extends AnyRelations, TSchema extends V1.TablesRelationalConfig> extends SQLiteSession<'async', SQLiteCloudRunResult, TFullSchema, TRelations, TSchema> {
  private client;
  private relations;
  private schema;
  private options;
  static readonly [entityKind]: string;
  private logger;
  private cache;
  constructor(client: Database, dialect: SQLiteAsyncDialect, relations: TRelations, schema: V1.RelationalSchemaConfig<TSchema> | undefined, options: SQLiteCloudSessionOptions);
  prepareQuery<T extends Omit<PreparedQueryConfig$1, 'run'>>(query: Query, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, customResultMapper?: (rows: unknown[][]) => unknown, queryMetadata?: {
    type: 'select' | 'update' | 'delete' | 'insert';
    tables: string[];
  }, cacheConfig?: WithCacheConfig): SQLiteCloudPreparedQuery<T>;
  prepareRelationalQuery<T extends Omit<PreparedQueryConfig$1, 'run'>>(query: Query, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, customResultMapper: (rows: Record<string, unknown>[]) => unknown, config: RelationalQueryMapperConfig): SQLiteCloudPreparedQuery<T, true>;
  run(query: SQL): Result<'async', SQLiteCloudRunResult>;
  all<T = unknown>(query: SQL): Result<'async', T[]>;
  get<T = unknown>(query: SQL): Result<'async', T>;
  values<T extends any[] = unknown[]>(query: SQL): Result<'async', T[]>;
  transaction<T>(transaction: (tx: SQLiteCloudTransaction<TFullSchema, TRelations, TSchema>) => Promise<T>, config?: SQLiteTransactionConfig): Promise<T>;
}
declare class SQLiteCloudTransaction<TFullSchema extends Record<string, unknown>, TRelations extends AnyRelations, TSchema extends V1.TablesRelationalConfig> extends SQLiteTransaction$1<'async', SQLiteCloudRunResult, TFullSchema, TRelations, TSchema> {
  static readonly [entityKind]: string;
  transaction<T>(transaction: (tx: SQLiteCloudTransaction<TFullSchema, TRelations, TSchema>) => Promise<T>): Promise<T>;
}
declare class SQLiteCloudPreparedQuery<T extends PreparedQueryConfig$1 = PreparedQueryConfig$1, TIsRqbV2 extends boolean = false> extends SQLitePreparedQuery<{
  type: 'async';
  run: SQLiteCloudRunResult;
  all: T['all'];
  get: T['get'];
  values: T['values'];
  execute: T['execute'];
}> {
  private stmt;
  private logger;
  private useJitMappers;
  private customResultMapper?;
  private isRqbV2Query?;
  private rqbConfig?;
  static readonly [entityKind]: string;
  private jitMapper?;
  constructor(stmt: ReturnType<Database['prepare']>, query: Query, logger: Logger, cache: Cache, queryMetadata: {
    type: 'select' | 'update' | 'delete' | 'insert';
    tables: string[];
  } | undefined, cacheConfig: WithCacheConfig | undefined, /** @internal */

  fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, useJitMappers: boolean | undefined, customResultMapper?: ((rows: TIsRqbV2 extends true ? Record<string, unknown>[] : unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown) | undefined, isRqbV2Query?: TIsRqbV2 | undefined, rqbConfig?: RelationalQueryMapperConfig | undefined);
  run(placeholderValues?: Record<string, unknown>): Promise<SQLiteCloudRunResult>;
  all(placeholderValues?: Record<string, unknown>): Promise<T['all']>;
  private allRqbV2;
  get(placeholderValues?: Record<string, unknown>): Promise<T['get']>;
  private getRqbV2;
  values(placeholderValues?: Record<string, unknown>): Promise<T['values']>;
}
//#endregion
export { SQLiteCloudPreparedQuery, SQLiteCloudSession, SQLiteCloudSessionOptions, SQLiteCloudTransaction };
//# sourceMappingURL=session.d.cts.map