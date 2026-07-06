import { MySqlTable } from "../table.js";
import { MySqlViewBase } from "../view-base.js";
import { MySqlDialect } from "../dialect.js";
import { MySqlSession } from "../session.js";
import { entityKind } from "../../entity.js";
import { Query, SQL, SQLWrapper } from "../../sql/sql.js";
import { QueryPromise } from "../../query-promise.js";

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
//# sourceMappingURL=count.d.ts.map