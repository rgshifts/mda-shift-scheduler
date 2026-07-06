import { entityKind } from "../entity.js";
import { makeJitQueryMapper, mapResultRow } from "../utils.js";
import { fillPlaceholders } from "../sql/sql.js";
import { NoopLogger } from "../logger.js";
import { makeJitRqbMapper } from "../relations.js";
import { SQLiteTransaction } from "../sqlite-core/index.js";
import { SQLitePreparedQuery, SQLiteSession } from "../sqlite-core/session.js";

//#region src/durable-sqlite/session.ts
var SQLiteDOSession = class extends SQLiteSession {
	static [entityKind] = "SQLiteDOSession";
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
		return new SQLiteDOPreparedQuery(this.client, query, this.logger, fields, executeMethod, this.options.useJitMappers, customResultMapper);
	}
	prepareRelationalQuery(query, fields, executeMethod, customResultMapper, config) {
		return new SQLiteDOPreparedQuery(this.client, query, this.logger, fields, executeMethod, this.options.useJitMappers, customResultMapper, true, config);
	}
	transaction(transaction, _config) {
		const tx = new SQLiteDOTransaction("sync", this.dialect, this, this.relations, this.schema, void 0, false, true);
		return this.client.transactionSync(() => transaction(tx));
	}
};
var SQLiteDOTransaction = class SQLiteDOTransaction extends SQLiteTransaction {
	static [entityKind] = "SQLiteDOTransaction";
	transaction(transaction) {
		const tx = new SQLiteDOTransaction("sync", this.dialect, this.session, this.relations, this.schema, this.nestedIndex + 1, false, true);
		return this.session.transaction(() => transaction(tx));
	}
};
var SQLiteDOPreparedQuery = class extends SQLitePreparedQuery {
	static [entityKind] = "SQLiteDOPreparedQuery";
	jitMapper;
	constructor(client, query, logger, fields, executeMethod, useJitMappers, customResultMapper, isRqbV2Query, rqbConfig) {
		super("sync", executeMethod, query, void 0, void 0, void 0);
		this.client = client;
		this.logger = logger;
		this.fields = fields;
		this.useJitMappers = useJitMappers;
		this.customResultMapper = customResultMapper;
		this.isRqbV2Query = isRqbV2Query;
		this.rqbConfig = rqbConfig;
	}
	run(placeholderValues) {
		const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		if (params.length > 0) return this.client.sql.exec(this.query.sql, ...params);
		return this.client.sql.exec(this.query.sql);
	}
	all(placeholderValues) {
		if (this.isRqbV2Query) return this.allRqbV2(placeholderValues);
		const { fields, joinsNotNullableMap, query, logger, client, customResultMapper } = this;
		if (!fields && !customResultMapper) {
			const params = fillPlaceholders(query.params, placeholderValues ?? {});
			logger.logQuery(query.sql, params);
			return params.length > 0 ? client.sql.exec(query.sql, ...params).toArray() : client.sql.exec(query.sql).toArray();
		}
		const rows = this.values(placeholderValues);
		if (customResultMapper) return customResultMapper(rows);
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? makeJitQueryMapper(fields, joinsNotNullableMap))(rows) : rows.map((row) => mapResultRow(fields, row, joinsNotNullableMap));
	}
	allRqbV2(placeholderValues) {
		const { query, logger, client, customResultMapper } = this;
		const params = fillPlaceholders(query.params, placeholderValues ?? {});
		logger.logQuery(query.sql, params);
		const rows = params.length > 0 ? client.sql.exec(query.sql, ...params).toArray() : client.sql.exec(query.sql).toArray();
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? makeJitRqbMapper(this.rqbConfig))(rows) : customResultMapper(rows);
	}
	get(placeholderValues) {
		if (this.isRqbV2Query) return this.getRqbV2(placeholderValues);
		const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		const { fields, client, joinsNotNullableMap, customResultMapper, query } = this;
		if (!fields && !customResultMapper) return (params.length > 0 ? client.sql.exec(query.sql, ...params) : client.sql.exec(query.sql)).next().value;
		const rows = this.values(placeholderValues);
		const row = rows[0];
		if (!row) return;
		if (customResultMapper) return customResultMapper(rows);
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? makeJitQueryMapper(fields, joinsNotNullableMap))([row])[0] : mapResultRow(fields, row, joinsNotNullableMap);
	}
	getRqbV2(placeholderValues) {
		const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		const { client, customResultMapper, query } = this;
		const row = (params.length > 0 ? client.sql.exec(query.sql, ...params) : client.sql.exec(query.sql)).next().value;
		if (!row) return;
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? makeJitRqbMapper(this.rqbConfig))([row]) : customResultMapper([row]);
	}
	values(placeholderValues) {
		const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		return (params.length > 0 ? this.client.sql.exec(this.query.sql, ...params) : this.client.sql.exec(this.query.sql)).raw().toArray();
	}
};

//#endregion
export { SQLiteDOPreparedQuery, SQLiteDOSession, SQLiteDOTransaction };
//# sourceMappingURL=session.js.map