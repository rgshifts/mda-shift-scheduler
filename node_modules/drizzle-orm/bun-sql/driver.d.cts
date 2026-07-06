import { BunMySqlDatabase } from "./mysql/driver.cjs";
import { BunSQLDatabase } from "./postgres/driver.cjs";
import { BunSQLiteDatabase } from "./sqlite/driver.cjs";
import { DrizzleConfig } from "../utils.cjs";
import { AnyRelations, EmptyRelations } from "../relations.cjs";
import { DrizzlePgConfig } from "../pg-core/utils.cjs";
import { SQL } from "bun";
import { DrizzleMySqlConfig } from "../mysql-core/utils.cjs";

//#region src/bun-sql/driver.d.ts
declare function drizzle<TRelations extends AnyRelations = EmptyRelations, TClient extends SQL = SQL>(...params: [string] | [string, DrizzlePgConfig<TRelations>] | [(DrizzlePgConfig<TRelations> & ({
  connection: string | ({
    url?: string;
  } & SQL.Options);
} | {
  client: TClient;
}))]): BunSQLDatabase<TRelations> & {
  $client: TClient;
};
declare namespace drizzle {
  function mock<TRelations extends AnyRelations = EmptyRelations>(config?: DrizzlePgConfig<TRelations>): BunSQLDatabase<TRelations> & {
    $client: '$client is not available on drizzle.mock()';
  };
  function postgres<TRelations extends AnyRelations = EmptyRelations, TClient extends SQL = SQL>(...params: [string] | [string, DrizzlePgConfig<TRelations>] | [(DrizzlePgConfig<TRelations> & ({
    connection: string | ({
      url?: string;
    } & SQL.Options);
  } | {
    client: TClient;
  }))]): BunSQLDatabase<TRelations> & {
    $client: TClient;
  };
  namespace postgres {
    function mock<TRelations extends AnyRelations = EmptyRelations>(config?: DrizzlePgConfig<TRelations>): BunSQLDatabase<TRelations> & {
      $client: '$client is not available on drizzle.mock()';
    };
  }
  function sqlite<TSchema extends Record<string, unknown> = Record<string, never>, TRelations extends AnyRelations = EmptyRelations, TClient extends SQL = SQL>(...params: [string] | [string, DrizzleConfig<TSchema, TRelations>] | [(DrizzleConfig<TSchema, TRelations> & ({
    connection: string | ({
      url?: string;
    } & SQL.Options);
  } | {
    client: TClient;
  }))]): BunSQLiteDatabase<TSchema, TRelations> & {
    $client: TClient;
  };
  namespace sqlite {
    function mock<TSchema extends Record<string, unknown> = Record<string, never>, TRelations extends AnyRelations = EmptyRelations>(config?: DrizzleConfig<TSchema, TRelations>): BunSQLiteDatabase<TSchema, TRelations> & {
      $client: '$client is not available on drizzle.mock()';
    };
  }
  function mysql<TRelations extends AnyRelations = EmptyRelations, TClient extends SQL = SQL>(...params: [string] | [string, DrizzleMySqlConfig<TRelations>] | [(DrizzleMySqlConfig<TRelations> & ({
    connection: string | ({
      url?: string;
    } & SQL.Options);
  } | {
    client: TClient;
  }))]): BunMySqlDatabase<TRelations> & {
    $client: TClient;
  };
  namespace mysql {
    function mock<TRelations extends AnyRelations = EmptyRelations>(config?: DrizzleMySqlConfig<TRelations>): BunMySqlDatabase<TRelations> & {
      $client: '$client is not available on drizzle.mock()';
    };
  }
}
//#endregion
export { drizzle };
//# sourceMappingURL=driver.d.cts.map