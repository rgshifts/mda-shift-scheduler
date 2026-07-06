import { entityKind } from "../entity.js";
import * as Schema from "effect/Schema";

//#region src/effect-core/errors.ts
var EffectDrizzleError = class extends Schema.TaggedErrorClass()("EffectDrizzleError", {
	message: Schema.String,
	cause: Schema.Unknown
}) {
	static [entityKind] = "EffectDrizzleError";
};
var EffectDrizzleQueryError = class EffectDrizzleQueryError extends Schema.TaggedErrorClass()("EffectDrizzleQueryError", {
	query: Schema.String,
	params: Schema.Array(Schema.Any).pipe(Schema.mutable),
	cause: Schema.Unknown
}) {
	static [entityKind] = "EffectDrizzleQueryError";
	get message() {
		return `Failed query: ${this.query}\nparams: ${this.params}`;
	}
	constructor(params) {
		super(params);
		Error.captureStackTrace(this, EffectDrizzleQueryError);
	}
};
var EffectTransactionRollbackError = class extends Schema.TaggedErrorClass()("EffectTransactionRollbackError", {}) {
	static [entityKind] = "EffectTransactionRollbackError";
	message = "Rollback";
};
var MigratorInitError = class extends Schema.TaggedErrorClass()("MigratorInitError", { exitCode: Schema.Literals(["databaseMigrations", "localMigrations"]) }) {
	static [entityKind] = "MigratorInitError";
};

//#endregion
export { EffectDrizzleError, EffectDrizzleQueryError, EffectTransactionRollbackError, MigratorInitError };
//# sourceMappingURL=errors.js.map