import { makePgArray, parsePgArray } from "./array.js";
import { parseEWKB } from "./columns/postgis_extension/utils.js";
import { refineCodecs } from "../codecs.js";
import { sql } from "../sql/sql.js";

//#region src/pg-core/codecs.ts
const PG_ALIAS_TO_TYPE_MAP = {
	int2: "smallint",
	integer: "int",
	int4: "int",
	int8: "bigint",
	decimal: "numeric",
	real: "float4",
	double: "float8",
	"double precision": "float8",
	serial2: "smallserial",
	serial4: "serial",
	serial8: "bigserial",
	character: "char",
	"character varying": "varchar",
	"time with time zone": "timetz",
	"time without time zone": "time",
	"timestamp with time zone": "timestamptz",
	"timestamp without time zone": "timestamp",
	boolean: "bool",
	"bit varying": "varbit"
};
function resolvePgTypeAlias(type) {
	return PG_ALIAS_TO_TYPE_MAP[type] ?? type;
}
const castToText = (name) => sql`${name}::text`;
const castToTextArr = (name, arrayDimensions) => sql`${name}::text${sql.raw("[]".repeat(arrayDimensions))}`;
/** Used for cases when casting requires to unwrap and rebuild arrays
*
* @example
* string_mtx::text[][] // can be casted to array directly
*
* encode(bytea_mtx, 'base64')[][] // invalid syntax, cast requires unwrapping and rebuilding array
*/
const arrayCompatCast = (cast) => (name, arrayDimensions) => {
	if (!arrayDimensions) return cast(name);
	const aliases = [];
	for (let i = 0; i < arrayDimensions; i++) aliases.push(sql.identifier(`s${i}`));
	let indexed = name;
	for (const alias of aliases) indexed = sql`${indexed}[${alias}]`;
	let expression = sql`array(\
select ${cast(indexed)} \
from generate_subscripts(${name}, ${sql.raw(arrayDimensions.toString())}) ${aliases[arrayDimensions - 1]} \
order by ${aliases[arrayDimensions - 1]})`;
	for (let dim = arrayDimensions - 1; dim > 0; dim--) expression = sql`array(\
select ${expression} \
from generate_subscripts(${name}, ${sql.raw(dim.toString())}) ${aliases[dim - 1]} \
order by ${aliases[dim - 1]})`;
	return sql`case when ${name} is null then null else ${expression} end`;
};
/** Used to recursively apply value normalizer to array of unknown dimensions */
const arrayCompatNormalize = (normalize) => {
	const loop = (value, arrayDimensions) => {
		const innerDimensions = arrayDimensions - 1;
		if (arrayDimensions > 1) for (let i = 0; i < value.length; ++i) loop(value[i], innerDimensions);
		else for (let i = 0; i < value.length; ++i) value[i] = normalize(value[i]);
		return value;
	};
	return loop;
};
/** Doesn't mutate original data - used for insertions */
const arrayCompatNormalizeInput = (normalize, transformToPgArray = false) => {
	const loop = (value, arrayDimensions) => {
		const innerDimensions = arrayDimensions - 1;
		const out = Array.from({ length: value.length });
		if (arrayDimensions > 1) for (let i = 0; i < value.length; ++i) out[i] = loop(value[i], innerDimensions);
		else for (let i = 0; i < value.length; ++i) out[i] = normalize(value[i]);
		return out;
	};
	return transformToPgArray ? (v, d) => makePgArray(loop(v, d)) : loop;
};
/** Parses a raw PG array text representation, then applies a per-item normalizer */
const parsePgArrayAndNormalize = (normalize) => {
	const codec = arrayCompatNormalize(normalize);
	return (value, arrayDimensions) => codec(parsePgArray(value), arrayDimensions);
};
const parseLineTuple = (v) => {
	const [a, b, c] = v.slice(1, -1).split(",");
	return [
		Number.parseFloat(a),
		Number.parseFloat(b),
		Number.parseFloat(c)
	];
};
const parseLineABC = (v) => {
	const [a, b, c] = v.slice(1, -1).split(",");
	return {
		a: Number.parseFloat(a),
		b: Number.parseFloat(b),
		c: Number.parseFloat(c)
	};
};
const parsePointTuple = (v) => {
	const [x, y] = v.slice(1, -1).split(",");
	return [Number.parseFloat(x), Number.parseFloat(y)];
};
const parsePointXY = (v) => {
	const [x, y] = v.slice(1, -1).split(",");
	return {
		x: Number.parseFloat(x),
		y: Number.parseFloat(y)
	};
};
const parseGeometryTuple = (v) => parseEWKB(v).point;
const parseGeometryXY = (v) => {
	const parsed = parseEWKB(v);
	return {
		x: parsed.point[0],
		y: parsed.point[1]
	};
};
const textToDate = (v) => new Date(v);
const textToDateWithTz = (v) => /* @__PURE__ */ new Date(v + "+0000");
const parsePgVector = (v) => {
	const body = v.slice(1, -1);
	if (body.length === 0) return [];
	return body.split(",").map(Number.parseFloat);
};
const genericPgCodecs = {
	bytea: {
		castInJson: (name) => sql`encode(${name}, 'base64')`,
		castArrayInJson: arrayCompatCast((name) => sql`encode(${name}, 'base64')`),
		normalizeInJson: (v) => Buffer.from(v, "base64"),
		normalizeArrayInJson: arrayCompatNormalize((v) => Buffer.from(v, "base64"))
	},
	bigint: {
		castInJson: castToText,
		castArrayInJson: castToTextArr,
		normalizeInJson: BigInt,
		normalizeArrayInJson: arrayCompatNormalize(BigInt)
	},
	"bigint:number": {
		castInJson: castToText,
		castArrayInJson: castToTextArr,
		normalize: Number,
		normalizeArray: arrayCompatNormalize(Number),
		normalizeInJson: Number,
		normalizeArrayInJson: arrayCompatNormalize(Number)
	},
	"bigint:string": {
		castInJson: castToText,
		castArrayInJson: castToTextArr
	},
	bigserial: {
		castInJson: castToText,
		castArrayInJson: castToTextArr,
		normalizeInJson: BigInt,
		normalizeArrayInJson: arrayCompatNormalize(BigInt),
		normalize: BigInt,
		normalizeArray: arrayCompatNormalize(BigInt)
	},
	"bigserial:number": {
		castInJson: castToText,
		castArrayInJson: castToTextArr,
		normalize: Number,
		normalizeArray: arrayCompatNormalize(Number),
		normalizeInJson: Number,
		normalizeArrayInJson: arrayCompatNormalize(Number)
	},
	date: {
		normalizeInJson: textToDate,
		normalizeArrayInJson: arrayCompatNormalize(textToDate)
	},
	"date:string": {},
	enum: {
		castArray: castToTextArr,
		normalizeParamArray: makePgArray
	},
	"geometry(point)": {
		castInJson: castToText,
		castArrayInJson: castToTextArr,
		normalize: parseGeometryXY,
		normalizeArray: arrayCompatNormalize(parseGeometryXY),
		normalizeInJson: parseGeometryXY,
		normalizeArrayInJson: arrayCompatNormalize(parseGeometryXY)
	},
	"geometry(point):tuple": {
		castInJson: castToText,
		castArrayInJson: castToTextArr,
		normalize: parseGeometryTuple,
		normalizeArray: arrayCompatNormalize(parseGeometryTuple),
		normalizeInJson: parseGeometryTuple,
		normalizeArrayInJson: arrayCompatNormalize(parseGeometryTuple)
	},
	interval: { castArrayInJson: castToTextArr },
	json: { normalizeParamArray: arrayCompatNormalizeInput((v) => JSON.stringify(v), true) },
	jsonb: { normalizeParamArray: arrayCompatNormalizeInput((v) => JSON.stringify(v), true) },
	line: {
		castInJson: castToText,
		castArrayInJson: castToTextArr,
		normalize: parseLineABC,
		normalizeArray: arrayCompatNormalize(parseLineABC),
		normalizeInJson: parseLineABC,
		normalizeArrayInJson: arrayCompatNormalize(parseLineABC)
	},
	"line:tuple": {
		castInJson: castToText,
		castArrayInJson: castToTextArr,
		normalize: parseLineTuple,
		normalizeArray: arrayCompatNormalize(parseLineTuple),
		normalizeInJson: parseLineTuple,
		normalizeArrayInJson: arrayCompatNormalize(parseLineTuple)
	},
	numeric: {
		castInJson: castToText,
		castArrayInJson: castToTextArr,
		castArray: castToTextArr
	},
	"numeric:number": {
		castInJson: castToText,
		castArrayInJson: castToTextArr,
		castArray: castToTextArr,
		normalize: Number,
		normalizeArray: arrayCompatNormalize(Number),
		normalizeInJson: Number,
		normalizeArrayInJson: arrayCompatNormalize(Number)
	},
	"numeric:bigint": {
		castInJson: castToText,
		castArrayInJson: castToTextArr,
		castArray: castToTextArr,
		normalize: BigInt,
		normalizeArray: arrayCompatNormalize(BigInt),
		normalizeInJson: BigInt,
		normalizeArrayInJson: arrayCompatNormalize(BigInt)
	},
	point: {
		castInJson: castToText,
		castArrayInJson: castToTextArr,
		normalize: parsePointXY,
		normalizeArray: arrayCompatNormalize(parsePointXY),
		normalizeInJson: parsePointXY,
		normalizeArrayInJson: arrayCompatNormalize(parsePointXY)
	},
	"point:tuple": {
		castInJson: castToText,
		castArrayInJson: castToTextArr,
		normalize: parsePointTuple,
		normalizeArray: arrayCompatNormalize(parsePointTuple),
		normalizeInJson: parsePointTuple,
		normalizeArrayInJson: arrayCompatNormalize(parsePointTuple)
	},
	timestamp: {
		castInJson: castToText,
		castArrayInJson: castToTextArr,
		normalizeInJson: textToDateWithTz,
		normalizeArrayInJson: arrayCompatNormalize(textToDateWithTz)
	},
	timestamptz: {
		castInJson: castToText,
		castArrayInJson: castToTextArr,
		normalizeInJson: textToDate,
		normalizeArrayInJson: arrayCompatNormalize(textToDate)
	},
	"timestamp:string": {
		castInJson: castToText,
		castArrayInJson: castToTextArr
	},
	"timestamptz:string": {
		castInJson: castToText,
		castArrayInJson: castToTextArr
	},
	halfvec: {
		normalize: parsePgVector,
		normalizeArray: parsePgArrayAndNormalize(parsePgVector),
		normalizeInJson: parsePgVector,
		normalizeArrayInJson: arrayCompatNormalize(parsePgVector)
	},
	vector: {
		normalize: parsePgVector,
		normalizeArray: parsePgArrayAndNormalize(parsePgVector),
		normalizeInJson: parsePgVector,
		normalizeArrayInJson: arrayCompatNormalize(parsePgVector)
	}
};
const refineGenericPgCodecs = (extension) => refineCodecs(genericPgCodecs, extension);

//#endregion
export { arrayCompatCast, arrayCompatNormalize, arrayCompatNormalizeInput, castToText, castToTextArr, genericPgCodecs, parseGeometryTuple, parseGeometryXY, parseLineABC, parseLineTuple, parsePgArrayAndNormalize, parsePgVector, parsePointTuple, parsePointXY, refineGenericPgCodecs, resolvePgTypeAlias, textToDate, textToDateWithTz };
//# sourceMappingURL=codecs.js.map