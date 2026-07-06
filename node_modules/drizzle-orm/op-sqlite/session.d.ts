import { entityKind } from "../entity.js";
import { Query } from "../sql/sql.js";
import { Logger } from "../logger.js";
import { Cache } from "../cache/core/index.js";
import * as V1 from "../_relations.js";
import { SQLiteAsyncDialect } from "../sqlite-core/dialect.js";
import { AnyRelations, RelationalQueryMapperConfig } from "../relations.js";
import { SQLiteTransaction } from "../sqlite-core/index.js";
import { PreparedQueryConfig, SQLiteExecuteMethod, SQLitePreparedQuery, SQLiteSession, SQLiteTransactionConfig } from "../sqlite-core/session.js";
import { WithCacheConfig } from "../cache/core/types.js";
import { SelectedFieldsOrdered } from "../sqlite-core/query-builders/select.types.js";
import { OPSQLiteConnection, QueryResult } from "@op-engineering/op-sqlite";

//#region src/op-sqlite/session.d.ts
interface OPSQLiteSessionOptions {
  logger?: Logger;
  cache?: Cache;
  useJitMappers?: boolean;
}
type PreparedQueryConfig$1 = Omit<PreparedQueryConfig, 'statement' | 'run'>;
declare class OPSQLiteSession<TFullSchema extends Record<string, unknown>, TRelations extends AnyRelations, TSchema extends V1.TablesRelationalConfig> extends SQLiteSession<'async', QueryResult, TFullSchema, TRelations, TSchema> {
  private client;
  private relations;
  private schema;
  private options;
  static readonly [entityKind]: string;
  private logger;
  private cache;
  constructor(client: OPSQLiteConnection, dialect: SQLiteAsyncDialect, relations: TRelations, schema: V1.RelationalSchemaConfig<TSchema> | undefined, options?: OPSQLiteSessionOptions);
  prepareQuery<T extends Omit<PreparedQueryConfig$1, 'run'>>(query: Query, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, customResultMapper?: (rows: unknown[][]) => unknown, queryMetadata?: {
    type: 'select' | 'update' | 'delete' | 'insert';
    tables: string[];
  }, cacheConfig?: WithCacheConfig): OPSQLitePreparedQuery<T>;
  prepareRelationalQuery<T extends Omit<PreparedQueryConfig$1, 'run'>>(query: Query, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, customResultMapper: (rows: Record<string, unknown>[]) => unknown, config: RelationalQueryMapperConfig): OPSQLitePreparedQuery<T, true>;
  transaction<T>(transaction: (tx: OPSQLiteTransaction<TFullSchema, TRelations, TSchema>) => T, config?: SQLiteTransactionConfig): T;
}
declare class OPSQLiteTransaction<TFullSchema extends Record<string, unknown>, TRelations extends AnyRelations, TSchema extends V1.TablesRelationalConfig> extends SQLiteTransaction<'async', QueryResult, TFullSchema, TRelations, TSchema> {
  static readonly [entityKind]: string;
  transaction<T>(transaction: (tx: OPSQLiteTransaction<TFullSchema, TRelations, TSchema>) => T): T;
}
declare class OPSQLitePreparedQuery<T extends PreparedQueryConfig$1 = PreparedQueryConfig$1, TIsRqbV2 extends boolean = false> extends SQLitePreparedQuery<{
  type: 'async';
  run: QueryResult;
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
  constructor(client: OPSQLiteConnection, query: Query, logger: Logger, cache: Cache, queryMetadata: {
    type: 'select' | 'update' | 'delete' | 'insert';
    tables: string[];
  } | undefined, cacheConfig: WithCacheConfig | undefined, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, useJitMappers: boolean | undefined, customResultMapper?: ((rows: TIsRqbV2 extends true ? Record<string, unknown>[] : unknown[][]) => unknown) | undefined, isRqbV2Query?: TIsRqbV2 | undefined, rqbConfig?: RelationalQueryMapperConfig | undefined);
  run(placeholderValues?: Record<string, unknown>): Promise<QueryResult>;
  all(placeholderValues?: Record<string, unknown>): Promise<T['all']>;
  private allRqbV2;
  get(placeholderValues?: Record<string, unknown>): Promise<T['get']>;
  private getRqbV2;
  values(placeholderValues?: Record<string, unknown>): Promise<T['values']>;
}
//#endregion
export { OPSQLitePreparedQuery, OPSQLiteSession, OPSQLiteSessionOptions, OPSQLiteTransaction };
//# sourceMappingURL=session.d.ts.map