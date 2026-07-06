import { readMigrationFiles } from "../migrator.js";

//#region src/mysql2/migrator.ts
async function migrate(db, config) {
	const migrations = readMigrationFiles(config);
	return db.dialect.migrate(migrations, db.session, config);
}

//#endregion
export { migrate };
//# sourceMappingURL=migrator.js.map