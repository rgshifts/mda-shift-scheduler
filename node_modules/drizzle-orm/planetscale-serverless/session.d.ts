import { entityKind } from "../entity.js";
import { Query } from "../sql/sql.js";
import { Logger } from "../logger.js";
import { MySqlDialect } from "../mysql-core/dialect.js";
import { Cache } from "../cache/core/index.js";
import { MySqlPreparedQuery, MySqlPreparedQueryConfig, MySqlQueryResultHKT, MySqlSession, MySqlTransaction } from "../mysql-core/session.js";
import { AnyRelations } from "../relations.js";
import { Client, Connection, ExecutedQuery, Transaction } from "@planetscale/database";
import { WithCacheConfig } from "../cache/core/types.js";

//#region src/planetscale-serverless/session.d.ts
interface PlanetscaleSessionOptions {
  logger?: Logger;
  cache?: Cache;
}
declare class PlanetscaleSession<TRelations extends AnyRelations> extends MySqlSession<MySqlQueryResultHKT, TRelations> {
  private baseClient;
  private relations;
  private options;
  static readonly [entityKind]: string;
  private logger;
  private client;
  private cache;
  constructor(baseClient: Client | Connection, dialect: MySqlDialect, tx: Transaction | undefined, relations: TRelations, options?: PlanetscaleSessionOptions);
  prepareQuery<T extends MySqlPreparedQueryConfig>(query: Query, mode: 'arrays' | 'objects' | 'raw', mapper?: (response: Record<string, unknown>[] | unknown[][] | {
    insertId: number;
    affectedRows: number;
  }) => any, queryMetadata?: {
    type: 'select' | 'update' | 'delete' | 'insert';
    tables: string[];
  }, cacheConfig?: WithCacheConfig): MySqlPreparedQuery<T>;
  transaction<T>(transaction: (tx: PlanetScaleTransaction<TRelations>) => Promise<T>): Promise<T>;
}
declare class PlanetScaleTransaction<TRelations extends AnyRelations> extends MySqlTransaction<PlanetscaleQueryResultHKT, TRelations> {
  static readonly [entityKind]: string;
  constructor(dialect: MySqlDialect, session: MySqlSession, relations: TRelations, nestedIndex?: number);
  transaction<T>(transaction: (tx: PlanetScaleTransaction<TRelations>) => Promise<T>): Promise<T>;
}
interface PlanetscaleQueryResultHKT extends MySqlQueryResultHKT {
  type: ExecutedQuery;
}
//#endregion
export { PlanetScaleTransaction, PlanetscaleQueryResultHKT, PlanetscaleSession, PlanetscaleSessionOptions };
//# sourceMappingURL=session.d.ts.map