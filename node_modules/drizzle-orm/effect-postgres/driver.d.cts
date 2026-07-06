import { EffectPgQueryEffectHKT, EffectPgQueryResultHKT } from "./session.cjs";
import { entityKind } from "../entity.cjs";
import { AnyRelations, EmptyRelations } from "../relations.cjs";
import { DrizzlePgConfig } from "../pg-core/utils.cjs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PgClient } from "@effect/sql-pg/PgClient";
import { EffectCache } from "../cache/core/cache-effect.cjs";
import { EffectLogger } from "../effect-core/index.cjs";
import { PgEffectDatabase } from "../pg-core/effect/db.cjs";

//#region src/effect-postgres/driver.d.ts
declare class EffectPgDatabase<TRelations extends AnyRelations = EmptyRelations> extends PgEffectDatabase<EffectPgQueryEffectHKT, EffectPgQueryResultHKT, TRelations> {
  static readonly [entityKind]: string;
}
type EffectDrizzlePgConfig<TRelations extends AnyRelations = EmptyRelations> = Omit<DrizzlePgConfig<TRelations>, 'cache' | 'logger'>;
declare const DefaultServices: Layer.Layer<EffectCache | EffectLogger, never, never>;
/**
 * Creates an EffectPgDatabase instance.
 *
 * Requires `PgClient`, `EffectLogger`, and `EffectCache` services to be provided.
 * Use `DefaultServices` to provide default (no-op) logger and cache implementations.
 *
 * @example
 * ```ts
 * // With default services (no logging, no caching)
 * const db = yield* PgDrizzle.make({ relations }).pipe(
 *   Effect.provide(PgDrizzle.DefaultServices),
 * );
 *
 * // With Effect-based logging
 * const db = yield* PgDrizzle.make({ relations }).pipe(
 *   Effect.provide(EffectLogger.layer),
 *   Effect.provide(PgDrizzle.DefaultServices),
 * );
 *
 * // With custom Drizzle logger
 * const db = yield* PgDrizzle.make({ relations }).pipe(
 *   Effect.provide(EffectLogger.layerFromDrizzle(myLogger)),
 *   Effect.provide(PgDrizzle.DefaultServices),
 * );
 * ```
 */
declare const make: <TRelations extends AnyRelations = EmptyRelations>(config?: EffectDrizzlePgConfig<TRelations> | undefined) => Effect.Effect<EffectPgDatabase<TRelations> & {
  $client: PgClient;
}, never, EffectCache | EffectLogger | PgClient>;
/**
 * Convenience function that creates an EffectPgDatabase with `DefaultServices` already provided.
 */
declare const makeWithDefaults: <TRelations extends AnyRelations = EmptyRelations>(config?: EffectDrizzlePgConfig<TRelations>) => Effect.Effect<EffectPgDatabase<TRelations> & {
  $client: PgClient;
}, never, PgClient>;
//#endregion
export { DefaultServices, EffectDrizzlePgConfig, EffectPgDatabase, make, makeWithDefaults };
//# sourceMappingURL=driver.d.cts.map