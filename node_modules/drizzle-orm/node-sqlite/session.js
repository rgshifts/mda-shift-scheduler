import { entityKind } from "../entity.js";
import { makeJitQueryMapper, mapResultRow } from "../utils.js";
import { fillPlaceholders, sql } from "../sql/sql.js";
import { NoopLogger } from "../logger.js";
import { makeJitRqbMapper } from "../relations.js";
import { SQLiteTransaction } from "../sqlite-core/index.js";
import { SQLitePreparedQuery, SQLiteSession } from "../sqlite-core/session.js";

//#region src/node-sqlite/session.ts
var NodeSQLiteSession = class extends SQLiteSession {
	static [entityKind] = "SQLJsSession";
	logger;
	constructor(client, dialect, relations, schema, options = {}) {
		super(dialect);
		this.client = client;
		this.relations = relations;
		this.schema = schema;
		this.options = options;
		this.logger = options.logger ?? new NoopLogger();
	}
	prepareQuery(query, fields, executeMethod, customResultMapper) {
		return new NodeSQLitePreparedQuery(this.client.prepare(query.sql), query, this.logger, fields, executeMethod, this.options.useJitMappers, customResultMapper);
	}
	prepareRelationalQuery(query, fields, executeMethod, customResultMapper, config) {
		return new NodeSQLitePreparedQuery(this.client.prepare(query.sql), query, this.logger, fields, executeMethod, this.options.useJitMappers, customResultMapper, true, config);
	}
	transaction(transaction, config = {}) {
		const tx = new NodeSQLiteTransaction("sync", this.dialect, this, this.relations, this.schema);
		this.run(sql.raw(`begin${config.behavior ? ` ${config.behavior}` : ""}`));
		try {
			const result = transaction(tx);
			this.run(sql`commit`);
			return result;
		} catch (err) {
			this.run(sql`rollback`);
			throw err;
		}
	}
};
var NodeSQLiteTransaction = class NodeSQLiteTransaction extends SQLiteTransaction {
	static [entityKind] = "SQLJsTransaction";
	transaction(transaction) {
		const savepointName = `sp${this.nestedIndex + 1}`;
		const tx = new NodeSQLiteTransaction("sync", this.dialect, this.session, this.relations, this.schema, this.nestedIndex + 1);
		tx.run(sql.raw(`savepoint ${savepointName}`));
		try {
			const result = transaction(tx);
			tx.run(sql.raw(`release savepoint ${savepointName}`));
			return result;
		} catch (err) {
			tx.run(sql.raw(`rollback to savepoint ${savepointName}`));
			throw err;
		}
	}
};
var NodeSQLitePreparedQuery = class extends SQLitePreparedQuery {
	static [entityKind] = "SQLJsPreparedQuery";
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
		const params = fillPlaceholders(this.query.params, placeholderValues);
		this.logger.logQuery(this.query.sql, params);
		return stmt.run(...params);
	}
	all(placeholderValues = {}) {
		if (this.isRqbV2Query) return this.allRqbV2(placeholderValues);
		const { stmt } = this;
		const { fields, joinsNotNullableMap, logger, query, customResultMapper } = this;
		if (!fields && !customResultMapper) {
			const params = fillPlaceholders(query.params, placeholderValues);
			logger.logQuery(query.sql, params);
			stmt.setReturnArrays(false);
			return stmt.all(...params);
		}
		stmt.setReturnArrays(true);
		const rows = this.values(placeholderValues);
		if (customResultMapper) return customResultMapper(rows);
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? makeJitQueryMapper(fields, joinsNotNullableMap))(rows) : rows.map((row) => mapResultRow(fields, row, joinsNotNullableMap));
	}
	allRqbV2(placeholderValues = {}) {
		const { stmt } = this;
		const { logger, query, customResultMapper } = this;
		const params = fillPlaceholders(query.params, placeholderValues);
		logger.logQuery(query.sql, params);
		stmt.setReturnArrays(false);
		const rows = stmt.all(...params).map((row) => ({ ...row }));
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? makeJitRqbMapper(this.rqbConfig))(rows) : customResultMapper(rows);
	}
	get(placeholderValues = {}) {
		if (this.isRqbV2Query) return this.getRqbV2(placeholderValues);
		const { stmt } = this;
		const params = fillPlaceholders(this.query.params, placeholderValues);
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
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? makeJitQueryMapper(fields, joinsNotNullableMap))([row])[0] : mapResultRow(fields, row, joinsNotNullableMap);
	}
	getRqbV2(placeholderValues = {}) {
		const { stmt } = this;
		const params = fillPlaceholders(this.query.params, placeholderValues);
		this.logger.logQuery(this.query.sql, params);
		const { customResultMapper } = this;
		stmt.setReturnArrays(false);
		const row = stmt.get(...params);
		if (!row) return;
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? makeJitRqbMapper(this.rqbConfig))([row]) : customResultMapper([{ ...row }]);
	}
	values(placeholderValues = {}) {
		const { stmt } = this;
		const params = fillPlaceholders(this.query.params, placeholderValues);
		this.logger.logQuery(this.query.sql, params);
		stmt.setReturnArrays(true);
		return stmt.all(...params);
	}
};

//#endregion
export { NodeSQLitePreparedQuery, NodeSQLiteSession, NodeSQLiteTransaction };
//# sourceMappingURL=session.js.map