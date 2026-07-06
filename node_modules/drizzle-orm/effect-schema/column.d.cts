import { Column } from "../column.cjs";
import { Top } from "effect/Schema";
import { Schema } from "effect";

//#region src/effect-schema/column.d.ts
declare const literalSchema: Schema.Union<readonly [Schema.String, Schema.Number, Schema.Boolean, Schema.Null]>;
declare const jsonSchema: Schema.Union<readonly [Schema.Union<readonly [Schema.String, Schema.Number, Schema.Boolean, Schema.Null]>, Schema.$Record<Schema.String, Schema.Any>, Schema.$Array<Schema.Any>]>;
declare const bufferSchema: Schema.instanceOf<Buffer<ArrayBufferLike>, unknown>;
declare function columnToSchema(column: Column): Top;
declare const bigintStringModeSchema: Schema.BigInt;
declare const unsignedBigintStringModeSchema: Schema.BigInt;
//#endregion
export { bigintStringModeSchema, bufferSchema, columnToSchema, jsonSchema, literalSchema, unsignedBigintStringModeSchema };
//# sourceMappingURL=column.d.cts.map