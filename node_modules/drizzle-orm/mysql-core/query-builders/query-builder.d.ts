import { MySqlSelectBuilder } from "./select.js";
import { SelectedFields } from "./select.types.js";
import { entityKind } from "../../entity.js";
import { WithSubquery } from "../../subquery.js";
import { MySqlDialect, MySqlDialectConfig } from "../dialect.js";
import { WithBuilder } from "../subquery.js";

//#region src/mysql-core/query-builders/query-builder.d.ts
declare class QueryBuilder {
  static readonly [entityKind]: string;
  private dialect;
  private dialectConfig;
  constructor(dialect?: MySqlDialect | MySqlDialectConfig);
  $with: WithBuilder;
  with(...queries: WithSubquery[]): {
    select: {
      (): MySqlSelectBuilder<undefined, "qb">;
      <TSelection extends SelectedFields>(fields: TSelection): MySqlSelectBuilder<TSelection, "qb">;
    };
    selectDistinct: {
      (): MySqlSelectBuilder<undefined, "qb">;
      <TSelection extends SelectedFields>(fields: TSelection): MySqlSelectBuilder<TSelection, "qb">;
    };
  };
  select(): MySqlSelectBuilder<undefined, 'qb'>;
  select<TSelection extends SelectedFields>(fields: TSelection): MySqlSelectBuilder<TSelection, 'qb'>;
  selectDistinct(): MySqlSelectBuilder<undefined, 'qb'>;
  selectDistinct<TSelection extends SelectedFields>(fields: TSelection): MySqlSelectBuilder<TSelection, 'qb'>;
  private getDialect;
}
//#endregion
export { QueryBuilder };
//# sourceMappingURL=query-builder.d.ts.map