import { PgRemoteSession } from "./session.js";
import { entityKind } from "../entity.js";
import { jitCompatCheck } from "../utils.js";
import { DefaultLogger } from "../logger.js";
import { genericPgCodecs } from "../pg-core/codecs.js";
import { PgAsyncDatabase } from "../pg-core/async/db.js";
import { PgDialect } from "../pg-core/dialect.js";

//#region src/pg-proxy/driver.ts
var PgRemoteDatabase = class extends PgAsyncDatabase {
	static [entityKind] = "PgRemoteDatabase";
};
function drizzle(callback, config = {}, _dialect = () => new PgDialect({
	useJitMappers: jitCompatCheck(config.jit),
	codecs: config.codecs ?? genericPgCodecs
})) {
	const dialect = _dialect();
	let logger;
	if (config.logger === true) logger = new DefaultLogger();
	else if (config.logger !== false) logger = config.logger;
	const relations = config.relations ?? {};
	const db = new PgRemoteDatabase(dialect, new PgRemoteSession(callback, dialect, relations, {
		logger,
		cache: config.cache
	}), relations);
	db.$cache = config.cache;
	if (db.$cache) db.$cache["invalidate"] = config.cache?.onMutate;
	return db;
}

//#endregion
export { PgRemoteDatabase, drizzle };
//# sourceMappingURL=driver.js.map