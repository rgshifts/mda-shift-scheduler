import { MySqlRemoteSession } from "./session.js";
import { entityKind } from "../entity.js";
import { jitCompatCheck } from "../utils.js";
import { DefaultLogger } from "../logger.js";
import { MySqlDatabase } from "../mysql-core/db.js";
import { MySqlDialect } from "../mysql-core/dialect.js";

//#region src/mysql-proxy/driver.ts
var MySqlRemoteDatabase = class extends MySqlDatabase {
	static [entityKind] = "MySqlRemoteDatabase";
};
function drizzle(callback, config = {}, _dialect = (config) => new MySqlDialect(config)) {
	const dialect = _dialect({ useJitMappers: jitCompatCheck(config.jit) });
	let logger;
	if (config.logger === true) logger = new DefaultLogger();
	else if (config.logger !== false) logger = config.logger;
	const relations = config.relations ?? {};
	return new MySqlRemoteDatabase(dialect, new MySqlRemoteSession(callback, dialect, relations, { logger }), relations);
}

//#endregion
export { MySqlRemoteDatabase, drizzle };
//# sourceMappingURL=driver.js.map