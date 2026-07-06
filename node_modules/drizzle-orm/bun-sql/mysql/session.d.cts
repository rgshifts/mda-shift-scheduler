import { entityKind } from "../../entity.cjs";
import { Query } from "../../sql/sql.cjs";
import { AnyRelations } from "../../relations.cjs";
import { WithCacheConfig } from "../../cache/core/types.cjs";
import { Logger } from "../../logger.cjs";
import { MySqlDialect } from "../../mysql-core/dialect.cjs";
import { MySqlPreparedQuery, MySqlPreparedQueryConfig, MySqlQueryResultHKT, MySqlSession, MySqlTransaction, MySqlTransactionConfig } from "../../mysql-core/session.cjs";
import { Cache } from "../../cache/core/index.cjs";
import { SQL as SQL$1 } from "bun";

//#region src/bun-sql/mysql/session.d.ts
interface BunMySqlSessionOptions {
  logger?: Logger;
  cache?: Cache;
}
declare class BunMySqlSession<TSQL extends SQL$1, TRelations extends AnyRelations> extends MySqlSession<MySqlQueryResultHKT, TRelations> {
  readonly client: TSQL;
  private relations;
  readonly options: BunMySqlSessionOptions;
  static readonly [entityKind]: string;
  private logger;
  private cache;
  constructor(client: TSQL, dialect: MySqlDialect, relations: TRelations, options: BunMySqlSessionOptions);
  prepareQuery<T extends MySqlPreparedQueryConfig>(query: Query, mode: 'arrays' | 'objects' | 'raw', mapper?: (response: Record<string, unknown>[] | unknown[][] | {
    insertId: number;
    affectedRows: number;
  }) => any, queryMetadata?: {
    type: 'select' | 'update' | 'delete' | 'insert';
    tables: string[];
  }, cacheConfig?: WithCacheConfig): MySqlPreparedQuery<T>;
  transaction<T>(transaction: (tx: BunMySqlTransaction<TRelations>) => Promise<T>, config?: MySqlTransactionConfig): Promise<T>;
}
declare class BunMySqlTransaction<TRelations extends AnyRelations> extends MySqlTransaction<BunMySqlQueryResultHKT, TRelations> {
  static readonly [entityKind]: string;
  transaction<T>(transaction: (tx: BunMySqlTransaction<TRelations>) => Promise<T>): Promise<T>;
}
interface BunMySqlQueryResultHKT extends MySqlQueryResultHKT {
  type: Record<string, unknown>[] & Record<string, unknown>;
}
//#endregion
export { BunMySqlQueryResultHKT, BunMySqlSession, BunMySqlSessionOptions, BunMySqlTransaction };
//# sourceMappingURL=session.d.cts.map