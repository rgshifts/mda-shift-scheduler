import { RemoteCallback } from "./driver.cjs";
import { entityKind } from "../entity.cjs";
import { Query } from "../sql/sql.cjs";
import { AnyRelations } from "../relations.cjs";
import { WithCacheConfig } from "../cache/core/types.cjs";
import { Logger } from "../logger.cjs";
import { FieldPacket, ResultSetHeader } from "mysql2/promise";
import { MySqlDialect } from "../mysql-core/dialect.cjs";
import { AnyMySqlMapper, MySqlPreparedQuery, MySqlPreparedQueryConfig, MySqlQueryResultHKT, MySqlSession, MySqlTransactionConfig } from "../mysql-core/session.cjs";
import { Cache } from "../cache/core/index.cjs";
import { MySqlTransaction as MySqlTransaction$1 } from "../mysql-core/index.cjs";

//#region src/mysql-proxy/session.d.ts
type MySqlRawQueryResult = [ResultSetHeader, FieldPacket[]];
interface MySqlRemoteSessionOptions {
  logger?: Logger;
  cache?: Cache;
}
declare class MySqlRemoteSession<TRelations extends AnyRelations> extends MySqlSession<MySqlRemoteQueryResultHKT, TRelations> {
  private client;
  private relations;
  private options;
  static readonly [entityKind]: string;
  private logger;
  private cache;
  constructor(client: RemoteCallback, dialect: MySqlDialect, relations: TRelations, options: MySqlRemoteSessionOptions);
  prepareQuery<T extends MySqlPreparedQueryConfig>(query: Query, mode: 'arrays' | 'objects' | 'raw', mapper?: AnyMySqlMapper, queryMetadata?: {
    type: 'select' | 'update' | 'delete' | 'insert';
    tables: string[];
  }, cacheConfig?: WithCacheConfig): MySqlPreparedQuery<T>;
  transaction<T>(_transaction: (tx: MySqlTransaction$1<MySqlRemoteQueryResultHKT, TRelations>) => Promise<T>, _config?: MySqlTransactionConfig): Promise<T>;
}
interface MySqlRemoteQueryResultHKT extends MySqlQueryResultHKT {
  type: MySqlRawQueryResult;
}
//#endregion
export { MySqlRawQueryResult, MySqlRemoteQueryResultHKT, MySqlRemoteSession, MySqlRemoteSessionOptions };
//# sourceMappingURL=session.d.cts.map