import { MySqlColumn } from "./columns/common.js";
import { MySqlTable } from "./table.js";
import { MySqlViewBase } from "./view-base.js";
import { entityKind, is } from "../entity.js";
import { Subquery } from "../subquery.js";
import { ViewBaseConfig } from "../view-common.js";
import { Table, TableColumns, getTableName } from "../table.js";
import { Column } from "../column.js";
import { make$ReturningResponseMapper, makeDefaultQueryMapper, makeJitQueryMapper, orderSelectedFields } from "../utils.js";
import { Param, SQL, View, isSQLWrapper, sql } from "../sql/sql.js";
import { One, getTableAsAliasSQL, makeDefaultRqbMapper, makeJitRqbMapper, relationExtrasToSQL, relationToSQL, relationsFilterToSQL, relationsOrderToSQL } from "../relations.js";
import { getMigrationsToRun } from "../migrator.utils.js";
import { DrizzleError } from "../errors.js";
import { aliasedTable, getOriginalColumnFromAlias } from "../alias.js";
import { and } from "../sql/expressions/index.js";
import { upgradeIfNeeded } from "../up-migrations/mysql.js";

//#region src/mysql-core/dialect.ts
var MySqlDialect = class {
	static [entityKind] = "MySqlDialect";
	mapperGenerators;
	constructor(config) {
		if (config?.escapeParam) this.escapeParam = config.escapeParam;
		this.mapperGenerators = config?.useJitMappers ? {
			rows: makeJitQueryMapper,
			relationalRows: makeJitRqbMapper,
			$returning: make$ReturningResponseMapper
		} : {
			rows: makeDefaultQueryMapper,
			relationalRows: makeDefaultRqbMapper,
			$returning: make$ReturningResponseMapper
		};
	}
	async migrate(migrations, session, config) {
		const migrationsTable = config.migrationsTable ?? "__drizzle_migrations";
		const { newDb } = await upgradeIfNeeded(migrationsTable, session, migrations);
		if (newDb) {
			const migrationTableCreate = sql`
			CREATE TABLE IF NOT EXISTS ${sql.identifier(migrationsTable)} (
				id SERIAL PRIMARY KEY,
				hash TEXT NOT NULL,
				created_at BIGINT,
				name TEXT,
				applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`;
			await session.execute(migrationTableCreate);
		}
		const dbMigrations = await session.objects(sql`select id, hash, created_at, name from ${sql.identifier(migrationsTable)}`);
		if (typeof config === "object" && config.init) {
			if (dbMigrations.length) return { exitCode: "databaseMigrations" };
			if (migrations.length > 1) return { exitCode: "localMigrations" };
			const [migration] = migrations;
			if (!migration) return;
			await session.execute(sql`insert into ${sql.identifier(migrationsTable)} (\`hash\`, \`created_at\`, \`name\`) values(${migration.hash}, ${migration.folderMillis}, ${migration.name})`);
			return;
		}
		const migrationsToRun = getMigrationsToRun({
			localMigrations: migrations,
			dbMigrations
		});
		await session.transaction(async (tx) => {
			for (const migration of migrationsToRun) {
				for (const stmt of migration.sql) await tx.execute(sql.raw(stmt));
				await tx.execute(sql`insert into ${sql.identifier(migrationsTable)} (\`hash\`, \`created_at\`, \`name\`) values(${migration.hash}, ${migration.folderMillis}, ${migration.name})`);
			}
		});
	}
	escapeName(name) {
		return `\`${name.replace(/`/g, "``")}\``;
	}
	escapeParam(_num) {
		return `?`;
	}
	escapeString(str) {
		return `'${str.replace(/'/g, "''")}'`;
	}
	buildWithCTE(queries) {
		if (!queries?.length) return void 0;
		const withSqlChunks = [sql`with `];
		for (const [i, w] of queries.entries()) {
			withSqlChunks.push(sql`${sql.identifier(w._.alias)} as (${w._.sql})`);
			if (i < queries.length - 1) withSqlChunks.push(sql`, `);
		}
		withSqlChunks.push(sql` `);
		return sql.join(withSqlChunks);
	}
	buildDeleteQuery({ table, where, returning, withList, limit, orderBy, comment }) {
		const withSql = this.buildWithCTE(withList);
		const returningSql = returning ? sql` returning ${this.buildSelection(returning, { isSingleTable: true })}` : void 0;
		return sql`${withSql}delete from ${table}${where ? sql` where ${where}` : void 0}${this.buildOrderBy(orderBy)}${this.buildLimit(limit)}${returningSql}${comment !== void 0 ? sql` ${comment}` : void 0}`;
	}
	buildUpdateSet(table, set) {
		const tableColumns = table[Table.Symbol.Columns];
		const columnNames = Object.keys(tableColumns).filter((colName) => set[colName] !== void 0 || tableColumns[colName]?.onUpdateFn !== void 0);
		const setLength = columnNames.length;
		return sql.join(columnNames.flatMap((colName, i) => {
			const col = tableColumns[colName];
			const onUpdateFnResult = col.onUpdateFn?.();
			const value = set[colName] ?? (is(onUpdateFnResult, SQL) ? onUpdateFnResult : sql.param(onUpdateFnResult, col));
			const res = sql`${sql.identifier(col.name)} = ${value}`;
			if (i < setLength - 1) return [res, sql.raw(", ")];
			return [res];
		}));
	}
	buildUpdateQuery({ table, set, where, returning, withList, limit, orderBy, comment }) {
		const withSql = this.buildWithCTE(withList);
		const setSql = this.buildUpdateSet(table, set);
		const returningSql = returning ? sql` returning ${this.buildSelection(returning, { isSingleTable: true })}` : void 0;
		return sql`${withSql}update ${table} set ${setSql}${where ? sql` where ${where}` : void 0}${this.buildOrderBy(orderBy)}${this.buildLimit(limit)}${returningSql}${comment !== void 0 ? sql` ${comment}` : void 0}`;
	}
	/**
	* Builds selection SQL with provided fields/expressions
	*
	* Examples:
	*
	* `select <selection> from`
	*
	* `insert ... returning <selection>`
	*
	* If `isSingleTable` is true, then columns won't be prefixed with table name
	*/
	buildSelection(fields, { isSingleTable = false } = {}) {
		const columnsLen = fields.length;
		const chunks = fields.flatMap(({ field }, i) => {
			const chunk = [];
			if (is(field, SQL.Aliased) && field.isSelectionField) {
				if (!isSingleTable && field.origin !== void 0) chunk.push(sql.identifier(field.origin), sql.raw("."));
				chunk.push(sql.identifier(field.fieldAlias));
			} else if (is(field, SQL.Aliased) || is(field, SQL)) {
				const query = is(field, SQL.Aliased) ? field.sql : field;
				if (isSingleTable) {
					const newSql = new SQL(query.queryChunks.map((c) => {
						if (is(c, MySqlColumn)) return sql.identifier(c.name);
						return c;
					}));
					chunk.push(query.shouldInlineParams ? newSql.inlineParams() : newSql);
				} else chunk.push(query);
				if (is(field, SQL.Aliased)) chunk.push(sql` as ${sql.identifier(field.fieldAlias)}`);
			} else if (is(field, Column)) if (isSingleTable) chunk.push(field.isAlias ? sql`${sql.identifier(getOriginalColumnFromAlias(field).name)} as ${field}` : sql.identifier(field.name));
			else chunk.push(field.isAlias ? sql`${getOriginalColumnFromAlias(field)} as ${field}` : field);
			else if (is(field, Subquery)) {
				const entries = Object.entries(field._.selectedFields);
				if (entries.length === 1) {
					const entry = entries[0][1];
					const fieldDecoder = is(entry, SQL) ? entry.decoder : is(entry, Column) ? { mapFromDriverValue: (v) => entry.mapFromDriverValue(v) } : entry.sql.decoder;
					if (fieldDecoder) field._.sql.decoder = fieldDecoder;
				}
				chunk.push(field);
			}
			if (i < columnsLen - 1) chunk.push(sql`, `);
			return chunk;
		});
		return sql.join(chunks);
	}
	buildLimit(limit) {
		return typeof limit === "object" || typeof limit === "number" && limit >= 0 ? sql` limit ${limit}` : void 0;
	}
	buildOrderBy(orderBy) {
		return orderBy && orderBy.length > 0 ? sql` order by ${sql.join(orderBy, sql`, `)}` : void 0;
	}
	buildIndex({ indexes, indexFor }) {
		return indexes && indexes.length > 0 ? sql` ${sql.raw(indexFor)} INDEX ${indexes.map((it) => sql.identifier(it))}` : void 0;
	}
	buildSelectQuery({ withList, fields, fieldsFlat, where, having, table, joins, orderBy, groupBy, limit, offset, lockingClause, distinct, setOperators, useIndex, forceIndex, ignoreIndex, comment }) {
		const fieldsList = fieldsFlat ?? orderSelectedFields(fields);
		for (const f of fieldsList) if (is(f.field, Column) && getTableName(f.field.table) !== (is(table, Subquery) ? table._.alias : is(table, MySqlViewBase) ? table[ViewBaseConfig].name : is(table, SQL) ? void 0 : getTableName(table)) && !((table) => joins?.some(({ alias }) => alias === (table[Table.Symbol.IsAlias] ? getTableName(table) : table[Table.Symbol.BaseName])))(f.field.table)) {
			const tableName = getTableName(f.field.table);
			throw new Error(`Your "${f.path.join("->")}" field references a column "${tableName}"."${f.field.name}", but the table "${tableName}" is not part of the query! Did you forget to join it?`);
		}
		const isSingleTable = !joins || joins.length === 0;
		const withSql = this.buildWithCTE(withList);
		const distinctSql = distinct ? sql` distinct` : void 0;
		const selection = this.buildSelection(fieldsList, { isSingleTable });
		const tableSql = (() => {
			if (is(table, Table) && table[Table.Symbol.IsAlias]) return sql`${table[Table.Symbol.Schema] ? sql`${sql.identifier(table[Table.Symbol.Schema])}.` : void 0}${sql.identifier(table[Table.Symbol.OriginalName])} ${sql.identifier(table[Table.Symbol.Name])}`;
			if (is(table, View) && table[ViewBaseConfig].isAlias) {
				let fullName = sql`${sql.identifier(table[ViewBaseConfig].originalName)}`;
				if (table[ViewBaseConfig].schema) fullName = sql`${sql.identifier(table[ViewBaseConfig].schema)}.${fullName}`;
				return sql`${fullName} ${sql.identifier(table[ViewBaseConfig].name)}`;
			}
			return table;
		})();
		const joinsArray = [];
		if (joins) for (const [index, joinMeta] of joins.entries()) {
			if (index === 0) joinsArray.push(sql` `);
			const table = joinMeta.table;
			const lateralSql = joinMeta.lateral ? sql` lateral` : void 0;
			const onSql = joinMeta.on ? sql` on ${joinMeta.on}` : void 0;
			if (is(table, MySqlTable)) {
				const tableName = table[MySqlTable.Symbol.Name];
				const tableSchema = table[MySqlTable.Symbol.Schema];
				const origTableName = table[MySqlTable.Symbol.OriginalName];
				const alias = tableName === origTableName ? void 0 : joinMeta.alias;
				const useIndexSql = this.buildIndex({
					indexes: joinMeta.useIndex,
					indexFor: "USE"
				});
				const forceIndexSql = this.buildIndex({
					indexes: joinMeta.forceIndex,
					indexFor: "FORCE"
				});
				const ignoreIndexSql = this.buildIndex({
					indexes: joinMeta.ignoreIndex,
					indexFor: "IGNORE"
				});
				joinsArray.push(sql`${sql.raw(joinMeta.joinType)} join${lateralSql} ${tableSchema ? sql`${sql.identifier(tableSchema)}.` : void 0}${sql.identifier(origTableName)}${useIndexSql}${forceIndexSql}${ignoreIndexSql}${alias && sql` ${sql.identifier(alias)}`}${onSql}`);
			} else if (is(table, View)) {
				const viewName = table[ViewBaseConfig].name;
				const viewSchema = table[ViewBaseConfig].schema;
				const origViewName = table[ViewBaseConfig].originalName;
				const alias = viewName === origViewName ? void 0 : joinMeta.alias;
				joinsArray.push(sql`${sql.raw(joinMeta.joinType)} join${lateralSql} ${viewSchema ? sql`${sql.identifier(viewSchema)}.` : void 0}${sql.identifier(origViewName)}${alias && sql` ${sql.identifier(alias)}`}${onSql}`);
			} else joinsArray.push(sql`${sql.raw(joinMeta.joinType)} join${lateralSql} ${table}${onSql}`);
			if (index < joins.length - 1) joinsArray.push(sql` `);
		}
		const joinsSql = sql.join(joinsArray);
		const whereSql = where ? sql` where ${where}` : void 0;
		const havingSql = having ? sql` having ${having}` : void 0;
		const orderBySql = this.buildOrderBy(orderBy);
		const groupBySql = groupBy && groupBy.length > 0 ? sql` group by ${sql.join(groupBy, sql`, `)}` : void 0;
		const limitSql = this.buildLimit(limit);
		const offsetSql = offset ? sql` offset ${offset}` : void 0;
		const useIndexSql = this.buildIndex({
			indexes: useIndex,
			indexFor: "USE"
		});
		const forceIndexSql = this.buildIndex({
			indexes: forceIndex,
			indexFor: "FORCE"
		});
		const ignoreIndexSql = this.buildIndex({
			indexes: ignoreIndex,
			indexFor: "IGNORE"
		});
		let lockingClausesSql;
		if (lockingClause) {
			const { config, strength } = lockingClause;
			lockingClausesSql = sql` for ${sql.raw(strength)}`;
			if (config.noWait) lockingClausesSql.append(sql` nowait`);
			else if (config.skipLocked) lockingClausesSql.append(sql` skip locked`);
		}
		const finalQuery = sql`${withSql}select${distinctSql} ${selection} from ${tableSql}${useIndexSql}${forceIndexSql}${ignoreIndexSql}${joinsSql}${whereSql}${groupBySql}${havingSql}${orderBySql}${limitSql}${offsetSql}${lockingClausesSql}${comment !== void 0 ? sql` ${comment}` : void 0}`;
		if (setOperators.length > 0) return this.buildSetOperations(finalQuery, setOperators);
		return finalQuery;
	}
	buildSetOperations(leftSelect, setOperators) {
		const [setOperator, ...rest] = setOperators;
		if (!setOperator) throw new Error("Cannot pass undefined values to any set operator");
		if (rest.length === 0) return this.buildSetOperationQuery({
			leftSelect,
			setOperator
		});
		return this.buildSetOperations(this.buildSetOperationQuery({
			leftSelect,
			setOperator
		}), rest);
	}
	buildSetOperationQuery({ leftSelect, setOperator: { type, isAll, rightSelect, limit, orderBy, offset } }) {
		const leftChunk = sql`(${leftSelect.getSQL()}) `;
		const rightChunk = sql`(${rightSelect.getSQL()})`;
		let orderBySql;
		if (orderBy && orderBy.length > 0) {
			const orderByValues = [];
			for (const orderByUnit of orderBy) if (is(orderByUnit, MySqlColumn)) orderByValues.push(sql.identifier(orderByUnit.name));
			else if (is(orderByUnit, SQL)) {
				for (let i = 0; i < orderByUnit.queryChunks.length; i++) {
					const chunk = orderByUnit.queryChunks[i];
					if (is(chunk, MySqlColumn)) orderByUnit.queryChunks[i] = sql.identifier(chunk.name);
				}
				orderByValues.push(sql`${orderByUnit}`);
			} else orderByValues.push(sql`${orderByUnit}`);
			orderBySql = sql` order by ${sql.join(orderByValues, sql`, `)} `;
		}
		const limitSql = typeof limit === "object" || typeof limit === "number" && limit >= 0 ? sql` limit ${limit}` : void 0;
		const operatorChunk = sql.raw(`${type} ${isAll ? "all " : ""}`);
		const offsetSql = offset ? sql` offset ${offset}` : void 0;
		return sql`${leftChunk}${operatorChunk}${rightChunk}${orderBySql}${limitSql}${offsetSql}`;
	}
	buildInsertQuery({ table, values: valuesOrSelect, ignore, onConflict, select, comment }) {
		const valuesSqlList = [];
		const columns = table[Table.Symbol.Columns];
		const colEntries = Object.entries(columns).filter(([_, col]) => !col.shouldDisableInsert());
		const insertOrder = colEntries.map(([, column]) => sql.identifier(column.name));
		const generatedIdsResponse = [];
		if (select) {
			const select = valuesOrSelect;
			if (is(select, SQL)) valuesSqlList.push(select);
			else valuesSqlList.push(select.getSQL());
		} else {
			const values = valuesOrSelect;
			valuesSqlList.push(sql.raw("values "));
			for (const [valueIndex, value] of values.entries()) {
				const generatedIds = {};
				const valueList = [];
				for (const [fieldName, col] of colEntries) {
					const colValue = value[fieldName];
					if (colValue === void 0 || is(colValue, Param) && colValue.value === void 0) if (col.defaultFn !== void 0) {
						const defaultFnResult = col.defaultFn();
						generatedIds[fieldName] = defaultFnResult;
						const defaultValue = is(defaultFnResult, SQL) ? defaultFnResult : sql.param(defaultFnResult, col);
						valueList.push(defaultValue);
					} else if (!col.default && col.onUpdateFn !== void 0) {
						const onUpdateFnResult = col.onUpdateFn();
						const newValue = is(onUpdateFnResult, SQL) ? onUpdateFnResult : sql.param(onUpdateFnResult, col);
						valueList.push(newValue);
					} else valueList.push(sql`default`);
					else {
						if (col.defaultFn && is(colValue, Param)) generatedIds[fieldName] = colValue.value;
						valueList.push(colValue);
					}
				}
				generatedIdsResponse.push(generatedIds);
				valuesSqlList.push(valueList);
				if (valueIndex < values.length - 1) valuesSqlList.push(sql`, `);
			}
		}
		const valuesSql = sql.join(valuesSqlList);
		return {
			sql: sql`insert${ignore ? sql` ignore` : void 0} into ${table} ${insertOrder} ${valuesSql}${onConflict ? sql` on duplicate key ${onConflict}` : void 0}${comment !== void 0 ? sql` ${comment}` : void 0}`,
			generatedIds: generatedIdsResponse
		};
	}
	sqlToQuery(sql, invokeSource) {
		return sql.toQuery({
			escapeName: this.escapeName,
			escapeParam: this.escapeParam,
			escapeString: this.escapeString,
			invokeSource
		});
	}
	nestedSelectionerror() {
		throw new DrizzleError({ message: `Views with nested selections are not supported by the relational query builder` });
	}
	buildRqbColumn(table, column, key, inJson) {
		if (is(column, Column)) {
			const name = sql`${table}.${sql.identifier(column.name)}`;
			if (!inJson) return sql`${name} as ${sql.identifier(key)}`;
			switch (column.columnType) {
				case "MySqlBinary":
				case "MySqlVarBinary":
				case "MySqlTime":
				case "MySqlDateTimeString":
				case "MySqlTimestampString":
				case "MySqlFloat":
				case "MySqlDecimal":
				case "MySqlDecimalNumber":
				case "MySqlDecimalBigInt":
				case "MySqlBigInt64":
				case "MySqlBigIntString": return sql`cast(${name} as char) as ${sql.identifier(key)}`;
				case "MySqlBlob":
				case "MySqlBlobBuffer": return sql`to_base64(${name}) as ${sql.identifier(key)}`;
				case "MySqlCustomColumn": return sql`${column.jsonSelectIdentifier(name, sql)} as ${sql.identifier(key)}`;
				default: return sql`${name} as ${sql.identifier(key)}`;
			}
		}
		return sql`${table}.${is(column, SQL.Aliased) ? sql.identifier(column.fieldAlias) : isSQLWrapper(column) ? sql.identifier(key) : this.nestedSelectionerror()} as ${sql.identifier(key)}`;
	}
	unwrapAllColumns = (table, selection, inJson) => {
		return sql.join(Object.entries(table[TableColumns]).map(([k, v]) => {
			selection.push({
				key: k,
				field: v
			});
			return this.buildRqbColumn(table, v, k, inJson);
		}), sql`, `);
	};
	getSelectedTableColumns = (table, columns) => {
		const selectedColumns = [];
		const columnContainer = table[TableColumns];
		const entries = Object.entries(columns);
		let colSelectionMode;
		for (const [k, v] of entries) {
			if (v === void 0) continue;
			colSelectionMode = colSelectionMode || v;
			if (v) {
				const column = columnContainer[k];
				selectedColumns.push({
					column,
					tsName: k
				});
			}
		}
		if (colSelectionMode === false) for (const [k, v] of Object.entries(columnContainer)) {
			if (columns[k] === false) continue;
			selectedColumns.push({
				column: v,
				tsName: k
			});
		}
		return selectedColumns;
	};
	buildColumns = (table, selection, inJson, params) => params?.columns ? (() => {
		const columnIdentifiers = [];
		const selectedColumns = this.getSelectedTableColumns(table, params.columns);
		for (const { column, tsName } of selectedColumns) {
			columnIdentifiers.push(this.buildRqbColumn(table, column, tsName, inJson));
			selection.push({
				key: tsName,
				field: column
			});
		}
		return columnIdentifiers.length ? sql.join(columnIdentifiers, sql`, `) : void 0;
	})() : this.unwrapAllColumns(table, selection, inJson);
	buildRelationalQuery({ schema, table, tableConfig, queryConfig: config, relationWhere, mode, errorPath, depth, isNestedMany, throughJoin, nested }) {
		const selection = [];
		const isSingle = mode === "first";
		const params = config === true ? void 0 : config;
		const currentPath = errorPath ?? "";
		const currentDepth = depth ?? 0;
		if (!currentDepth) table = aliasedTable(table, `d${currentDepth}`);
		const limit = isSingle ? 1 : params?.limit;
		const offset = params?.offset;
		const columns = this.buildColumns(table, selection, !!nested, params);
		const where = params?.where && relationWhere ? and(relationsFilterToSQL(table, params.where, tableConfig.relations, schema), relationWhere) : params?.where ? relationsFilterToSQL(table, params.where, tableConfig.relations, schema) : relationWhere;
		const order = params?.orderBy ? relationsOrderToSQL(table, params.orderBy) : void 0;
		const extras = params?.extras ? relationExtrasToSQL(table, params.extras) : void 0;
		if (extras) selection.push(...extras.selection);
		const selectionArr = columns ? [columns] : [];
		if (extras?.sql) selectionArr.push(extras.sql);
		const joins = params ? (() => {
			const { with: joins } = params;
			if (!joins) return;
			const withEntries = Object.entries(joins).filter(([_, v]) => v);
			if (!withEntries.length) return;
			return sql.join(withEntries.map(([k, join]) => {
				selectionArr.push(sql`${sql.identifier(k)}.${sql.identifier("r")} as ${sql.identifier(k)}`);
				const relation = tableConfig.relations[k];
				const isSingle = is(relation, One);
				const targetTable = aliasedTable(relation.targetTable, `d${currentDepth + 1}`);
				const throughTable = relation.throughTable ? aliasedTable(relation.throughTable, `tr${currentDepth}`) : void 0;
				const { filter, joinCondition } = relationToSQL(relation, table, targetTable, throughTable);
				const throughJoin = throughTable ? sql` inner join ${getTableAsAliasSQL(throughTable)} on ${joinCondition}` : void 0;
				const innerQuery = this.buildRelationalQuery({
					table: targetTable,
					mode: isSingle ? "first" : "many",
					schema,
					queryConfig: join,
					tableConfig: schema[relation.targetTableName],
					relationWhere: filter,
					errorPath: `${currentPath.length ? `${currentPath}.` : ""}${k}`,
					depth: currentDepth + 1,
					isNestedMany: !isSingle,
					throughJoin,
					nested: true
				});
				selection.push({
					field: targetTable,
					key: k,
					selection: innerQuery.selection,
					isArray: !isSingle,
					isOptional: (relation.optional ?? false) || join !== true && !!join.where
				});
				const jsonColumns = sql.join(innerQuery.selection.map((s) => sql`${sql.raw(this.escapeString(s.key))}, ${sql.identifier(s.key)}`), sql`, `);
				return sql` left join lateral(select ${sql`${isSingle ? sql`json_object(${jsonColumns})` : sql`coalesce(json_arrayagg(json_object(${jsonColumns})), json_array())`} as ${sql.identifier("r")}`} from (${innerQuery.sql}) as ${sql.identifier("t")}) as ${sql.identifier(k)} on true`;
			}));
		})() : void 0;
		if (!selectionArr.length) throw new DrizzleError({ message: `No fields selected for table "${tableConfig.name}"${currentPath ? ` ("${currentPath}")` : ""}` });
		if (isNestedMany && order) selectionArr.push(sql`row_number() over (order by ${order})`);
		const selectionSet = sql.join(selectionArr, sql`, `);
		const comment = config !== true && config?.comment ? sql.comment(config.comment) : void 0;
		return {
			sql: sql`select ${selectionSet} from ${getTableAsAliasSQL(table)}${throughJoin}${joins ? sql`${joins}` : void 0}${where ? sql` where ${where}` : void 0}${order ? sql` order by ${order}` : void 0}${limit !== void 0 ? sql` limit ${limit}` : void 0}${offset !== void 0 ? sql` offset ${offset}` : void 0}${comment ? sql` ${comment}` : void 0}`,
			selection
		};
	}
};

//#endregion
export { MySqlDialect };
//# sourceMappingURL=dialect.js.map