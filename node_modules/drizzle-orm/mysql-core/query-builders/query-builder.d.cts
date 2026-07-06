import { MySqlSelectBuilder } from "./select.cjs";
import { SelectedFields } from "./select.types.cjs";
import { entityKind } from "../../entity.cjs";
import { WithSubquery } from "../../subquery.cjs";
import { MySqlDialect, MySqlDialectConfig } from "../dialect.cjs";
import { WithBuilder } from "../subquery.cjs";

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
//# sourceMappingURL=query-builder.d.cts.map