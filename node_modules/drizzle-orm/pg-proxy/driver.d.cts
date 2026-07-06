import { PgRemoteQueryResultHKT } from "./session.cjs";
import { entityKind } from "../entity.cjs";
import { AnyRelations, EmptyRelations } from "../relations.cjs";
import { PgDialect } from "../pg-core/dialect.cjs";
import { PgCodecs } from "../pg-core/codecs.cjs";
import { PgAsyncDatabase } from "../pg-core/async/db.cjs";
import { DrizzlePgConfig } from "../pg-core/utils.cjs";

//#region src/pg-proxy/driver.d.ts
declare class PgRemoteDatabase<TRelations extends AnyRelations = EmptyRelations> extends PgAsyncDatabase<PgRemoteQueryResultHKT, TRelations> {
  static readonly [entityKind]: string;
}
type RemoteCallback = (sql: string, params: any[], method: 'all' | 'execute') => Promise<{
  rows: any[];
}>;
declare function drizzle<TRelations extends AnyRelations = EmptyRelations>(callback: RemoteCallback, config?: DrizzlePgConfig<TRelations> & {
  codecs?: PgCodecs;
}, _dialect?: () => PgDialect): PgRemoteDatabase<TRelations>;
//#endregion
export { PgRemoteDatabase, RemoteCallback, drizzle };
//# sourceMappingURL=driver.d.cts.map