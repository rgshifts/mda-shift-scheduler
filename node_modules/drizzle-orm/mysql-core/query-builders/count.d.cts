import { MySqlTable } from "../table.cjs";
import { MySqlViewBase } from "../view-base.cjs";
import { MySqlDialect } from "../dialect.cjs";
import { MySqlSession } from "../session.cjs";
import { entityKind } from "../../entity.cjs";
import { Query, SQL, SQLWrapper } from "../../sql/sql.cjs";
import { QueryPromise } from "../../query-promise.cjs";

//#region src/mysql-core/query-builders/count.d.ts
interface MySqlCountBuilder extends SQL<number>, SQLWrapper<number>, QueryPromise<number> {}
declare class MySqlCountBuilder extends SQL<number> implements SQLWrapper<number> {
  protected countConfig: {
    source: MySqlTable | MySqlViewBase | SQL | SQLWrapper;
    filters?: SQL<unknown>;
    dialect: MySqlDialect;
    session: MySqlSession;
  };
  static readonly [entityKind]: string;
  protected dialect: MySqlDialect;
  protected session: MySqlSession;
  private static buildCount;
  constructor(countConfig: {
    source: MySqlTable | MySqlViewBase | SQL | SQLWrapper;
    filters?: SQL<unknown>;
    dialect: MySqlDialect;
    session: MySqlSession;
  });
  private executableSql;
  protected build(): Query;
  execute(placeholderValues?: Record<string, unknown>): Promise<number>;
}
//#endregion
export { MySqlCountBuilder };
//# sourceMappingURL=count.d.cts.map