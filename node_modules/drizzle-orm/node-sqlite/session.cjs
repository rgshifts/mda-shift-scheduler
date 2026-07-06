Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
const require_runtime = require('../_virtual/_rolldown/runtime.cjs');
let __entity_ts = require("../entity.cjs");
let __utils_ts = require("../utils.cjs");
let __sql_sql_ts = require("../sql/sql.cjs");
let __logger_ts = require("../logger.cjs");
let __relations_ts = require("../relations.cjs");
let __sqlite_core_index_ts = require("../sqlite-core/index.cjs");
let __sqlite_core_session_ts = require("../sqlite-core/session.cjs");

//#region src/node-sqlite/session.ts
var NodeSQLiteSession = class extends __sqlite_core_session_ts.SQLiteSession {
	static [__entity_ts.entityKind] = "SQLJsSession";
	logger;
	constructor(client, dialect, relations, schema, options = {}) {
		super(dialect);
		this.client = client;
		this.relations = relations;
		this.schema = schema;
		this.options = options;
		this.logger = options.logger ?? new __logger_ts.NoopLogger();
	}
	prepareQuery(query, fields, executeMethod, customResultMapper) {
		return new NodeSQLitePreparedQuery(this.client.prepare(query.sql), query, this.logger, fields, executeMethod, this.options.useJitMappers, customResultMapper);
	}
	prepareRelationalQuery(query, fields, executeMethod, customResultMapper, config) {
		return new NodeSQLitePreparedQuery(this.client.prepare(query.sql), query, this.logger, fields, executeMethod, this.options.useJitMappers, customResultMapper, true, config);
	}
	transaction(transaction, config = {}) {
		const tx = new NodeSQLiteTransaction("sync", this.dialect, this, this.relations, this.schema);
		this.run(__sql_sql_ts.sql.raw(`begin${config.behavior ? ` ${config.behavior}` : ""}`));
		try {
			const result = transaction(tx);
			this.run(__sql_sql_ts.sql`commit`);
			return result;
		} catch (err) {
			this.run(__sql_sql_ts.sql`rollback`);
			throw err;
		}
	}
};
var NodeSQLiteTransaction = class NodeSQLiteTransaction extends __sqlite_core_index_ts.SQLiteTransaction {
	static [__entity_ts.entityKind] = "SQLJsTransaction";
	transaction(transaction) {
		const savepointName = `sp${this.nestedIndex + 1}`;
		const tx = new NodeSQLiteTransaction("sync", this.dialect, this.session, this.relations, this.schema, this.nestedIndex + 1);
		tx.run(__sql_sql_ts.sql.raw(`savepoint ${savepointName}`));
		try {
			const result = transaction(tx);
			tx.run(__sql_sql_ts.sql.raw(`release savepoint ${savepointName}`));
			return result;
		} catch (err) {
			tx.run(__sql_sql_ts.sql.raw(`rollback to savepoint ${savepointName}`));
			throw err;
		}
	}
};
var NodeSQLitePreparedQuery = class extends __sqlite_core_session_ts.SQLitePreparedQuery {
	static [__entity_ts.entityKind] = "SQLJsPreparedQuery";
	jitMapper;
	constructor(stmt, query, logger, fields, executeMethod, useJitMappers, customResultMapper, isRqbV2Query, rqbConfig) {
		super("sync", executeMethod, query);
		this.stmt = stmt;
		this.logger = logger;
		this.fields = fields;
		this.useJitMappers = useJitMappers;
		this.customResultMapper = customResultMapper;
		this.isRqbV2Query = isRqbV2Query;
		this.rqbConfig = rqbConfig;
	}
	run(placeholderValues = {}) {
		const { stmt } = this;
		const params = (0, __sql_sql_ts.fillPlaceholders)(this.query.params, placeholderValues);
		this.logger.logQuery(this.query.sql, params);
		return stmt.run(...params);
	}
	all(placeholderValues = {}) {
		if (this.isRqbV2Query) return this.allRqbV2(placeholderValues);
		const { stmt } = this;
		const { fields, joinsNotNullableMap, logger, query, customResultMapper } = this;
		if (!fields && !customResultMapper) {
			const params = (0, __sql_sql_ts.fillPlaceholders)(query.params, placeholderValues);
			logger.logQuery(query.sql, params);
			stmt.setReturnArrays(false);
			return stmt.all(...params);
		}
		stmt.setReturnArrays(true);
		const rows = this.values(placeholderValues);
		if (customResultMapper) return customResultMapper(rows);
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? (0, __utils_ts.makeJitQueryMapper)(fields, joinsNotNullableMap))(rows) : rows.map((row) => (0, __utils_ts.mapResultRow)(fields, row, joinsNotNullableMap));
	}
	allRqbV2(placeholderValues = {}) {
		const { stmt } = this;
		const { logger, query, customResultMapper } = this;
		const params = (0, __sql_sql_ts.fillPlaceholders)(query.params, placeholderValues);
		logger.logQuery(query.sql, params);
		stmt.setReturnArrays(false);
		const rows = stmt.all(...params).map((row) => ({ ...row }));
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? (0, __relations_ts.makeJitRqbMapper)(this.rqbConfig))(rows) : customResultMapper(rows);
	}
	get(placeholderValues = {}) {
		if (this.isRqbV2Query) return this.getRqbV2(placeholderValues);
		const { stmt } = this;
		const params = (0, __sql_sql_ts.fillPlaceholders)(this.query.params, placeholderValues);
		this.logger.logQuery(this.query.sql, params);
		const { fields, joinsNotNullableMap, customResultMapper } = this;
		if (!fields && !customResultMapper) {
			stmt.setReturnArrays(false);
			return stmt.get(...params);
		}
		stmt.setReturnArrays(true);
		const row = stmt.get(...params);
		if (!row) return;
		if (customResultMapper) return customResultMapper([row]);
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? (0, __utils_ts.makeJitQueryMapper)(fields, joinsNotNullableMap))([row])[0] : (0, __utils_ts.mapResultRow)(fields, row, joinsNotNullableMap);
	}
	getRqbV2(placeholderValues = {}) {
		const { stmt } = this;
		const params = (0, __sql_sql_ts.fillPlaceholders)(this.query.params, placeholderValues);
		this.logger.logQuery(this.query.sql, params);
		const { customResultMapper } = this;
		stmt.setReturnArrays(false);
		const row = stmt.get(...params);
		if (!row) return;
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? (0, __relations_ts.makeJitRqbMapper)(this.rqbConfig))([row]) : customResultMapper([{ ...row }]);
	}
	values(placeholderValues = {}) {
		const { stmt } = this;
		const params = (0, __sql_sql_ts.fillPlaceholders)(this.query.params, placeholderValues);
		this.logger.logQuery(this.query.sql, params);
		stmt.setReturnArrays(true);
		return stmt.all(...params);
	}
};

//#endregion
exports.NodeSQLitePreparedQuery = NodeSQLitePreparedQuery;
exports.NodeSQLiteSession = NodeSQLiteSession;
exports.NodeSQLiteTransaction = NodeSQLiteTransaction;
//# sourceMappingURL=session.cjs.map