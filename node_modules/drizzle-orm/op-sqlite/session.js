import { entityKind } from "../entity.js";
import { makeJitQueryMapper, mapResultRow } from "../utils.js";
import { fillPlaceholders, sql } from "../sql/sql.js";
import { NoopLogger } from "../logger.js";
import { NoopCache } from "../cache/core/index.js";
import { makeJitRqbMapper } from "../relations.js";
import { SQLiteTransaction } from "../sqlite-core/index.js";
import { SQLitePreparedQuery, SQLiteSession } from "../sqlite-core/session.js";

//#region src/op-sqlite/session.ts
var OPSQLiteSession = class extends SQLiteSession {
	static [entityKind] = "OPSQLiteSession";
	logger;
	cache;
	constructor(client, dialect, relations, schema, options = {}) {
		super(dialect);
		this.client = client;
		this.relations = relations;
		this.schema = schema;
		this.options = options;
		this.logger = options.logger ?? new NoopLogger();
		this.cache = options.cache ?? new NoopCache();
	}
	prepareQuery(query, fields, executeMethod, customResultMapper, queryMetadata, cacheConfig) {
		return new OPSQLitePreparedQuery(this.client, query, this.logger, this.cache, queryMetadata, cacheConfig, fields, executeMethod, this.options.useJitMappers, customResultMapper);
	}
	prepareRelationalQuery(query, fields, executeMethod, customResultMapper, config) {
		return new OPSQLitePreparedQuery(this.client, query, this.logger, this.cache, void 0, void 0, fields, executeMethod, this.options.useJitMappers, customResultMapper, true, config);
	}
	transaction(transaction, config = {}) {
		const tx = new OPSQLiteTransaction("async", this.dialect, this, this.relations, this.schema);
		this.run(sql.raw(`begin${config?.behavior ? " " + config.behavior : ""}`));
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
var OPSQLiteTransaction = class OPSQLiteTransaction extends SQLiteTransaction {
	static [entityKind] = "OPSQLiteTransaction";
	transaction(transaction) {
		const savepointName = `sp${this.nestedIndex}`;
		const tx = new OPSQLiteTransaction("async", this.dialect, this.session, this.relations, this.schema, this.nestedIndex + 1);
		this.session.run(sql.raw(`savepoint ${savepointName}`));
		try {
			const result = transaction(tx);
			this.session.run(sql.raw(`release savepoint ${savepointName}`));
			return result;
		} catch (err) {
			this.session.run(sql.raw(`rollback to savepoint ${savepointName}`));
			throw err;
		}
	}
};
var OPSQLitePreparedQuery = class extends SQLitePreparedQuery {
	static [entityKind] = "OPSQLitePreparedQuery";
	jitMapper;
	constructor(client, query, logger, cache, queryMetadata, cacheConfig, fields, executeMethod, useJitMappers, customResultMapper, isRqbV2Query, rqbConfig) {
		super("sync", executeMethod, query, cache, queryMetadata, cacheConfig);
		this.client = client;
		this.logger = logger;
		this.fields = fields;
		this.useJitMappers = useJitMappers;
		this.customResultMapper = customResultMapper;
		this.isRqbV2Query = isRqbV2Query;
		this.rqbConfig = rqbConfig;
	}
	async run(placeholderValues) {
		const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		return await this.queryWithCache(this.query.sql, params, async () => {
			return this.client.executeAsync(this.query.sql, params);
		});
	}
	async all(placeholderValues) {
		if (this.isRqbV2Query) return this.allRqbV2(placeholderValues);
		const { fields, joinsNotNullableMap, query, logger, customResultMapper, client } = this;
		if (!fields && !customResultMapper) {
			const params = fillPlaceholders(query.params, placeholderValues ?? {});
			logger.logQuery(query.sql, params);
			return await this.queryWithCache(query.sql, params, async () => {
				return client.execute(query.sql, params).rows?._array || [];
			});
		}
		const rows = await this.values(placeholderValues);
		if (customResultMapper) return customResultMapper(rows);
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? makeJitQueryMapper(fields, joinsNotNullableMap))(rows) : rows.map((row) => mapResultRow(fields, row, joinsNotNullableMap));
	}
	async allRqbV2(placeholderValues) {
		const { query, logger, customResultMapper, client } = this;
		const params = fillPlaceholders(query.params, placeholderValues ?? {});
		logger.logQuery(query.sql, params);
		const rows = client.execute(query.sql, params).rows?._array || [];
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? makeJitRqbMapper(this.rqbConfig))(rows) : customResultMapper(rows);
	}
	async get(placeholderValues) {
		if (this.isRqbV2Query) return this.getRqbV2(placeholderValues);
		const { fields, joinsNotNullableMap, customResultMapper, query, logger, client } = this;
		const params = fillPlaceholders(query.params, placeholderValues ?? {});
		logger.logQuery(query.sql, params);
		if (!fields && !customResultMapper) return (await this.queryWithCache(query.sql, params, async () => {
			return client.execute(query.sql, params).rows?._array || [];
		}))[0];
		const rows = await this.values(placeholderValues);
		const row = rows[0];
		if (!row) return;
		if (customResultMapper) return customResultMapper(rows);
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? makeJitQueryMapper(fields, joinsNotNullableMap))([row])[0] : mapResultRow(fields, row, joinsNotNullableMap);
	}
	async getRqbV2(placeholderValues) {
		const { customResultMapper, query, logger, client } = this;
		const params = fillPlaceholders(query.params, placeholderValues ?? {});
		logger.logQuery(query.sql, params);
		const rows = client.execute(query.sql, params).rows?._array || [];
		const row = rows[0];
		if (!row) return;
		return this.useJitMappers ? (this.jitMapper = this.jitMapper ?? makeJitRqbMapper(this.rqbConfig))(rows) : customResultMapper([row]);
	}
	async values(placeholderValues) {
		const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		return await this.queryWithCache(this.query.sql, params, async () => {
			return await this.client.executeRawAsync(this.query.sql, params);
		});
	}
};

//#endregion
export { OPSQLitePreparedQuery, OPSQLiteSession, OPSQLiteTransaction };
//# sourceMappingURL=session.js.map