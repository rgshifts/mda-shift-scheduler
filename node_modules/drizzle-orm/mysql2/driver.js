import { MySql2Session } from "./session.js";
import { entityKind } from "../entity.js";
import { jitCompatCheck } from "../utils.js";
import { DefaultLogger } from "../logger.js";
import { MySqlDatabase, MySqlDatabase as MySqlDatabase$1 } from "../mysql-core/db.js";
import { MySqlDialect } from "../mysql-core/dialect.js";
import { createPool } from "mysql2/promise";

//#region src/mysql2/driver.ts
var MySql2Database = class extends MySqlDatabase$1 {
	static [entityKind] = "MySql2Database";
};
function construct(client, config = {}) {
	const dialect = new MySqlDialect({ useJitMappers: jitCompatCheck(config.jit) });
	let logger;
	if (config.logger === true) logger = new DefaultLogger();
	else if (config.logger !== false) logger = config.logger;
	const clientForInstance = isCallbackClient(client) ? client.promise() : client;
	const relations = config.relations ?? {};
	const db = new MySql2Database(dialect, new MySql2Session(clientForInstance, dialect, relations, {
		logger,
		cache: config.cache
	}), relations);
	db.$client = client;
	db.$cache = config.cache;
	if (db.$cache) db.$cache["invalidate"] = config.cache?.onMutate;
	return db;
}
function isCallbackClient(client) {
	return typeof client.promise === "function";
}
function drizzle(...params) {
	if (typeof params[0] === "string") {
		const connectionString = params[0];
		return construct(createPool({ uri: connectionString }), params[1]);
	}
	const { connection, client, ...DrizzleMySqlConfig } = params[0];
	if (client) return construct(client, DrizzleMySqlConfig);
	return construct(typeof connection === "string" ? createPool({
		uri: connection,
		supportBigNumbers: true
	}) : createPool(connection), DrizzleMySqlConfig);
}
(function(_drizzle) {
	function mock(config) {
		return construct({}, config);
	}
	_drizzle.mock = mock;
})(drizzle || (drizzle = {}));

//#endregion
export { MySql2Database, MySqlDatabase, drizzle };
//# sourceMappingURL=driver.js.map