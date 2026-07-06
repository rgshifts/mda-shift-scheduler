Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
const require_runtime = require('../_virtual/_rolldown/runtime.cjs');
const require_mysql_core_db = require('./db.cjs');
let __entity_ts = require("../entity.cjs");
let __utils_ts = require("../utils.cjs");
let __sql_sql_ts = require("../sql/sql.cjs");
let __errors_ts = require("../errors.cjs");
let __cache_core_cache_ts = require("../cache/core/cache.cjs");

//#region src/mysql-core/session.ts
var MySqlPreparedQuery = class {
	static [__entity_ts.entityKind] = "MySqlPreparedQuery";
	/** @internal */
	mapper;
	fastPath;
	constructor(executor, _iterator, query, mapper, mode, logger, cache, queryMetadata, cacheConfig) {
		this.executor = executor;
		this._iterator = _iterator;
		this.query = query;
		this.mode = mode;
		this.logger = logger;
		this.cache = cache;
		this.queryMetadata = queryMetadata;
		this.cacheConfig = cacheConfig;
		this.mapper = mapper;
		if (cache && cache.strategy() === "all" && cacheConfig === void 0) this.cacheConfig = {
			enabled: true,
			autoInvalidate: true
		};
		if (!this.cacheConfig?.enabled) this.cacheConfig = void 0;
		this.fastPath = cacheConfig === void 0 && (cache === void 0 || (0, __entity_ts.is)(cache, __cache_core_cache_ts.NoopCache));
	}
	/** @internal */
	async queryWithCache(queryString, params, query) {
		const cacheStrat = this.cache !== void 0 && !(0, __entity_ts.is)(this.cache, __cache_core_cache_ts.NoopCache) ? await (0, __cache_core_cache_ts.strategyFor)(queryString, params, this.queryMetadata, this.cacheConfig) : { type: "skip" };
		if (cacheStrat.type === "skip") return query().catch((e) => {
			throw new __errors_ts.DrizzleQueryError(queryString, params, e);
		});
		const cache = this.cache;
		if (cacheStrat.type === "invalidate") return Promise.all([query(), cache.onMutate({ tables: cacheStrat.tables })]).then((res) => res[0]).catch((e) => {
			throw new __errors_ts.DrizzleQueryError(queryString, params, e);
		});
		if (cacheStrat.type === "try") {
			const { tables, key, isTag, autoInvalidate, config } = cacheStrat;
			const fromCache = await cache.get(key, tables, isTag, autoInvalidate);
			if (fromCache === void 0) {
				const result = await query().catch((e) => {
					throw new __errors_ts.DrizzleQueryError(queryString, params, e);
				});
				await cache.put(key, result, autoInvalidate ? tables : [], isTag, config);
				return result;
			}
			return fromCache;
		}
		(0, __utils_ts.assertUnreachable)(cacheStrat);
	}
	async execute(placeholderValues = {}) {
		const { query, logger, executor, mapper, fastPath } = this;
		const sql = query._sql ? query._sql.join(" ") : query.sql;
		const params = query.params.length === 0 ? query.params : (0, __sql_sql_ts.fillPlaceholders)(query.params, placeholderValues);
		logger.logQuery(sql, params);
		const res = fastPath ? executor(params).catch((e) => {
			throw new __errors_ts.DrizzleQueryError(sql, params, e);
		}) : this.queryWithCache(sql, params, () => executor(params));
		if (!mapper) return res;
		return res.then((rows) => mapper(rows));
	}
	async *iterator(placeholderValues = {}) {
		const { query, logger, executor, _iterator, mapper, fastPath } = this;
		const sql = query._sql ? query._sql.join(" ") : query.sql;
		const params = query.params.length === 0 ? query.params : (0, __sql_sql_ts.fillPlaceholders)(query.params, placeholderValues);
		logger.logQuery(sql, params);
		if (_iterator) try {
			if (mapper) {
				for await (const row of _iterator(params)) yield mapper([row])[0];
				return;
			}
			for await (const row of _iterator(params)) yield row;
			return;
		} catch (e) {
			throw new __errors_ts.DrizzleQueryError(sql, params, e);
		}
		const rows = await (fastPath ? executor(params).catch((e) => {
			throw new __errors_ts.DrizzleQueryError(sql, params, e);
		}) : this.queryWithCache(sql, params, () => executor(params)));
		if (mapper) {
			for (const row of rows) yield mapper([row])[0];
			return;
		}
		for (const row of rows) yield row;
	}
};
var MySqlSession = class {
	static [__entity_ts.entityKind] = "MySqlSession";
	constructor(dialect) {
		this.dialect = dialect;
	}
	execute(query) {
		return this.prepareQuery(this.dialect.sqlToQuery(query), "raw").execute();
	}
	arrays(query) {
		return this.prepareQuery(this.dialect.sqlToQuery(query), "arrays").execute();
	}
	objects(query) {
		return this.prepareQuery(this.dialect.sqlToQuery(query), "objects").execute();
	}
	getSetTransactionSQL(config) {
		const parts = [];
		if (config.isolationLevel) parts.push(`isolation level ${config.isolationLevel}`);
		return parts.length ? __sql_sql_ts.sql`set transaction ${__sql_sql_ts.sql.raw(parts.join(" "))}` : void 0;
	}
	getStartTransactionSQL(config) {
		const parts = [];
		if (config.withConsistentSnapshot) parts.push("with consistent snapshot");
		if (config.accessMode) parts.push(config.accessMode);
		return parts.length ? __sql_sql_ts.sql`start transaction ${__sql_sql_ts.sql.raw(parts.join(" "))}` : void 0;
	}
};
var MySqlTransaction = class extends require_mysql_core_db.MySqlDatabase {
	static [__entity_ts.entityKind] = "MySqlTransaction";
	constructor(dialect, session, relations, nestedIndex) {
		super(dialect, session, relations);
		this.relations = relations;
		this.nestedIndex = nestedIndex;
	}
	rollback() {
		throw new __errors_ts.TransactionRollbackError();
	}
};

//#endregion
exports.MySqlPreparedQuery = MySqlPreparedQuery;
exports.MySqlSession = MySqlSession;
exports.MySqlTransaction = MySqlTransaction;
//# sourceMappingURL=session.cjs.map