import { MySqlDialect } from "./dialect.cjs";
import { MySqlDatabase } from "./db.cjs";
import { entityKind } from "../entity.cjs";
import { Query, SQL } from "../sql/sql.cjs";
import { AnyRelations, EmptyRelations } from "../relations.cjs";
import { Cache } from "../cache/core/cache.cjs";
import { WithCacheConfig } from "../cache/core/types.cjs";
import { Logger } from "../logger.cjs";

//#region src/mysql-core/session.d.ts
interface MySqlQueryResultHKT {
  readonly $brand: 'MySqlQueryResultHKT';
  readonly row: unknown;
  readonly type: unknown;
}
interface AnyMySqlQueryResultHKT extends MySqlQueryResultHKT {
  readonly type: any;
}
type MySqlQueryResultKind<TKind extends MySqlQueryResultHKT, TRow> = (TKind & {
  readonly row: TRow;
})['type'];
interface MySqlPreparedQueryConfig {
  execute: unknown;
  iterator: unknown;
}
interface MySqlPreparedQueryHKT {
  readonly $brand: 'MySqlPreparedQueryHKT';
  readonly config: unknown;
  readonly type: unknown;
}
type AnyMySqlMapper = (response: Record<string, unknown>[] | unknown[][] | {
  insertId: number;
  affectedRows: number;
}) => any;
declare class MySqlPreparedQuery<T extends MySqlPreparedQueryConfig> {
  protected executor: (params?: unknown[]) => Promise<any>;
  protected _iterator: ((params?: unknown[]) => AsyncGenerator<any[]>) | undefined;
  protected query: Query;
  readonly mode: 'arrays' | 'objects' | 'raw';
  protected logger: Logger;
  private cache;
  private queryMetadata;
  private cacheConfig?;
  static readonly [entityKind]: string;
  private fastPath;
  constructor(executor: (params?: unknown[]) => Promise<any>, _iterator: ((params?: unknown[]) => AsyncGenerator<any[]>) | undefined, query: Query, mapper: AnyMySqlMapper | undefined, mode: 'arrays' | 'objects' | 'raw', logger: Logger, cache: Cache | undefined, queryMetadata: {
    type: 'select' | 'update' | 'delete' | 'insert';
    tables: string[];
  } | undefined, cacheConfig?: WithCacheConfig | undefined);
  execute(placeholderValues?: Record<string, unknown>): Promise<T['execute']>;
  iterator(placeholderValues?: Record<string, unknown>): AsyncGenerator<T['iterator']>;
}
interface MySqlTransactionConfig {
  withConsistentSnapshot?: boolean;
  accessMode?: 'read only' | 'read write';
  isolationLevel: 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable';
}
declare abstract class MySqlSession<TQueryResult extends MySqlQueryResultHKT = MySqlQueryResultHKT, TRelations extends AnyRelations = EmptyRelations> {
  protected dialect: MySqlDialect;
  static readonly [entityKind]: string;
  constructor(dialect: MySqlDialect);
  abstract prepareQuery<T extends MySqlPreparedQueryConfig>(query: Query, mode: 'arrays' | 'objects' | 'raw', mapper?: (rows: any) => any, queryMetadata?: {
    type: 'select' | 'update' | 'delete' | 'insert';
    tables: string[];
  }, cacheConfig?: WithCacheConfig): MySqlPreparedQuery<T>;
  execute<T>(query: SQL): Promise<T>;
  arrays<T>(query: SQL): Promise<T[]>;
  objects<T>(query: SQL): Promise<T[]>;
  abstract transaction<T>(transaction: (tx: MySqlTransaction<TQueryResult, TRelations>) => Promise<T>, config?: MySqlTransactionConfig): Promise<T>;
  protected getSetTransactionSQL(config: MySqlTransactionConfig): SQL | undefined;
  protected getStartTransactionSQL(config: MySqlTransactionConfig): SQL | undefined;
}
declare abstract class MySqlTransaction<TQueryResult extends MySqlQueryResultHKT, TRelations extends AnyRelations = EmptyRelations> extends MySqlDatabase<TQueryResult, TRelations> {
  protected relations: TRelations;
  protected readonly nestedIndex: number;
  static readonly [entityKind]: string;
  constructor(dialect: MySqlDialect, session: MySqlSession, relations: TRelations, nestedIndex: number);
  rollback(): never;
  /** Nested transactions (aka savepoints) only work with InnoDB engine. */
  abstract transaction<T>(transaction: (tx: MySqlTransaction<TQueryResult, TRelations>) => Promise<T>): Promise<T>;
}
//#endregion
export { AnyMySqlMapper, AnyMySqlQueryResultHKT, MySqlPreparedQuery, MySqlPreparedQueryConfig, MySqlPreparedQueryHKT, MySqlQueryResultHKT, MySqlQueryResultKind, MySqlSession, MySqlTransaction, MySqlTransactionConfig };
//# sourceMappingURL=session.d.cts.map