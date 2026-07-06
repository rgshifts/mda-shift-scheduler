Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
const require_runtime = require('../_virtual/_rolldown/runtime.cjs');
let __entity_ts = require("../entity.cjs");
let __utils_ts = require("../utils.cjs");
let __sql_sql_ts = require("../sql/sql.cjs");
let __logger_ts = require("../logger.cjs");
let __cache_core_index_ts = require("../cache/core/index.cjs");
let __relations_ts = require("../relations.cjs");
let __sqlite_core_index_ts = require("../sqlite-core/index.cjs");
let __sqlite_core_session_ts = require("../sqlite-core/session.cjs");

//#region src/better-sqlite3/session.ts
var BetterSQLiteSession = class extends __sqlite_core_session_ts.SQLiteSession {
	static [__entity_ts.entityKind] = "BetterSQLiteSession";
	logger;
	cache;
	constructor(client, dialect, relations, schema, options = {}) {
		super(dialect);
		this.client = client;
		this.relations = relations;
		this.schema = schema;
		this.options = options;
		this.logger = options.logger ?? new __logger_ts.NoopLogger();
		this.cache = options.cache ?? new __cache_core_index_ts.NoopCache();
	}
	prepareQuery(query, fields, executeMethod, customResultMapper, queryMetadata, cacheConfig) {
		return new PreparedQuery(this.client.prepare(query.sql), query, this.logger, this.cache, queryMetadata, cacheConfig, fields, executeMethod, this.options.useJitMappers, customResultMapper);
	}
	prepareRelationalQuery(query, fields, executeMethod, customResultMapper, config) {
		return new PreparedQuery(this.client.prepare(query.sql), query, this.logger, this.cache, void 0, void 0, fields, executeMethod, this.options.useJitMappers, customResultMapper, true, config);
	}
	transaction(transaction, config = {}) {
		const tx = new BetterSQLiteTransaction("sync", this.dialect, this, this.relations, this.schema);
		return this.client.transaction(transaction)[config.behavior ?? "deferred"](tx);
	}
};
var BetterSQLiteTransaction = class BetterSQLiteTransaction extends __sqlite_core_index_ts.SQLiteTransaction {
	static [__entity_ts.entityKind] = "BetterSQLiteTransaction";
	transaction(transaction) {
		const savepointName = `sp${this.nestedIndex}`;
		const tx = new BetterSQLiteTransaction("sync", this.dialect, this.session, this.relations, this.schema, this.nestedIndex + 1);
		this.session.run(__sql_sql_ts.sql.raw(`savepoint ${savepointName}`));
		try {
			const result = transaction(tx);
			this.session.run(__sql_sql_ts.sql.raw(`release savepoint ${savepointName}`));
			return result;
		} catch (err) {
			this.session.run(__sql_sql_ts.sql.raw(`rollback to savepoint ${savepointName}`));
			throw err;
		}
	}
};
var PreparedQuery = class extends __sqlite_core_session_ts.SQLitePreparedQuery {
	static [__entity_ts.entityKind] = "BetterSQLitePreparedQuery";
	jitMapper;
	constructor(stmt, query, logger, cache, queryMetadata, cacheConfig, fields, executeMethod, useJitMappers, customResultMapper, isRqbV2Query, rqbConfig) {
		super("sync", executeMethod, query, cache, queryMetadata, cacheConfig);
		this.stmt = stmt;
		this.logger = logger;
		this.fields = fields;
		this.useJitMappers = useJitMappers;
		this.customResultMapper = customResultMapper;
		this.isRqbV2Query = isRqbV2Query;
		this.rqbConfig = rqbConfig;
	}
	run(placeholderValues) {
		const params = (0, __sql_sql_ts.fillPlaceholders)(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		return this.stmt.run(...params);
	}
	all(placeholderValues) {
		if (this.isRqbV2Query) return this.allRqbV2(placeholderValues);
		const { fields, joinsNotNullableMap, query, logger, stmt, customResultMapper } = this;
		if (!fields && !customResultMapper) {
			const params = (0, __sql_sql_ts.fillPlaceholders)(query.params, placeholderValues ?? {});
			logger.logQuery(query.sql, params);
			return stmt.all(...params);
		}
		const rows = this.values(placeholderValues);
		if (customResultMapper) return customResultMapper(rows);
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? (0, __utils_ts.makeJitQueryMapper)(fields, joinsNotNullableMap))(rows) : rows.map((row) => (0, __utils_ts.mapResultRow)(fields, row, joinsNotNullableMap));
	}
	get(placeholderValues) {
		if (this.isRqbV2Query) return this.getRqbV2(placeholderValues);
		const params = (0, __sql_sql_ts.fillPlaceholders)(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		const { fields, stmt, joinsNotNullableMap, customResultMapper } = this;
		if (!fields && !customResultMapper) return stmt.get(...params);
		const row = stmt.raw().get(...params);
		if (!row) return;
		if (customResultMapper) return customResultMapper([row]);
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? (0, __utils_ts.makeJitQueryMapper)(fields, joinsNotNullableMap))([row])[0] : (0, __utils_ts.mapResultRow)(fields, row, joinsNotNullableMap);
	}
	allRqbV2(placeholderValues) {
		const { query, logger, stmt, customResultMapper } = this;
		const params = (0, __sql_sql_ts.fillPlaceholders)(query.params, placeholderValues ?? {});
		logger.logQuery(query.sql, params);
		const rows = stmt.all(...params);
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? (0, __relations_ts.makeJitRqbMapper)(this.rqbConfig))(rows) : customResultMapper(rows);
	}
	getRqbV2(placeholderValues) {
		const params = (0, __sql_sql_ts.fillPlaceholders)(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		const { stmt, customResultMapper } = this;
		const row = stmt.get(...params);
		if (row === void 0) return row;
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? (0, __relations_ts.makeJitRqbMapper)(this.rqbConfig))([row]) : customResultMapper([row]);
	}
	values(placeholderValues) {
		const params = (0, __sql_sql_ts.fillPlaceholders)(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		return this.stmt.raw().all(...params);
	}
};

//#endregion
exports.BetterSQLiteSession = BetterSQLiteSession;
exports.BetterSQLiteTransaction = BetterSQLiteTransaction;
exports.PreparedQuery = PreparedQuery;
//# sourceMappingURL=session.cjs.map