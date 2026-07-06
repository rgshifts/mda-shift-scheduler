import { entityKind } from "../entity.js";
import * as effect_Cause0 from "effect/Cause";
import * as Schema from "effect/Schema";

//#region src/effect-core/errors.d.ts
declare const EffectDrizzleError_base: Schema.Class<EffectDrizzleError, Schema.TaggedStruct<"EffectDrizzleError", {
  readonly message: Schema.String;
  readonly cause: Schema.Unknown;
}>, effect_Cause0.YieldableError>;
declare class EffectDrizzleError extends EffectDrizzleError_base {
  static readonly [entityKind]: string;
}
declare const EffectDrizzleQueryError_base: Schema.Class<EffectDrizzleQueryError, Schema.TaggedStruct<"EffectDrizzleQueryError", {
  readonly query: Schema.String;
  readonly params: Schema.mutable<Schema.$Array<Schema.Any>>;
  readonly cause: Schema.Unknown;
}>, effect_Cause0.YieldableError>;
declare class EffectDrizzleQueryError extends EffectDrizzleQueryError_base {
  static readonly [entityKind]: string;
  get message(): string;
  constructor(params: Omit<Schema.Struct.MakeIn<typeof EffectDrizzleQueryError.fields>, '_tag'>);
}
declare const EffectTransactionRollbackError_base: Schema.Class<EffectTransactionRollbackError, Schema.TaggedStruct<"EffectTransactionRollbackError", {}>, effect_Cause0.YieldableError>;
declare class EffectTransactionRollbackError extends EffectTransactionRollbackError_base {
  static readonly [entityKind]: string;
  readonly message = "Rollback";
}
declare const MigratorInitError_base: Schema.Class<MigratorInitError, Schema.TaggedStruct<"MigratorInitError", {
  readonly exitCode: Schema.Literals<readonly ["databaseMigrations", "localMigrations"]>;
}>, effect_Cause0.YieldableError>;
declare class MigratorInitError extends MigratorInitError_base {
  static readonly [entityKind]: string;
}
//#endregion
export { EffectDrizzleError, EffectDrizzleQueryError, EffectTransactionRollbackError, MigratorInitError };
//# sourceMappingURL=errors.d.ts.map