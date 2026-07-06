import { entityKind } from "../entity.js";
import { Query } from "../sql/sql.js";
import { Connection, FullResult, Tx } from "@tidbcloud/serverless";
import { Logger } from "../logger.js";
import { MySqlDialect } from "../mysql-core/dialect.js";
import { Cache } from "../cache/core/index.js";
import { MySqlPreparedQuery, MySqlPreparedQueryConfig, MySqlQueryResultHKT, MySqlSession, MySqlTransaction } from "../mysql-core/session.js";
import { AnyRelations } from "../relations.js";
import { WithCacheConfig } from "../cache/core/types.js";

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
//# sourceMappingURL=session.d.ts.map