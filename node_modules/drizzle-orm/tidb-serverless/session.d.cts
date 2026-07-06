import { entityKind } from "../entity.cjs";
import { Query } from "../sql/sql.cjs";
import { AnyRelations } from "../relations.cjs";
import { WithCacheConfig } from "../cache/core/types.cjs";
import { Logger } from "../logger.cjs";
import { MySqlDialect } from "../mysql-core/dialect.cjs";
import { MySqlPreparedQuery, MySqlPreparedQueryConfig, MySqlQueryResultHKT, MySqlSession, MySqlTransaction } from "../mysql-core/session.cjs";
import { Cache } from "../cache/core/index.cjs";
import { Connection, FullResult, Tx } from "@tidbcloud/serverless";

//#region src/tidb-serverless/session.d.ts
interface TiDBServerlessSessionOptions {
  logger?: Logger;
  cache?: Cache;
}
declare class TiDBServerlessSession<TRelations extends AnyRelations> extends MySqlSession<TiDBServerlessQueryResultHKT, TRelations> {
  private baseClient;
  private relations;
  private options;
  static readonly [entityKind]: string;
  private logger;
  private client;
  private cache;
  constructor(baseClient: Connection, dialect: MySqlDialect, tx: Tx | undefined, relations: TRelations, options?: TiDBServerlessSessionOptions);
  prepareQuery<T extends MySqlPreparedQueryConfig = MySqlPreparedQueryConfig>(query: Query, mode: 'arrays' | 'objects' | 'raw', mapper?: (response: Record<string, unknown>[] | unknown[][] | {
    insertId: number;
    affectedRows: number;
  }) => any, queryMetadata?: {
    type: 'select' | 'update' | 'delete' | 'insert';
    tables: string[];
  }, cacheConfig?: WithCacheConfig): MySqlPreparedQuery<T>;
  transaction<T>(transaction: (tx: TiDBServerlessTransaction<TRelations>) => Promise<T>): Promise<T>;
}
declare class TiDBServerlessTransaction<TRelations extends AnyRelations> extends MySqlTransaction<TiDBServerlessQueryResultHKT, TRelations> {
  static readonly [entityKind]: string;
  constructor(dialect: MySqlDialect, session: MySqlSession, relations: TRelations, nestedIndex?: number);
  transaction<T>(transaction: (tx: TiDBServerlessTransaction<TRelations>) => Promise<T>): Promise<T>;
}
interface TiDBServerlessQueryResultHKT extends MySqlQueryResultHKT {
  type: FullResult;
}
//#endregion
export { TiDBServerlessQueryResultHKT, TiDBServerlessSession, TiDBServerlessSessionOptions, TiDBServerlessTransaction };
//# sourceMappingURL=session.d.cts.map