import { entityKind } from "../entity.js";
import { DrizzleTypeError } from "../utils.js";
import { Query } from "../sql/sql.js";
import { Logger } from "../logger.js";
import * as V1 from "../_relations.js";
import { SQLiteSyncDialect } from "../sqlite-core/dialect.js";
import { AnyRelations, RelationalQueryMapperConfig } from "../relations.js";
import { SQLiteTransaction } from "../sqlite-core/index.js";
import { PreparedQueryConfig, SQLiteExecuteMethod, SQLitePreparedQuery, SQLiteSession, SQLiteTransactionConfig } from "../sqlite-core/session.js";
import { SQLiteDatabase, SQLiteRunResult, SQLiteStatement } from "expo-sqlite";
import { SelectedFieldsOrdered } from "../sqlite-core/query-builders/select.types.js";

//#region src/expo-sqlite/session.d.ts
interface ExpoSQLiteSessionOptions {
  logger?: Logger;
  useJitMappers?: boolean;
}
type PreparedQueryConfig$1 = Omit<PreparedQueryConfig, 'statement' | 'run'>;
declare class ExpoSQLiteSession<TFullSchema extends Record<string, unknown>, TRelations extends AnyRelations, TSchema extends V1.TablesRelationalConfig> extends SQLiteSession<'sync', SQLiteRunResult, TFullSchema, TRelations, TSchema> {
  private client;
  private relations;
  private schema;
  private options;
  static readonly [entityKind]: string;
  private logger;
  constructor(client: SQLiteDatabase, dialect: SQLiteSyncDialect, relations: TRelations, schema: V1.RelationalSchemaConfig<TSchema> | undefined, options?: ExpoSQLiteSessionOptions);
  prepareQuery<T extends Omit<PreparedQueryConfig$1, 'run'>>(query: Query, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, customResultMapper?: (rows: unknown[][]) => unknown): ExpoSQLitePreparedQuery<T>;
  prepareRelationalQuery<T extends Omit<PreparedQueryConfig$1, 'run'>>(query: Query, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, customResultMapper: (rows: Record<string, unknown>[]) => unknown, config: RelationalQueryMapperConfig): ExpoSQLitePreparedQuery<T, true>;
  transaction<T>(transaction: (tx: ExpoSQLiteTransaction<TFullSchema, TRelations, TSchema>) => T, config?: SQLiteTransactionConfig): T;
}
declare class ExpoSQLiteTransaction<TFullSchema extends Record<string, unknown>, TRelations extends AnyRelations, TSchema extends V1.TablesRelationalConfig> extends SQLiteTransaction<'sync', SQLiteRunResult, TFullSchema, TRelations, TSchema> {
  static readonly [entityKind]: string;
  transaction<T>(transaction: (tx: ExpoSQLiteTransaction<TFullSchema, TRelations, TSchema>) => T extends Promise<any> ? DrizzleTypeError<"Sync drivers can't use async functions in transactions!"> : T): T;
}
declare class ExpoSQLitePreparedQuery<T extends PreparedQueryConfig$1 = PreparedQueryConfig$1, TIsRqbV2 extends boolean = false> extends SQLitePreparedQuery<{
  type: 'sync';
  run: SQLiteRunResult;
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
  constructor(stmt: SQLiteStatement, query: Query, logger: Logger, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod, useJitMappers: boolean | undefined, customResultMapper?: ((rows: TIsRqbV2 extends true ? Record<string, unknown>[] : unknown[][]) => unknown) | undefined, isRqbV2Query?: TIsRqbV2 | undefined, rqbConfig?: RelationalQueryMapperConfig | undefined);
  run(placeholderValues?: Record<string, unknown>): SQLiteRunResult;
  all(placeholderValues?: Record<string, unknown>): T['all'];
  private allRqbV2;
  get(placeholderValues?: Record<string, unknown>): T['get'];
  private getRqbV2;
  values(placeholderValues?: Record<string, unknown>): T['values'];
}
//#endregion
export { ExpoSQLitePreparedQuery, ExpoSQLiteSession, ExpoSQLiteSessionOptions, ExpoSQLiteTransaction };
//# sourceMappingURL=session.d.ts.map