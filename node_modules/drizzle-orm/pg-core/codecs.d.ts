import { makePgArray } from "./array.js";
import { PartialWithUndefined } from "../utils.js";
import { CastArrayCodec, CastCodec, Codecs, NormalizeArrayCodec, NormalizeCodec } from "../codecs.js";
import * as __sql_sql_ts0 from "../sql/sql.js";
import { SQLChunk } from "../sql/sql.js";

//#region src/pg-core/codecs.d.ts
type PostGISType = 'geometry(point)' | 'geometry(pointz)' | 'geometry(pointm)' | 'geometry(pointzm)' | 'geometry(linestring)' | 'geometry(linestringz)' | 'geometry(linestringm)' | 'geometry(linestringzm)' | 'geometry(polygon)' | 'geometry(polygonz)' | 'geometry(polygonm)' | 'geometry(polygonzm)' | 'geometry(multipoint)' | 'geometry(multipointz)' | 'geometry(multipointm)' | 'geometry(multipointzm)' | 'geometry(multilinestring)' | 'geometry(multilinestringz)' | 'geometry(multilinestringm)' | 'geometry(multilinestringzm)' | 'geometry(multipolygon)' | 'geometry(multipolygonz)' | 'geometry(multipolygonm)' | 'geometry(multipolygonzm)' | 'geometry(geometrycollection)' | 'geometry(geometrycollectionz)' | 'geometry(geometrycollectionm)' | 'geometry(geometrycollectionzm)' | 'geometry(circularstring)' | 'geometry(circularstringz)' | 'geometry(circularstringm)' | 'geometry(circularstringzm)' | 'geometry(compoundcurve)' | 'geometry(compoundcurvez)' | 'geometry(compoundcurvem)' | 'geometry(compoundcurvezm)' | 'geometry(curvepolygon)' | 'geometry(curvepolygonz)' | 'geometry(curvepolygonm)' | 'geometry(curvepolygonzm)' | 'geometry(multicurve)' | 'geometry(multicurvez)' | 'geometry(multicurvem)' | 'geometry(multicurvezm)' | 'geometry(multisurface)' | 'geometry(multisurfacez)' | 'geometry(multisurfacem)' | 'geometry(multisurfacezm)' | 'geometry(polyhedralsurface)' | 'geometry(polyhedralsurfacez)' | 'geometry(polyhedralsurfacem)' | 'geometry(polyhedralsurfacezm)' | 'geometry(tin)' | 'geometry(tinz)' | 'geometry(tinm)' | 'geometry(tinzm)' | 'geometry(triangle)' | 'geometry(trianglez)' | 'geometry(trianglem)' | 'geometry(trianglezm)' | 'geography(point)' | 'geography(linestring)' | 'geography(polygon)' | 'geography(multipoint)' | 'geography(multilinestring)' | 'geography(multipolygon)' | 'geography(geometrycollection)' | 'box2d' | 'box3d' | 'raster';
type PostgresType = 'smallint' | 'int' | 'bigint' | 'bigint:number' | 'bigint:string' | 'numeric' | 'numeric:number' | 'numeric:bigint' | 'float4' | 'float8' | 'money' | 'smallserial' | 'serial' | 'bigserial' | 'bigserial:number' | 'char' | 'varchar' | 'text' | 'bytea' | 'date' | 'date:string' | 'time' | 'timetz' | 'timestamp' | 'timestamptz' | 'timestamp:string' | 'timestamptz:string' | 'interval' | 'interval:tuple' | 'bool' | 'enum' | 'point' | 'point:tuple' | 'line' | 'line:tuple' | 'lseg' | 'box' | 'path' | 'polygon' | 'circle' | 'cidr' | 'inet' | 'macaddr' | 'macaddr8' | 'bit' | 'varbit' | 'tsvector' | 'tsquery' | 'uuid' | 'xml' | 'json' | 'jsonb' | 'int4range' | 'int8range' | 'numrange' | 'tsrange' | 'tstzrange' | 'daterange' | 'int4multirange' | 'int8multirange' | 'nummultirange' | 'tsmultirange' | 'tstzmultirange' | 'datemultirange' | 'oid' | 'regproc' | 'regprocedure' | 'regoper' | 'regoperator' | 'regclass' | 'regtype' | 'regrole' | 'regnamespace' | 'regconfig' | 'regdictionary' | PostGISType | `${PostGISType}:tuple` | 'halfvec' | 'sparsevec' | 'vector';
type PostgresAliasType = 'int2' | 'integer' | 'int4' | 'int8' | 'decimal' | 'real' | 'double' | 'double precision' | 'serial2' | 'serial4' | 'serial8' | 'character' | 'character varying' | 'time with time zone' | 'time without time zone' | 'timestamp with time zone' | 'timestamp without time zone' | 'boolean' | 'bit varying';
type PostgresColumnType = PostgresType | PostgresAliasType;
declare function resolvePgTypeAlias(type: string): string;
type PgCodecs = Codecs<PostgresType>;
declare const castToText: CastCodec;
declare const castToTextArr: CastArrayCodec;
/** Used for cases when casting requires to unwrap and rebuild arrays
 *
 * @example
 * string_mtx::text[][] // can be casted to array directly
 *
 * encode(bytea_mtx, 'base64')[][] // invalid syntax, cast requires unwrapping and rebuilding array
 */
declare const arrayCompatCast: (cast: CastCodec) => (name: SQLChunk, arrayDimensions: number | undefined) => SQLChunk;
/** Used to recursively apply value normalizer to array of unknown dimensions */
declare const arrayCompatNormalize: (normalize: NormalizeCodec) => NormalizeArrayCodec;
/** Doesn't mutate original data - used for insertions */
declare const arrayCompatNormalizeInput: (normalize: NormalizeCodec, transformToPgArray?: boolean) => NormalizeArrayCodec;
/** Parses a raw PG array text representation, then applies a per-item normalizer */
declare const parsePgArrayAndNormalize: (normalize: NormalizeCodec) => NormalizeArrayCodec;
declare const parseLineTuple: (v: string) => [number, number, number];
declare const parseLineABC: (v: string) => {
  a: number;
  b: number;
  c: number;
};
declare const parsePointTuple: (v: string) => [number, number];
declare const parsePointXY: (v: string) => {
  x: number;
  y: number;
};
declare const parseGeometryTuple: (v: string) => [number, number];
declare const parseGeometryXY: (v: string) => {
  x: number;
  y: number;
};
declare const textToDate: (v: string) => Date;
declare const textToDateWithTz: (v: string) => Date;
declare const parsePgVector: (v: string) => number[];
declare const genericPgCodecs: {
  readonly bytea: {
    readonly castInJson: (name: SQLChunk) => __sql_sql_ts0.SQL<unknown>;
    readonly castArrayInJson: (name: SQLChunk, arrayDimensions: number | undefined) => SQLChunk;
    readonly normalizeInJson: (v: string) => Buffer<ArrayBuffer>;
    readonly normalizeArrayInJson: NormalizeArrayCodec;
  };
  readonly bigint: {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
    readonly normalizeInJson: BigIntConstructor;
    readonly normalizeArrayInJson: NormalizeArrayCodec;
  };
  readonly 'bigint:number': {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
    readonly normalize: NumberConstructor;
    readonly normalizeArray: NormalizeArrayCodec;
    readonly normalizeInJson: NumberConstructor;
    readonly normalizeArrayInJson: NormalizeArrayCodec;
  };
  readonly 'bigint:string': {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
  };
  readonly bigserial: {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
    readonly normalizeInJson: BigIntConstructor;
    readonly normalizeArrayInJson: NormalizeArrayCodec;
    readonly normalize: BigIntConstructor;
    readonly normalizeArray: NormalizeArrayCodec;
  };
  readonly 'bigserial:number': {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
    readonly normalize: NumberConstructor;
    readonly normalizeArray: NormalizeArrayCodec;
    readonly normalizeInJson: NumberConstructor;
    readonly normalizeArrayInJson: NormalizeArrayCodec;
  };
  readonly date: {
    readonly normalizeInJson: (v: string) => Date;
    readonly normalizeArrayInJson: NormalizeArrayCodec;
  };
  readonly 'date:string': {};
  readonly enum: {
    readonly castArray: CastArrayCodec;
    readonly normalizeParamArray: typeof makePgArray;
  };
  readonly 'geometry(point)': {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
    readonly normalize: (v: string) => {
      x: number;
      y: number;
    };
    readonly normalizeArray: NormalizeArrayCodec;
    readonly normalizeInJson: (v: string) => {
      x: number;
      y: number;
    };
    readonly normalizeArrayInJson: NormalizeArrayCodec;
  };
  readonly 'geometry(point):tuple': {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
    readonly normalize: (v: string) => [number, number];
    readonly normalizeArray: NormalizeArrayCodec;
    readonly normalizeInJson: (v: string) => [number, number];
    readonly normalizeArrayInJson: NormalizeArrayCodec;
  };
  readonly interval: {
    readonly castArrayInJson: CastArrayCodec;
  };
  readonly json: {
    readonly normalizeParamArray: NormalizeArrayCodec;
  };
  readonly jsonb: {
    readonly normalizeParamArray: NormalizeArrayCodec;
  };
  readonly line: {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
    readonly normalize: (v: string) => {
      a: number;
      b: number;
      c: number;
    };
    readonly normalizeArray: NormalizeArrayCodec;
    readonly normalizeInJson: (v: string) => {
      a: number;
      b: number;
      c: number;
    };
    readonly normalizeArrayInJson: NormalizeArrayCodec;
  };
  readonly 'line:tuple': {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
    readonly normalize: (v: string) => [number, number, number];
    readonly normalizeArray: NormalizeArrayCodec;
    readonly normalizeInJson: (v: string) => [number, number, number];
    readonly normalizeArrayInJson: NormalizeArrayCodec;
  };
  readonly numeric: {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
    readonly castArray: CastArrayCodec;
  };
  readonly 'numeric:number': {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
    readonly castArray: CastArrayCodec;
    readonly normalize: NumberConstructor;
    readonly normalizeArray: NormalizeArrayCodec;
    readonly normalizeInJson: NumberConstructor;
    readonly normalizeArrayInJson: NormalizeArrayCodec;
  };
  readonly 'numeric:bigint': {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
    readonly castArray: CastArrayCodec;
    readonly normalize: BigIntConstructor;
    readonly normalizeArray: NormalizeArrayCodec;
    readonly normalizeInJson: BigIntConstructor;
    readonly normalizeArrayInJson: NormalizeArrayCodec;
  };
  readonly point: {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
    readonly normalize: (v: string) => {
      x: number;
      y: number;
    };
    readonly normalizeArray: NormalizeArrayCodec;
    readonly normalizeInJson: (v: string) => {
      x: number;
      y: number;
    };
    readonly normalizeArrayInJson: NormalizeArrayCodec;
  };
  readonly 'point:tuple': {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
    readonly normalize: (v: string) => [number, number];
    readonly normalizeArray: NormalizeArrayCodec;
    readonly normalizeInJson: (v: string) => [number, number];
    readonly normalizeArrayInJson: NormalizeArrayCodec;
  };
  readonly timestamp: {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
    readonly normalizeInJson: (v: string) => Date;
    readonly normalizeArrayInJson: NormalizeArrayCodec;
  };
  readonly timestamptz: {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
    readonly normalizeInJson: (v: string) => Date;
    readonly normalizeArrayInJson: NormalizeArrayCodec;
  };
  readonly 'timestamp:string': {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
  };
  readonly 'timestamptz:string': {
    readonly castInJson: CastCodec;
    readonly castArrayInJson: CastArrayCodec;
  };
  readonly halfvec: {
    readonly normalize: (v: string) => number[];
    readonly normalizeArray: NormalizeArrayCodec;
    readonly normalizeInJson: (v: string) => number[];
    readonly normalizeArrayInJson: NormalizeArrayCodec;
  };
  readonly vector: {
    readonly normalize: (v: string) => number[];
    readonly normalizeArray: NormalizeArrayCodec;
    readonly normalizeInJson: (v: string) => number[];
    readonly normalizeArrayInJson: NormalizeArrayCodec;
  };
};
declare const refineGenericPgCodecs: (extension?: PartialWithUndefined<PgCodecs>) => PgCodecs;
//#endregion
export { PgCodecs, PostGISType, PostgresAliasType, PostgresColumnType, PostgresType, arrayCompatCast, arrayCompatNormalize, arrayCompatNormalizeInput, castToText, castToTextArr, genericPgCodecs, parseGeometryTuple, parseGeometryXY, parseLineABC, parseLineTuple, parsePgArrayAndNormalize, parsePgVector, parsePointTuple, parsePointXY, refineGenericPgCodecs, resolvePgTypeAlias, textToDate, textToDateWithTz };
//# sourceMappingURL=codecs.d.ts.map