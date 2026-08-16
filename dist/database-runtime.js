// The Capsule runtime's Database adapters and dialect: the three engines, the seam they answer, the
// one shared method set every behavioural call goes through, and the app-schema DDL that method set
// emits. Batch 9 of the migration ADR-0041 records, and the last domain to leave
// `server-runtime-source.ts`.
//
// It went last on purpose. Every other domain reaches an engine through this file, so moving it
// earlier would have put a module boundary under every batch that ran before it. What that bought is
// visible in the import list below: nine migrated modules, more than any other module in the set,
// and not one of them a cycle.
//
// ADR-0037 is the seam this file implements and ADR-0034 the invariant its bodies keep. Neither is
// changed here: an engine still supplies statement primitives, a dialect and normalization and
// nothing else, every identifier still reaches an engine through `dialect.sql` (ADR-0039), and the
// conformance specification (ADR-0035) still runs the whole method set against SQLite, libSQL and
// Postgres. What moved is where the declarations live.
//
// ---------------------------------------------------------------------------------------------
// How the set was established, because ticket 04 says every estimate in the sequence has been wrong
//
// The ticket estimated ~55 and the domain is 59 declarations. That looks like the first accurate
// estimate in nine batches and it is not: the name sweep collected 51, of which **eight are not this
// domain's**, and it missed **sixteen** that are. The two errors nearly cancel, which is the shape
// batch 6 warned about — an estimate can look right while being wrong in both directions at once.
//
// **The reverse-graph pass** (batch 6's) seeded by name and asked which seeds have no in-domain
// caller. It flagged ten. Batch 7's refinement is what made it usable: that question flags entry
// points and foreigners alike, and only reading the body separates them. Two were this domain's own
// entry points (`createRuntimeInspectionAdapter`, and the inspection delegates below), and eight
// were foreign:
//
//   openDevDatabase                  the Capsule boot composition; it *calls* this file
//   createEndpointDatabaseApi        the composition core, named as such by ticket 04
//   createTransactionDatabase        composition too — it builds the `database` wrapper object
//   sqliteTypeForFieldKind           reads like the SQLite dialect's and is the schema extractor's:
//                                    it populates `field.sqliteType`, which `columnType` then reads
//   toSqlNumber                      named for SQL and belongs to the value codec; no SQL in it
//   fieldDefaultIsSqlNull            a schema predicate — kept, but only because the content sweep
//   fieldColumnDefaultSql            found their caller `appFieldColumnDefinition`, which is ours
//   listDatabaseTables / dumpDatabase   entry points, kept
//
// **The content sweep** (batch 8's) asked the other question: which top-level declarations *touch*
// this domain's subject matter regardless of what they are called. Batch 8 could not have been more
// direct about aiming this at batch 9, and it earned its place — but not the way it did for HTTP.
// The first pass swept for SQL text and `prepare`/`exec`/`all`/`get` shapes and collected 54 extra
// declarations, nearly all of them false: **every domain in this runtime emits SQL through these
// adapters**, so "touches SQL" selects consumers of the layer rather than members of it. Sharpening
// it to what only a *member* has — a dialect seam entry by name, a statement primitive being
// *defined* rather than called, engine wire bytes, an engine-specific error — is what made it answer.
//
// What it found that no reverse pass could, because a function never seeded has no graph entry:
//
//   isDuplicateColumnError                   engine-specific error text, `sqliteDatabaseDialect`'s
//   runSchemaExecIgnoringDuplicateColumn     the ALTER strategy that entry names
//   migrateAppSchemaInTransaction            twelve declarations of app-schema DDL and migration,
//   migrateExistingAppTableInTransaction     which are the shared method set's own bodies hoisted
//   createAppTable                           out of the object literal. `migrateAppSchema`,
//   appTableColumnDefinitions                `createAppTable` and `migrateExistingAppTable` are
//   appFieldColumnDefinition                 methods on this file's method set and their callers are
//   fieldDefaultIsSqlNull                    nothing else; ADR-0037's "every behavioural method body
//   fieldColumnDefaultSql                    comes from one shared module" is about exactly these,
//   columnSelectExpressionForMigration       and `appTableColumnDefinitions`' own comment records
//   addedFieldsForTable                      that the Postgres adapter used to carry a whole second
//   normalizeSchema                          copy of `createAppTable` for one quoting character.
//   hashSchema
//   assertAdditiveSchemaMigration
//   toSqlLiteral                             renders a value as SQL literal *text*; all three of its
//                                            callers are in this file
//   runReadOnlyQuery                         the third of a trio whose other two the name sweep took
//                                            (`listDatabaseTables`, `dumpDatabase`) and which its own
//                                            name does not answer to
//
// The two passes overlap on nothing. The reverse pass rejected eight seeds and kept two; the content
// sweep added sixteen and rejected none. Neither would have found the other's, which is batch 8's
// finding restated from the far side of it.
//
// ---------------------------------------------------------------------------------------------
// What could not stay behind, and where it went
//
// Closing this domain's reference graph left nine names outside it and **not one of them reaches the
// composition core** — the first batch since 4 for which that is true, and the reason 59 of 59
// declarations moved where batch 4 moved 34 of 51 and batch 8 32 of 33. Every one sorted into batch
// 5's case or batch 6's, and none into batch 4's:
//
//   createAnonymousAuthTables      auth's, and `auth-runtime.ts` had it back the moment its one
//                                  caller — this file's `ensureAuthStorage()` — was leaving. Batch
//                                  5's case: a blocker naming a domain, and that domain took it.
//   createLogIndexTables and the   a domain **ticket 04's nine batches never named**. Batch 1 was
//   eight declarations with it     the log-index *guard*; nothing was ever scoped to the index
//                                  itself. Batch 6's third case — owned by no batch on the list, so
//                                  extracted to `log-index-storage.ts` rather than waited for.
//   normalizeDateValue,            the value codec's writing half, which went to sit beside its
//   dateValueError                 reading half in `stored-value-coding.ts` (renamed from
//                                  `stored-row-decoding.ts` for holding both directions).
//   invalidReferenceError          `runtime-errors.ts`, on the cohesion argument that admitted
//                                  `assertJsonCompatible`: it does nothing but build a
//                                  `commandError`, and its two callers end up on opposite sides of
//                                  this file's boundary.
//
// The pattern under three of those four is one this migration kept finding rather than one batch 9
// drew: **a domain's table bootstrap belongs to that domain, and the adapter delegates to it.**
// `ensureFileStorage()` and `ensureUserPreferencesStorage()` already crossed a module boundary
// because batches 6 and 5 moved those tables; `ensureAuthStorage()` and `ensureLogStorage()` now do
// too. This file owns no domain's tables and emits every domain's SQL, which is what ADR-0021 means
// by an internal runtime boundary.
//
// ---------------------------------------------------------------------------------------------
// What is exported and what is not
//
// Twenty-one of the fifty-nine are exported and thirty-eight are private. Under the emitted list every
// one of the thirty-eight had to be an entry in `SERVER_RUNTIME_SOURCE_FUNCTIONS` or become a
// `ReferenceError` in a deployed Capsule, so "private" was not a thing this domain could be — the
// whole Postgres wire protocol, the libSQL pipeline, the SCRAM handshake and every line of app-table
// DDL were reachable by name from five hundred unrelated runtime functions.
//
// The exports are not a designed interface. They are the names something outside this file resolves:
// `createRuntimeDatabaseAdapter` for the Capsule boot, `createRuntimeInspectionAdapter` for the
// bundle's `db` action, the three engine constructors and `createPostgresConnection` for the CLI and
// the engine suites, the three inspection delegates for `sporades db`, and the seam factories, the
// two dialects and the three normalizations for `test/database-adapter-engine-seam.test.js`, which
// is the file that verifies ADR-0037 holds.
//
// `postgresInterpolate` and `splitSqlStatements` are exported for a sharper reason: both are SQL
// walkers, both are subjects of the walker census in that same test, and the census reads
// *declarations* rather than exports precisely so that privacy cannot become a way out of it.
// `postgresInterpolate` was resolved there through `SERVER_RUNTIME_SOURCE_FUNCTIONS.find(…)`, which
// answers `undefined` the moment a domain stops being entries in that list — and the value was
// called, so the case would have failed with "not a function". It is an import now.
//
// ---------------------------------------------------------------------------------------------
// How this file reaches Node builtins
//
// ADR-0042's order, and this module needs three of its four steps, which no other carried module has.
//
//   await import("node:sqlite" | "node:path")   `createSqliteDatabaseAdapter`, already asynchronous
//   await import("node:net" | "node:crypto")    `createPostgresConnection`, already asynchronous
//   process.getBuiltinModule("node:crypto")     `hashSchema`, which is synchronous and is called
//                                               from inside a migration chain with no await to spare
//   process.getBuiltinModule("node:fs")         `existsSync` and `mkdirSync`, likewise
//
// The two accessors are bound as *namespaces* and never destructured, for the `bin/` reason ADR-0042
// records: `bin/sporades.js` is the whole of `src/` in one esbuild scope, so a destructured
// `createHash` would collide with the monolith's own `import … from "node:crypto"` and esbuild would
// rename one side — putting a renamed name into every stringified runtime function while the
// bundle's preamble still imported the original. `nodeCryptoModule` is the same private name
// `auth-runtime`, `jobs-runtime` and `file-storage-runtime` use, which is safe for the reason
// ADR-0041 records: a private module-scope name never leaves its module, so its declaration and its
// uses are renamed together.
//
// Neither accessor produces an external for the carrier's metafile check to judge, so that check
// passes here unweakened rather than being widened a third time.
//
// ---------------------------------------------------------------------------------------------
// Nothing is redesigned
//
// Every body is byte-identical to the declaration it moved from, apart from the `nodeCryptoModule.`
// and `nodeFsModule.` prefixes at three call sites. No dialect entry was added or removed, so
// ADR-0037's closed set is the same closed set; no statement text changed, so ADR-0039's audit
// stands; and no adapter method's answer changed, which is what the conformance specification is
// there to say rather than what this comment can claim.
import { assertNotReservedAuthUserId, authIdentityRowUnlessReserved, authIdentityRowsUnlessReserved, createAnonymousAuthTables, isReservedAuthUserId } from "./auth-runtime.js";
import { createFileStorageTables } from "./file-storage-runtime.js";
import { sqlWithoutTrailingTerminator, validateReadOnlyInspectionSql } from "./inspection-sql.js";
import { isInternalLogIndexMetadataRow, targetsInternalLogIndexTable } from "./log-index-guard.js";
import { createLogIndexTables, insertLogIndexEvent, pruneLogIndex, readRecentLogEvents } from "./log-index-storage.js";
import { chainMaybePromise, isPromiseLike, thenIfPromise } from "./maybe-promise.js";
import { assertJsonCompatible, commandError, invalidReferenceError } from "./runtime-errors.js";
import { normalizeDateValue } from "./stored-value-coding.js";
import { createUserPreferencesTables } from "./user-preferences-runtime.js";
import { createTeamTables } from "./teams-runtime.js";
// Synchronous access to two Node builtins without an import — see the header, and ADR-0042. `process`
// is a global in both places this module runs: `dist/database-runtime.js` loaded as an ES module, and
// the esbuild IIFE the emitted-list bundle splices into a deployed Capsule. Bound as namespaces and
// never destructured, so no top-level name of this module can collide with the monolith's own
// `import … from "node:crypto"` inside `bin/sporades.js`.
const nodeCryptoModule = process.getBuiltinModule("node:crypto");
const nodeFsModule = process.getBuiltinModule("node:fs");
// A connection can queue SQL statements, but it cannot safely interleave the BEGIN/work/COMMIT
// sequences of two callers. Adapters backed by one connection use this gate for every transaction
// mode, preserving the transaction boundary that the runtime has already chosen (ADR-0026).
function createConnectionTransactionGate() {
    let transactionTail = Promise.resolve();
    let transactionActive = false;
    const pending = [];
    const drainPending = async () => {
        while (pending.length > 0) {
            const next = pending.shift();
            try {
                next.resolve(await next.operation());
            }
            catch (error) {
                next.reject(error);
            }
        }
    };
    const runOperation = (operation) => {
        if (!transactionActive)
            return operation();
        return new Promise((resolve, reject) => pending.push({ operation, resolve, reject }));
    };
    const runTransaction = async (operation) => {
        const previous = transactionTail;
        let release = () => { };
        transactionTail = new Promise((resolve) => { release = resolve; });
        await previous.catch(() => { });
        transactionActive = true;
        try {
            return await operation();
        }
        finally {
            transactionActive = false;
            await drainPending();
            release();
        }
    };
    return { runOperation, runTransaction };
}
async function rejectNestedTransactionScope() {
    throw commandError("Nested database transactions are not supported.", "Keep mutation work inside a single Sporades mutation transaction.");
}
function createTransactionScopedAdapter(adapter, operations = {}) {
    return Object.assign(Object.create(adapter), operations, {
        withTransaction: rejectNestedTransactionScope,
        withReadOnlySnapshot: rejectNestedTransactionScope,
    });
}
const transactionOperations = Symbol.for("sporades.database.transactionOperations");
export async function createRuntimeDatabaseAdapter(databasePath, serverEnv = {}, config = {}) {
    if (config.services?.database?.engine === "libsql" &&
        serverEnv.SPORADES_SERVICE_DATABASE_ENGINE === "libsql" &&
        serverEnv.SPORADES_SERVICE_DATABASE_URL) {
        return await createLibsqlDatabaseAdapter({
            url: serverEnv.SPORADES_SERVICE_DATABASE_URL,
            authToken: serverEnv.SPORADES_SERVICE_DATABASE_AUTH_TOKEN,
        });
    }
    if (config.services?.database?.engine === "postgres" &&
        serverEnv.SPORADES_SERVICE_DATABASE_ENGINE === "postgres" &&
        serverEnv.SPORADES_SERVICE_DATABASE_URL) {
        return await createPostgresDatabaseAdapter({
            url: serverEnv.SPORADES_SERVICE_DATABASE_URL,
        });
    }
    return await createSqliteDatabaseAdapter(databasePath);
}
export async function createRuntimeInspectionAdapter(databasePath, serverEnv = {}, config = {}) {
    if (config.services?.database?.engine === "libsql" && serverEnv.SPORADES_SERVICE_DATABASE_ENGINE === "libsql" && serverEnv.SPORADES_SERVICE_DATABASE_URL) {
        return await createLibsqlDatabaseAdapter({ url: serverEnv.SPORADES_SERVICE_DATABASE_URL, authToken: serverEnv.SPORADES_SERVICE_DATABASE_AUTH_TOKEN });
    }
    if (config.services?.database?.engine === "postgres" && serverEnv.SPORADES_SERVICE_DATABASE_ENGINE === "postgres" && serverEnv.SPORADES_SERVICE_DATABASE_URL) {
        return await createPostgresDatabaseAdapter({ url: serverEnv.SPORADES_SERVICE_DATABASE_URL });
    }
    if (!nodeFsModule.existsSync(String(databasePath)))
        return null;
    return await createSqliteDatabaseAdapter(databasePath, { readOnly: true });
}
// The Database adapter engine seam.
//
// A Database engine supplies three things and nothing else: statement primitives, a dialect, and
// row and value normalization. Every behavioural method body comes from
// `createSharedDatabaseAdapterMethods` below, which no engine's adapter owns and none of them has
// to borrow. ADR-0037 records the seam; ADR-0034 records the invariant the shared bodies keep.
//
// The dialect is the closed set of places where the engines genuinely cannot agree on the text of a
// statement. ADR-0034 licenses exactly that category of difference — an override may change the
// statement text a method emits, never the answer the method gives — so expressing those
// differences as dialect entries rather than as replacement method bodies turns the licence into
// something the structure enforces instead of something a reviewer has to check by reading.
//
// Every entry is required. A dialect that omits one fails here, at adapter construction, rather
// than at the first statement that needed it: a new engine cannot half-answer the seam and
// discover the gap in production.
export function createDatabaseDialect(spec) {
    const required = [
        "name",
        "quoteIdentifier",
        "columnType",
        "upsertSql",
        "listTables",
        "describeColumns",
        "addMissingColumn",
    ];
    // `== null` rather than `=== undefined`: an entry explicitly set to null would otherwise pass
    // construction and fail at the first statement that needed it, which is precisely the failure
    // this factory exists to move forward.
    const missing = required.filter((key) => spec[key] == null);
    if (missing.length > 0) {
        throw commandError(`Incomplete Database adapter dialect: ${missing.join(", ")}.`, "A Database engine supplies statement primitives, a dialect and row normalization. Answer every dialect entry.");
    }
    // `sql` is derived from `quoteIdentifier` rather than supplied, for the same reason normalization
    // derives `row` from `columnName` and `value`: an engine that answered the quoting entry and then
    // received statement text that had bypassed it would fold anyway. ADR-0039 records why every
    // identifier goes through it.
    return { ...spec, sql: (statement) => quoteSqlIdentifiers(spec.quoteIdentifier, statement) };
}
// The runtime writes every identifier in its own statement text as `[name]`, and this is where the
// marker becomes the engine's quoting. Postgres folds an unquoted identifier to lower case, so a
// half-quoted codebase asks a `"ownerId"` column for `ownerid` and errors outright; routing the
// whole of a statement's identifiers through the dialect is what stops the two halves disagreeing.
//
// The marker is deliberately not the answer. Writing `"ownerId"` in the statement text would be
// correct on all three engines this runtime speaks and would silently bypass the dialect entry that
// exists for the engine whose quoting differs, which is exactly the bypass this function removes.
//
// It is a substitution rather than a parse. The runtime's statement text is authored here, and no
// Capsule value or inspection query reaches it — parameters are bound, never interpolated — so the
// marker means an identifier wherever it appears and there is no literal for it to hide inside.
// `test/postgres-emitted-sql-quoting.test.js` is what keeps that true.
function quoteSqlIdentifiers(quoteIdentifier, statement) {
    return String(statement).replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, (_marker, identifier) => quoteIdentifier(identifier));
}
// The third thing an engine supplies: how a result row maps back to the names and values the
// runtime reads. Two entries, both required for the same reason the dialect's are — an engine that
// simply omitted one would answer rows the runtime silently misreads, which is how a missing
// `verifierHash` spelling rejected every valid password Reset code on Postgres.
//
// `columnName` restores the runtime's declared spelling of a result column. `value` coerces a
// single value into the JavaScript the runtime expects. `row` is derived from the two so that no
// engine can apply one and forget the other.
export function createDatabaseNormalization(spec) {
    const missing = ["name", "columnName", "value"].filter((key) => spec[key] == null);
    if (missing.length > 0) {
        throw commandError(`Incomplete Database adapter normalization: ${missing.join(", ")}.`, "A Database engine supplies statement primitives, a dialect and row normalization. Answer every normalization entry.");
    }
    return {
        ...spec,
        row: (raw) => Object.fromEntries(Object.entries(raw).map(([key, value]) => [spec.columnName(key), spec.value(value)])),
    };
}
// SQLite preserves the case it was given and `node:sqlite` already hands back JavaScript values, so
// both entries are the identity. Its statement primitives therefore return rows as the driver
// produced them rather than rebuilding each one to prove a no-op; the identity is declared here so
// it can be read, and paid for nowhere.
export function sqliteRowNormalization() {
    return createDatabaseNormalization({
        name: "sqlite",
        columnName: (name) => name,
        value: (value) => value,
    });
}
export function postgresRowNormalization() {
    return createDatabaseNormalization({
        name: "postgres",
        // The identity, like the other two engines. Postgres folds an unquoted identifier to lower
        // case, and a hand-maintained table of declared spellings used to fold it back — a registry
        // nothing failed for omitting, which is how a missing `verifierHash` entry rejected every valid
        // password Reset code here while presenting an ordinary "invalid code". Because that table was
        // applied per result key with no table provenance, it also renamed a Capsule field literally
        // called `errorcode` or `jobid`. ADR-0039 removed both by quoting every identifier the runtime
        // emits: nothing folds, so there is nothing to restore and no name to collide with.
        columnName: (name) => name,
        // Values are already coerced by the wire parser, which reads each column's type oid from the
        // row description. The row does not carry the oid, so the per-value entry cannot repeat that
        // work and does not need to.
        value: (value) => value,
    });
}
export function libsqlRowNormalization() {
    return createDatabaseNormalization({
        name: "libsql",
        // libSQL preserves declared case, so there is nothing to restore.
        columnName: (name) => name,
        // The pipeline protocol tags every value with its type, and this turns the tagged form back
        // into JavaScript.
        value: libsqlValueToJs,
    });
}
// SQLite's dialect, which libSQL shares because libSQL speaks SQLite's SQL.
export function sqliteDatabaseDialect() {
    return createDatabaseDialect({
        name: "sqlite",
        quoteIdentifier,
        // The declared field type is emitted verbatim. `sqliteType` is what the Capsule schema carries,
        // and an engine whose type names differ maps them here rather than in a copy of every DDL
        // method.
        columnType: (field) => field.sqliteType,
        // Write-or-replace a row identified by its key columns. Table and column names arrive
        // unquoted and are quoted here, so the upsert asks for the columns in the style every other
        // statement names them.
        upsertSql: (table, columns, _conflictColumns) => `INSERT OR REPLACE INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) ` +
            `VALUES (${columns.map(() => "?").join(", ")})`,
        // The catalog. Both entries answer rows carrying a `name`, whatever the engine's catalog calls
        // the column, so the shared inspection methods read one shape.
        listTables: (adapter) => adapter
            .prepare(`SELECT ${quoteIdentifier("name")} FROM ${quoteIdentifier("sqlite_schema")} ` +
            `WHERE ${quoteIdentifier("type")} = 'table' AND ${quoteIdentifier("name")} NOT LIKE 'sqlite_%' ` +
            `ORDER BY ${quoteIdentifier("name")}`)
            .all(),
        describeColumns: (adapter, tableName) => adapter.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all(),
        // Declare a column that an older database may not have. SQLite has no
        // `ADD COLUMN IF NOT EXISTS`, so the ALTER is issued and a duplicate-column error swallowed.
        // Probing `PRAGMA table_info` first would work here and nowhere else, which is exactly why the
        // strategy is a dialect entry rather than a line in a shared body.
        addMissingColumn: (adapter, table, column, type) => runSchemaExecIgnoringDuplicateColumn(adapter, `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${type}`),
    });
}
export function postgresDatabaseDialect() {
    return createDatabaseDialect({
        name: "postgres",
        quoteIdentifier,
        // TEXT, INTEGER and REAL all name real Postgres types, so the mapping is the identity here.
        // That is a fact about Postgres rather than a reason to drop the entry: the seam exists for the
        // engine whose type names do differ, and an identity mapping written down is checkable where an
        // absent one is not.
        columnType: (field) => field.sqliteType,
        // Postgres has no `INSERT OR REPLACE`; the same intent is `ON CONFLICT ... DO UPDATE`, which
        // updates the non-key columns from the row that was offered.
        upsertSql: (table, columns, conflictColumns) => {
            const updated = columns.filter((column) => !conflictColumns.includes(column));
            return (`INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) ` +
                `VALUES (${columns.map(() => "?").join(", ")}) ` +
                `ON CONFLICT (${conflictColumns.map(quoteIdentifier).join(", ")}) DO UPDATE SET ` +
                updated.map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`).join(", "));
        },
        // `sqlite_schema` and `PRAGMA table_info` are SQLite's alone; `information_schema` is the
        // standard catalog. Both answer rows carrying a `name`, which is the shape the shared
        // inspection methods read.
        listTables: (adapter) => adapter
            .prepare(`SELECT ${quoteIdentifier("table_name")} AS ${quoteIdentifier("name")} ` +
            `FROM ${quoteIdentifier("information_schema")}.${quoteIdentifier("tables")} ` +
            `WHERE ${quoteIdentifier("table_schema")} = current_schema() ` +
            `AND ${quoteIdentifier("table_type")} = 'BASE TABLE' ORDER BY ${quoteIdentifier("table_name")}`)
            .all(),
        describeColumns: (adapter, tableName) => adapter
            .prepare(`SELECT ${quoteIdentifier("column_name")} AS ${quoteIdentifier("name")} ` +
            `FROM ${quoteIdentifier("information_schema")}.${quoteIdentifier("columns")} ` +
            `WHERE ${quoteIdentifier("table_schema")} = current_schema() AND ${quoteIdentifier("table_name")} = ? ` +
            `ORDER BY ${quoteIdentifier("ordinal_position")}`)
            .all(tableName),
        // Postgres has `ADD COLUMN IF NOT EXISTS`, and using it is not merely tidier than swallowing a
        // duplicate-column error. A swallowed error on Postgres aborts the enclosing transaction, so
        // every statement after it fails with `current transaction is aborted`. Storage bootstrap runs
        // outside the migration transaction to keep that hazard out of reach; asking the engine not to
        // raise the error in the first place removes it.
        addMissingColumn: (adapter, table, column, type) => adapter.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN IF NOT EXISTS ${quoteIdentifier(column)} ${type}`),
    });
}
// The engine-agnostic Database adapter method set, defined once. Composed into every engine's
// adapter by spreading, so each method is an own enumerable property and the conformance coverage
// gate's enumeration sees the same names on every engine.
export function createSharedDatabaseAdapterMethods(dialect) {
    // Every identifier below is written as `[name]` and quoted through the dialect here. ADR-0039
    // records why: a statement that names a column in a style its table was not created with errors
    // outright on Postgres, and the runtime's own DDL goes through the same call so nothing folds.
    const sql = dialect.sql;
    return {
        ensureSystemTable() {
            return this.exec(sql("CREATE TABLE IF NOT EXISTS [sporades] ([key] TEXT PRIMARY KEY, [value] TEXT NOT NULL)"));
        },
        readSystemMetadata(key) {
            return this.prepare(sql("SELECT [value] FROM [sporades] WHERE [key] = ?")).get(key) ?? null;
        },
        writeSystemMetadata(key, value) {
            return this.prepare(dialect.upsertSql("sporades", ["key", "value"], ["key"])).run(key, value);
        },
        readSchemaMetadata() {
            return this.readSystemMetadata("schema");
        },
        writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }) {
            // ADR-0034's fourth rule limb: three writes fired and nothing returned leaves the caller no
            // way to know when they landed, and on an asynchronous engine no way to know they landed in
            // this order either. Chained and returned, one definition is correct under both synchronous
            // and asynchronous statement primitives, which is what let the Postgres and libSQL
            // await-shim copies of this method go.
            return chainMaybePromise([
                () => this.writeSystemMetadata("schemaVersion", schemaVersion),
                () => this.writeSystemMetadata("schemaHash", schemaHash),
                () => this.writeSystemMetadata("schema", schemaJson),
            ]);
        },
        ensureLogStorage() {
            return createLogIndexTables(this);
        },
        insertLogIndexEvent(event) {
            return insertLogIndexEvent(this, event);
        },
        pruneLogIndex(limit) {
            return pruneLogIndex(this, limit);
        },
        readRecentLogEvents(limit) {
            return readRecentLogEvents(this, limit);
        },
        ensureFileStorage() {
            return createFileStorageTables(this);
        },
        findFileBucket(ownerId, name) {
            return this.prepare(sql("SELECT * FROM [sporades_file_buckets] WHERE [ownerId] = ? AND [name] = ?")).get(ownerId, name) ?? null;
        },
        createFileBucket(row) {
            return this.prepare(sql("INSERT INTO [sporades_file_buckets] ([id], [ownerId], [name], [createdAt]) VALUES (?, ?, ?, ?)")).run(row.id, row.ownerId, row.name, row.createdAt);
        },
        insertFileRow(row) {
            return this.prepare(sql("INSERT INTO [sporades_files] " +
                "([id], [ownerId], [bucketId], [bucketName], [path], [name], [type], [size], [version], [status], [createdAt], [updatedAt], [deletedAt]) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")).run(row.id, row.ownerId, row.bucketId, row.bucketName, row.path, row.name, row.type, row.size, row.version, row.status, row.createdAt, row.updatedAt);
        },
        updatePendingFileRow(row) {
            return this.prepare(sql("UPDATE [sporades_files] SET [bucketId] = ?, [bucketName] = ?, [path] = ?, [name] = ?, [type] = ?, [size] = ?, " +
                "[version] = ?, [status] = ?, [updatedAt] = ?, [deletedAt] = NULL WHERE [id] = ?")).run(row.bucketId, row.bucketName, row.path, row.name, row.type, row.size, row.version, row.status, row.updatedAt, row.id);
        },
        insertFileUpload(row) {
            return this.prepare(sql("INSERT INTO [sporades_file_uploads] " +
                "([id], [fileId], [ownerId], [bucketId], [bucketName], [path], [name], [type], [version], [expectedSize], [createdAt]) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")).run(row.id, row.fileId, row.ownerId, row.bucketId, row.bucketName, row.path, row.name, row.type, row.version, row.expectedSize, row.createdAt);
        },
        selectFileById(fileId) {
            return this.prepare(sql("SELECT * FROM [sporades_files] WHERE [id] = ?")).get(fileId) ?? null;
        },
        selectLiveFileByPath(path) {
            return this.prepare(sql("SELECT * FROM [sporades_files] WHERE [path] = ? AND [deletedAt] IS NULL AND [status] = ?")).all(path, "uploaded");
        },
        selectActiveFileByPath(path) {
            return this.prepare(sql("SELECT * FROM [sporades_files] WHERE [path] = ? AND [deletedAt] IS NULL AND [status] IN (?, ?)")).all(path, "pending", "uploaded");
        },
        selectPendingFileUploadByPath(path) {
            return (this.prepare(sql("SELECT * FROM [sporades_file_uploads] WHERE [path] = ? ORDER BY [createdAt] DESC, [id] DESC LIMIT 1")).get(path) ?? null);
        },
        selectFileUpload(uploadId) {
            return this.prepare(sql("SELECT * FROM [sporades_file_uploads] WHERE [id] = ?")).get(uploadId) ?? null;
        },
        completeFileUpload(upload, size, updatedAt) {
            return thenIfPromise(this.prepare(sql("DELETE FROM [sporades_file_uploads] WHERE [id] = ? AND [fileId] = ? AND [version] = ?")).run(upload.id, upload.fileId, upload.version), (consumed) => {
                if (consumed.changes === 0) {
                    return consumed;
                }
                return thenIfPromise(this.selectFileById(upload.fileId), (existing) => {
                    if (existing) {
                        if (existing.deletedAt !== null && existing.deletedAt !== undefined) {
                            return { changes: 0 };
                        }
                        return this.prepare(sql("UPDATE [sporades_files] SET [bucketId] = ?, [bucketName] = ?, [path] = ?, [name] = ?, [type] = ?, [size] = ?, " +
                            "[version] = ?, [status] = ?, [updatedAt] = ? WHERE [id] = ? AND [deletedAt] IS NULL")).run(upload.bucketId, upload.bucketName, upload.path, upload.name, upload.type, size, upload.version, "uploaded", updatedAt, upload.fileId);
                    }
                    return this.insertFileRow({
                        id: upload.fileId,
                        ownerId: upload.ownerId,
                        bucketId: upload.bucketId,
                        bucketName: upload.bucketName,
                        path: upload.path,
                        name: upload.name,
                        type: upload.type,
                        size,
                        version: upload.version,
                        status: "uploaded",
                        createdAt: upload.createdAt,
                        updatedAt,
                    });
                });
            });
        },
        deleteFileUploadsForPath(path) {
            return this.prepare(sql("DELETE FROM [sporades_file_uploads] WHERE [path] = ?")).run(path);
        },
        deleteFileUploadsForFile(ownerId, fileId) {
            return this.prepare(sql("DELETE FROM [sporades_file_uploads] WHERE [ownerId] = ? AND [fileId] = ?")).run(ownerId, fileId);
        },
        deleteFileUpload(uploadId) {
            return this.prepare(sql("DELETE FROM [sporades_file_uploads] WHERE [id] = ?")).run(uploadId);
        },
        selectPublicFileRow(publicUrlId) {
            return (this.prepare(sql("SELECT [p].[id] AS [publicUrlId], [p].[fileId], [p].[version] AS [publicVersion], [p].[expiresAt], [p].[revokedAt], " +
                "[f].[id], [f].[ownerId], [f].[bucketId], [f].[bucketName], [f].[path], [f].[name], [f].[type], [f].[size], " +
                "[f].[version], [f].[status], [f].[createdAt], [f].[updatedAt], [f].[deletedAt] " +
                "FROM [sporades_file_public_urls] [p] JOIN [sporades_files] [f] ON [f].[id] = [p].[fileId] " +
                "WHERE [p].[id] = ?")).get(publicUrlId) ?? null);
        },
        insertPublicFileUrl(row) {
            return this.prepare(sql("INSERT INTO [sporades_file_public_urls] ([id], [fileId], [ownerId], [version], [expiresAt], [createdAt], [revokedAt]) " +
                "VALUES (?, ?, ?, ?, ?, ?, NULL)")).run(row.id, row.fileId, row.ownerId, row.version, row.expiresAt, row.createdAt);
        },
        revokePublicFileUrl(publicUrlId, ownerId, revokedAt) {
            return this.prepare(sql("UPDATE [sporades_file_public_urls] SET [revokedAt] = ? WHERE [id] = ? AND [ownerId] = ? AND [revokedAt] IS NULL")).run(revokedAt, publicUrlId, ownerId);
        },
        revokePublicFileUrlsForFile(fileId, revokedAt) {
            return this.prepare(sql("UPDATE [sporades_file_public_urls] SET [revokedAt] = ? WHERE [fileId] = ? AND [revokedAt] IS NULL")).run(revokedAt, fileId);
        },
        markFileDeleted(fileId, deletedAt) {
            return this.prepare(sql("UPDATE [sporades_files] SET [deletedAt] = ?, [updatedAt] = ? WHERE [id] = ?")).run(deletedAt, deletedAt, fileId);
        },
        fileRowForOwner(fileId, ownerId) {
            return (this.prepare(sql("SELECT * FROM [sporades_files] WHERE [id] = ? AND [ownerId] = ? AND [deletedAt] IS NULL AND [status] = ?")).get(fileId, ownerId, "uploaded") ?? null);
        },
        ensureAuthStorage(authConfig = null) {
            return createAnonymousAuthTables(this, authConfig);
        },
        ensureUserPreferencesStorage() {
            return createUserPreferencesTables(this);
        },
        ensureTeamsStorage() {
            return createTeamTables(this);
        },
        readUserPreferences(userId) {
            return this.prepare(sql("SELECT [userId], [value], [updatedAt] FROM [sporades_user_preferences] WHERE [userId] = ?")).get(userId) ?? null;
        },
        saveUserPreferences(row) {
            return this.prepare(dialect.upsertSql("sporades_user_preferences", ["userId", "value", "updatedAt"], ["userId"])).run(row.userId, row.value, row.updatedAt);
        },
        findAuthIdentityByProviderSubject(provider, subject) {
            const row = this.prepare(sql("SELECT [id], [userId], [provider], [subject], [email], [displayName], [picture], [createdAt], [updatedAt] " +
                "FROM [sporades_auth_identities] WHERE [provider] = ? AND [subject] = ?")).get(provider, subject) ?? null;
            return authIdentityRowUnlessReserved(row);
        },
        findLegacyAuthIdentitiesByProviderEmail(provider, email) {
            const rows = this.prepare(sql("SELECT [id], [userId], [provider], [subject], [email], [displayName], [picture], [createdAt], [updatedAt] " +
                "FROM [sporades_auth_identities] WHERE [provider] = ? AND [email] = ? AND [subject] LIKE 'legacy:%' " +
                "ORDER BY [createdAt], [id]")).all(provider, email);
            return authIdentityRowsUnlessReserved(rows);
        },
        insertAuthIdentity(row) {
            assertNotReservedAuthUserId(row.userId);
            return this.prepare(sql("INSERT INTO [sporades_auth_identities] " +
                "([id], [userId], [provider], [subject], [email], [displayName], [picture], [createdAt], [updatedAt]) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")).run(row.id, row.userId, row.provider, row.subject, row.email, row.displayName, row.picture, row.createdAt, row.updatedAt);
        },
        updateAuthIdentity(row) {
            return this.prepare(sql("UPDATE [sporades_auth_identities] SET [subject] = ?, [email] = ?, [displayName] = ?, [picture] = ?, " +
                "[updatedAt] = ? WHERE [id] = ?")).run(row.subject, row.email, row.displayName, row.picture, row.updatedAt, row.id);
        },
        insertAuthUser(row) {
            assertNotReservedAuthUserId(row.id);
            return this.prepare(sql("INSERT INTO [sporades_auth_users] " +
                "([id], [createdAt], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider]) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)")).run(row.id, row.createdAt, row.displayName, row.email, row.picture, row.isAuthenticated, row.isGuest, row.provider);
        },
        updateAuthUserProfile(row) {
            assertNotReservedAuthUserId(row.id);
            return this.prepare(sql("UPDATE [sporades_auth_users] SET [displayName] = ?, [picture] = ?, [isAuthenticated] = ?, [isGuest] = ? WHERE [id] = ?")).run(row.displayName, row.picture, row.isAuthenticated, row.isGuest, row.id);
        },
        linkAuthUser(row) {
            assertNotReservedAuthUserId(row.id);
            return this.prepare(sql("UPDATE [sporades_auth_users] SET [displayName] = ?, [email] = ?, [picture] = ?, [isAuthenticated] = ?, " +
                "[isGuest] = ? WHERE [id] = ?")).run(row.displayName, row.email, row.picture, row.isAuthenticated, row.isGuest, row.id);
        },
        insertAuthSession(row) {
            assertNotReservedAuthUserId(row.userId);
            return this.prepare(sql("INSERT INTO [sporades_auth_sessions] ([token], [userId], [provider], [createdAt], [expiresAt]) " +
                "VALUES (?, ?, ?, ?, ?)")).run(row.token, row.userId, row.provider, row.createdAt, row.expiresAt);
        },
        deleteAuthSession(token) {
            return this.prepare(sql("DELETE FROM [sporades_auth_sessions] WHERE [token] = ?")).run(token);
        },
        refreshAuthSession(token, expiresAt) {
            return this.prepare(sql("UPDATE [sporades_auth_sessions] SET [expiresAt] = ? WHERE [token] = ?")).run(expiresAt, token);
        },
        setAuthSessionProvider(token, provider) {
            return this.prepare(sql("UPDATE [sporades_auth_sessions] SET [provider] = ? WHERE [token] = ?")).run(provider, token);
        },
        rotateAuthSession(previousToken, row) {
            assertNotReservedAuthUserId(row.userId);
            return this.prepare(sql("UPDATE [sporades_auth_sessions] SET [token] = ?, [userId] = ?, [provider] = ?, [createdAt] = ?, " +
                "[expiresAt] = ? WHERE [token] = ?")).run(row.token, row.userId, row.provider, row.createdAt, row.expiresAt, previousToken);
        },
        readAuthSessionWithUser(token) {
            return thenIfPromise(this.prepare(sql("SELECT [s].[token], [s].[expiresAt], [u].[id] AS [userId], [u].[displayName], [u].[email], [u].[picture], " +
                "[u].[isAuthenticated], [u].[isGuest], [s].[provider] AS [provider] " +
                "FROM [sporades_auth_sessions] [s] " +
                "JOIN [sporades_auth_users] [u] ON [u].[id] = [s].[userId] " +
                "WHERE [s].[token] = ?")).get(token), (row) => (isReservedAuthUserId(row?.userId) ? null : row ?? null));
        },
        insertOAuthState(row) {
            const provider = row.provider ?? "google";
            const expiresAt = row.expiresAt ?? new Date(Date.parse(row.createdAt) + 10 * 60 * 1000).toISOString();
            return this.prepare(sql("INSERT INTO [sporades_auth_oauth_states] " +
                "([state], [provider], [sessionToken], [returnTo], [redirectUri], [createdAt], [expiresAt], [nonce], [pkceVerifier]) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")).run(row.state, provider, row.sessionToken, row.returnTo, row.redirectUri, row.createdAt, expiresAt, row.nonce ?? null, row.pkceVerifier ?? null);
        },
        // One statement, not a SELECT followed by a DELETE. The two-statement form was correct on
        // SQLite and a race everywhere else: nothing ordered the delete after the read, so on an
        // asynchronous engine the two were in flight together. Both service engines carried their own
        // `DELETE ... RETURNING` copy for exactly that reason, and node:sqlite speaks RETURNING too, so
        // there is one definition and no ordering left to get wrong.
        consumeOAuthState(state) {
            return thenIfPromise(this.prepare(sql("DELETE FROM [sporades_auth_oauth_states] WHERE [state] = ? " +
                "RETURNING [state], [provider], [sessionToken], [returnTo], [redirectUri], [createdAt], [expiresAt], " +
                "[nonce], [pkceVerifier]")).get(state), (row) => row ?? null);
        },
        emailCredentialExists(email) {
            return thenIfPromise(this.prepare(sql("SELECT [email] FROM [sporades_auth_email_credentials] WHERE [email] = ?")).get(email), (row) => Boolean(row));
        },
        insertEmailCredential(row) {
            assertNotReservedAuthUserId(row.userId);
            return this.prepare(sql("INSERT INTO [sporades_auth_email_credentials] ([email], [userId], [passwordHash], [passwordSalt], [createdAt]) " +
                "VALUES (?, ?, ?, ?, ?)")).run(row.email, row.userId, row.passwordHash, row.passwordSalt, row.createdAt);
        },
        updateEmailCredentialPassword(email, passwordHash, passwordSalt) {
            return this.prepare(sql("UPDATE [sporades_auth_email_credentials] SET [passwordHash] = ?, [passwordSalt] = ? WHERE [email] = ?")).run(passwordHash, passwordSalt, email);
        },
        findEmailCredentialWithUser(email) {
            return thenIfPromise(this.prepare(sql("SELECT [c].[email], [c].[userId], [c].[passwordHash], [c].[passwordSalt], [u].[displayName], [u].[picture], " +
                "[u].[isAuthenticated], [u].[isGuest] " +
                "FROM [sporades_auth_email_credentials] [c] " +
                "JOIN [sporades_auth_users] [u] ON [u].[id] = [c].[userId] " +
                "WHERE [c].[email] = ?")).get(email), (row) => (isReservedAuthUserId(row?.userId) ? null : row ?? null));
        },
        deleteAuthSessionsForUser(userId) {
            return this.prepare(sql("DELETE FROM [sporades_auth_sessions] WHERE [userId] = ?")).run(userId);
        },
        insertPasswordResetCode(row) {
            assertNotReservedAuthUserId(row.userId);
            return this.prepare(sql("INSERT INTO [sporades_auth_password_reset_codes] " +
                "([selector], [verifierHash], [email], [userId], [createdAt], [expiresAt]) VALUES (?, ?, ?, ?, ?, ?)")).run(row.selector, row.verifierHash, row.email, row.userId, row.createdAt, row.expiresAt);
        },
        findPasswordResetCode(selector) {
            return this.prepare(sql("SELECT [selector], [verifierHash], [email], [userId], [createdAt], [expiresAt] " +
                "FROM [sporades_auth_password_reset_codes] WHERE [selector] = ?")).get(selector) ?? null;
        },
        deletePasswordResetCode(selector) {
            return this.prepare(sql("DELETE FROM [sporades_auth_password_reset_codes] WHERE [selector] = ?")).run(selector);
        },
        countPasswordResetCodesForEmail(email, now) {
            return thenIfPromise(this.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_auth_password_reset_codes] " +
                "WHERE [email] = ? AND [expiresAt] > ?")).get(email, now), (row) => Number(row?.count ?? 0));
        },
        deletePasswordResetCodesForUser(userId) {
            return this.prepare(sql("DELETE FROM [sporades_auth_password_reset_codes] WHERE [userId] = ?")).run(userId);
        },
        prunePasswordResetCodes(now) {
            return this.prepare(sql("DELETE FROM [sporades_auth_password_reset_codes] WHERE [expiresAt] <= ?")).run(now);
        },
        // ADR-0026: a schema migration is a multi-write workflow that has to succeed or fail as one
        // unit, so it runs inside the adapter's own transaction primitive rather than emitting BEGIN
        // and COMMIT itself. Doing it with bare statements only worked on a synchronous engine: an
        // unawaited `exec("BEGIN")` leaves the enclosing `try`/`catch` unable to see an asynchronous
        // rejection, and the COMMIT fires before the migration it is meant to enclose has finished.
        migrateAppSchema(schema) {
            return this.withTransaction((transaction) => migrateAppSchemaInTransaction(transaction, schema));
        },
        createAppTable(table, tableName = table.name) {
            return createAppTable(this, table, tableName);
        },
        migrateExistingAppTable(existingTable, nextTable) {
            return this.withTransaction((transaction) => migrateExistingAppTableInTransaction(transaction, existingTable, nextTable));
        },
        referenceExists(field, value) {
            return thenIfPromise(this.prepare(`SELECT 1 FROM ${dialect.quoteIdentifier(field.targetTable)} WHERE ${dialect.quoteIdentifier("id")} = ? LIMIT 1`).get(String(value)), (row) => Boolean(row));
        },
        insertAppRow(table, row) {
            const columns = Object.keys(row);
            return this.prepare(`INSERT INTO ${dialect.quoteIdentifier(table.name)} (${columns
                .map((column) => dialect.quoteIdentifier(column))
                .join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((column) => row[column]));
        },
        insertAppRowOrIgnore(table, row, conflictFields) {
            const columns = Object.keys(row);
            return this.prepare(`INSERT INTO ${dialect.quoteIdentifier(table.name)} (${columns
                .map((column) => dialect.quoteIdentifier(column))
                .join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ` +
                `ON CONFLICT (${conflictFields.map((field) => dialect.quoteIdentifier(field)).join(", ")}) DO NOTHING`).run(...columns.map((column) => row[column]));
        },
        selectAppRowById(table, id) {
            return (this.prepare(`SELECT * FROM ${dialect.quoteIdentifier(table.name)} WHERE ${dialect.quoteIdentifier("id")} = ?`).get(String(id)) ?? null);
        },
        updateAppRow(table, id, values, options = {}) {
            const columns = Object.keys(values);
            if (columns.length === 0) {
                return { changes: 0 };
            }
            // The owner-scope predicate is quoted like every other identifier here. Emitted bare it
            // folded to `ownerid` on Postgres against a column `appFieldColumnDefinition` had created as
            // `"ownerId"`, so every owner-scoped update on an app table — the tables Capsule code reaches
            // through `ctx.db` — failed outright with `column "ownerid" does not exist`.
            return this.prepare(`UPDATE ${dialect.quoteIdentifier(table.name)} SET ${columns.map((column) => `${dialect.quoteIdentifier(column)} = ?`).join(", ")} ` +
                `WHERE ${dialect.quoteIdentifier("id")} = ?` +
                (options.ownerId === undefined ? "" : ` AND ${dialect.quoteIdentifier("ownerId")} = ?`)).run(...columns.map((column) => values[column]), String(id), ...(options.ownerId === undefined ? [] : [options.ownerId]));
        },
        deleteAppRow(table, id) {
            return this.prepare(`DELETE FROM ${dialect.quoteIdentifier(table.name)} WHERE ${dialect.quoteIdentifier("id")} = ?`).run(String(id));
        },
        selectAppRows(table, query = {}) {
            const columns = query.columns ?? ["*"];
            const whereClauses = [];
            const params = [];
            if (query.ownerId !== undefined) {
                whereClauses.push(`${dialect.quoteIdentifier("ownerId")} = ?`);
                params.push(query.ownerId);
            }
            if (query.where) {
                whereClauses.push(`${dialect.quoteIdentifier(query.where.fieldName)} = ?`);
                params.push(query.where.value);
            }
            const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(" AND ")}` : "";
            const orderSql = query.orderBy
                ? ` ORDER BY ${dialect.quoteIdentifier(query.orderBy.fieldName)} ${String(query.orderBy.direction).toLowerCase() === "desc" ? "DESC" : "ASC"}`
                : "";
            const limit = Number.isInteger(query.limit) && query.limit >= 0 ? query.limit : null;
            const limitSql = limit === null ? "" : " LIMIT ?";
            return this.prepare(`SELECT ${columns.map((column) => (column === "*" ? "*" : dialect.quoteIdentifier(column))).join(", ")} FROM ${dialect.quoteIdentifier(table.name)}${whereSql}${orderSql}${limitSql}`).all(...(limit === null ? params : [...params, limit]));
        },
        // The three inspection methods below each derive from a statement result, so each resolves it
        // first (ADR-0034). They previously read `.all()` and `.columns()` unresolved and were correct
        // on the asynchronous engines only because each engine shadowed them with an await-shim.
        listInspectableTables() {
            return thenIfPromise(dialect.listTables(this), (rows) => rows
                .map((row) => row.name)
                .filter((name) => name !== "sporades_log_events" && name !== "sporades_schedules" && name !== "sporades_schedule_occurrences"));
        },
        dumpInspectableDatabase() {
            const dumpTable = (tableName) => thenIfPromise(dialect.describeColumns(this, tableName), (columnRows) => thenIfPromise(this.prepare(`SELECT * FROM ${dialect.quoteIdentifier(tableName)}`).all(), (rows) => ({
                name: tableName,
                columns: columnRows.map((column) => column.name),
                rows,
            })));
            // Tables are dumped one after another rather than concurrently, so an asynchronous engine
            // issues the same statement sequence a synchronous one does.
            return thenIfPromise(this.listInspectableTables(), (tableNames) => tableNames.reduce((pending, tableName) => thenIfPromise(pending, (tables) => thenIfPromise(dumpTable(tableName), (table) => [...tables, table])), []));
        },
        runReadOnlyInspectionQuery(sql) {
            const inspectionQueryFailure = (error) => ({
                ok: false,
                data: null,
                error: {
                    message: error?.message,
                    hint: "Check the SQL syntax and table names, then retry the query.",
                },
            });
            try {
                const validation = validateReadOnlyInspectionSql(sql);
                if (!validation.ok) {
                    return validation;
                }
                if (targetsInternalLogIndexTable(sql)) {
                    return {
                        ok: false,
                        data: null,
                        error: {
                            message: "Internal log index tables are not available through generic DB inspection.",
                            hint: "Use `sporades logs --json` or `sporades logs tail --json` to inspect Capsule logs.",
                        },
                    };
                }
                // The engine is handed the one statement the gate accepted, not the text the human typed.
                // `sqlWithoutTrailingTerminator` stops at the first separator the walk sees, so what
                // reaches `all()` cannot be a multi-statement string unless the walk failed to see the
                // separator at all — and it is the same text `columns()` already embeds, so the two reads
                // stop being able to describe and answer different statements. Left raw, the validator was
                // the only thing between `sporades db query` and Postgres's simple query protocol; this
                // makes a walk defect cost a wrong verdict rather than an executed second statement.
                const statement = this.prepare(sqlWithoutTrailingTerminator(sql));
                const result = thenIfPromise(statement.columns(), (columnMetadata) => thenIfPromise(statement.all(), (allRows) => ({
                    ok: true,
                    data: {
                        columns: columnMetadata.map((column) => column.name),
                        rows: allRows.filter((row) => !isInternalLogIndexMetadataRow(row, sql)),
                    },
                    error: null,
                })));
                // A rejected statement is the asynchronous form of the throw the `catch` below handles, so
                // it has to reach the same failure result rather than escape as an unhandled rejection.
                return isPromiseLike(result) ? result.then((value) => value, inspectionQueryFailure) : result;
            }
            catch (error) {
                return inspectionQueryFailure(error);
            }
        },
        checkHealth() {
            // ADR-0034: the probe's answer is derived from the statement result, so the result has to be
            // resolved before the answer is given. A `try`/`catch` around an unresolved statement cannot
            // see a rejection, so the shared definition used to answer `{ ok: true }` for a connection
            // that had just failed — and escape the rejection as an unhandled one. Both engines carried
            // an await-shim over this; with the rejection handled here they no longer need one.
            try {
                const probe = this.prepare(sql("SELECT 1 AS [ok]")).get();
                return isPromiseLike(probe) ? probe.then(() => ({ ok: true }), () => ({ ok: false })) : { ok: true };
            }
            catch {
                return { ok: false };
            }
        },
    };
}
export async function createSqliteDatabaseAdapter(databasePath, options = {}) {
    const { DatabaseSync } = await import("node:sqlite");
    const path = await import("node:path");
    if (!options.readOnly)
        nodeFsModule.mkdirSync(path.dirname(String(databasePath)), { recursive: true });
    const connection = new DatabaseSync(databasePath, { readOnly: Boolean(options.readOnly) });
    const dialect = sqliteDatabaseDialect();
    const connectionGate = createConnectionTransactionGate();
    const runDirectly = (operation) => operation();
    const createOperations = (run) => ({
        exec(sql) {
            return run(() => connection.exec(sql));
        },
        prepare(sql) {
            return {
                all(...params) {
                    return run(() => connection.prepare(sql).all(...params));
                },
                get(...params) {
                    return run(() => connection.prepare(sql).get(...params));
                },
                run(...params) {
                    return run(() => connection.prepare(sql).run(...params));
                },
                columns() {
                    return run(() => connection.prepare(sql).columns());
                },
            };
        },
    });
    // SQLite is an engine like the others now, not the thing the others borrow from: what it supplies
    // below its own name is a connection, statement primitives and transaction session mechanics.
    const adapter = {
        ...createSharedDatabaseAdapterMethods(dialect),
        ...createOperations(connectionGate.runOperation),
        engine: "sqlite",
        dialect,
        normalization: sqliteRowNormalization(),
        async withTransaction(fn) {
            return await connectionGate.runTransaction(async () => {
                const ownerOperations = typeof this[transactionOperations] === "function"
                    ? this[transactionOperations]()
                    : { exec: this.exec.bind(this), prepare: this.prepare.bind(this) };
                const transactionAdapter = createTransactionScopedAdapter(this, ownerOperations);
                const transactionExec = ownerOperations.exec;
                await transactionExec("BEGIN");
                try {
                    const result = await fn(transactionAdapter);
                    await transactionExec("COMMIT");
                    return result;
                }
                catch (error) {
                    await transactionExec("ROLLBACK");
                    throw error;
                }
            });
        },
        async withReadOnlySnapshot(fn) {
            return await connectionGate.runTransaction(async () => {
                const ownerOperations = typeof this[transactionOperations] === "function"
                    ? this[transactionOperations]()
                    : { exec: this.exec.bind(this), prepare: this.prepare.bind(this) };
                const ownerAdapter = createTransactionScopedAdapter(this, ownerOperations);
                const transactionExec = ownerOperations.exec;
                await transactionExec("BEGIN");
                await transactionExec("PRAGMA query_only = ON");
                try {
                    const result = await fn(ownerAdapter);
                    await transactionExec("COMMIT");
                    return result;
                }
                catch (error) {
                    await transactionExec("ROLLBACK");
                    throw error;
                }
                finally {
                    if (!options.readOnly)
                        await transactionExec("PRAGMA query_only = OFF");
                }
            });
        },
        close() {
            return connection.close();
        },
    };
    Object.defineProperty(adapter, transactionOperations, {
        value: () => createOperations(runDirectly),
    });
    if (!options.readOnly) {
        adapter.exec("PRAGMA journal_mode = WAL");
    }
    return adapter;
}
export async function createPostgresDatabaseAdapter(options) {
    const url = typeof options === "string" ? options : options?.url;
    if (!url) {
        throw commandError("Missing Postgres database service URL.", "Start a Dev session or local Container session with services.database.engine set to postgres.");
    }
    const client = await createPostgresConnection(url);
    const connectionGate = createConnectionTransactionGate();
    const runDirectly = (operation) => operation();
    let closed = false;
    const dialect = postgresDatabaseDialect();
    const normalization = postgresRowNormalization();
    const assertOpen = () => {
        if (closed) {
            throw new Error("database is not open");
        }
    };
    const rawQuery = async (sql, params = []) => {
        assertOpen();
        return await client.query(postgresInterpolate(sql, params));
    };
    const createOperations = (run) => ({
        exec(sql) {
            return run(() => rawQuery(sql).then(() => undefined));
        },
        prepare(sql) {
            assertOpen();
            return {
                all(...params) {
                    return run(() => rawQuery(sql, params).then((result) => postgresRowsFromResult(normalization, result)));
                },
                get(...params) {
                    return this.all(...params).then((rows) => rows[0] ?? null);
                },
                run(...params) {
                    return run(() => rawQuery(sql, params).then((result) => ({
                        changes: Number(result.rowCount ?? 0),
                        lastInsertRowid: undefined,
                    })));
                },
                columns() {
                    return run(() => rawQuery(`SELECT * FROM (${sqlWithoutTrailingTerminator(sql)}) AS __sporades_columns LIMIT 0`).then((result) => result.fields.map((field) => ({ name: normalization.columnName(field.name) }))));
                },
            };
        },
    });
    const adapter = {
        ...createSharedDatabaseAdapterMethods(dialect),
        ...createOperations(connectionGate.runOperation),
        engine: "postgres",
        dialect,
        normalization,
        // Postgres has no way to ask a statement for its result shape without running something,
        // so the statement is wrapped and bounded to no rows. Wrapping is not syntax-transparent,
        // and that is a trap rather than a detail: a trailing `;` becomes a syntax error inside
        // the subquery, and a trailing line comment swallows the closing parenthesis and whatever
        // follows it. Both are legal input that `validateReadOnlyInspectionSql` deliberately
        // admits, and `sporades db query <sql>` is typed by a human, so a semicolon is ordinary.
        // Left unhandled, the same query answers on SQLite and libSQL and fails here — the
        // divergence this feature exists to close, reintroduced by the seam meant to prevent it.
        // Stripping the terminator and any trailing trivia first is what makes the wrap safe.
        //
        // This leaves the inspection path issuing two statements on Postgres where the method
        // override it replaced issued one, and that is a deliberate choice rather than an
        // oversight. Merging them would mean caching a result on the prepared-statement object so
        // that `columns()` and a later `all()` share it — which SQLite's and libSQL's statements do
        // not do, so a statement held across two reads would answer stale rows here and fresh rows
        // there. That is a new per-engine behavioural difference, bought in the feature whose
        // purpose is removing them. The bound makes the trade cheap: measured against a 200k-row
        // table, the `LIMIT 0` probe runs in 0.3ms against the read's 79.5ms, because Postgres
        // plans the statement and stops before materializing a row.
        // No behavioural method body lives here, deliberately (ADR-0037). Eleven used to: the upsert
        // form, the auth and File metadata storage bootstraps, the catalog queries behind the three
        // inspection methods, the app-table DDL, the OAuth state consume, and two await-shims. Each is
        // now either a dialect entry or a corrected shared definition, and ADR-0034 and ADR-0036 record
        // why each existed. `test/database-adapter-engine-seam.test.js` is what stops another appearing.
        //
        // The hazard that made removing them better than maintaining them, rather than merely tidier: a
        // shared body an engine shadows is dormant, not correct. It becomes live the moment the shadow
        // goes, or the moment a new engine composes the set without knowing to shadow it. `ensureLogStorage`
        // is the sharpest illustration — a copy of its bare `CREATE TABLE` here would be a Log index
        // that silently never ran ADR-0036's ordering migration.
        async withTransaction(fn) {
            return await connectionGate.runTransaction(async () => {
                await rawQuery("BEGIN");
                try {
                    const result = await fn(createTransactionScopedAdapter(adapter, createOperations(runDirectly)));
                    await rawQuery("COMMIT");
                    return result;
                }
                catch (error) {
                    try {
                        await rawQuery("ROLLBACK");
                    }
                    catch { }
                    throw error;
                }
            });
        },
        async withReadOnlySnapshot(fn) {
            return await connectionGate.runTransaction(async () => {
                const transactionAdapter = createTransactionScopedAdapter(adapter, createOperations(runDirectly));
                await rawQuery("BEGIN TRANSACTION READ ONLY");
                try {
                    const result = await fn(transactionAdapter);
                    await rawQuery("COMMIT");
                    return result;
                }
                catch (error) {
                    try {
                        await rawQuery("ROLLBACK");
                    }
                    catch { }
                    throw error;
                }
            });
        },
        async close() {
            closed = true;
            await client.close();
        },
    };
    return adapter;
}
export async function createPostgresConnection(url) {
    const net = await import("node:net");
    const crypto = await import("node:crypto");
    const options = postgresUrlOptions(url);
    const socket = net.createConnection({ host: options.host, port: options.port });
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let ready = false;
    let closed = false;
    let backendKeyData = null;
    let queryQueue = Promise.resolve();
    const waiters = [];
    socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        wakePostgresWaiters(waiters);
    });
    socket.on("error", (error) => {
        for (const waiter of waiters.splice(0)) {
            waiter.reject(error);
        }
    });
    socket.on("close", () => {
        closed = true;
        for (const waiter of waiters.splice(0)) {
            waiter.reject(new Error("database is not open"));
        }
    });
    await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
    });
    let scram = null;
    socket.write(postgresStartupMessage(options));
    while (!ready) {
        const message = await readPostgresMessage();
        if (message.type === "R") {
            const authType = message.body.readInt32BE(0);
            if (authType === 0) {
                continue;
            }
            if (authType === 3) {
                socket.write(postgresPasswordMessage(Buffer.from(`${options.password}\0`, "utf8")));
                continue;
            }
            if (authType === 10) {
                const mechanisms = message.body.subarray(4).toString("utf8").split("\0").filter(Boolean);
                if (!mechanisms.includes("SCRAM-SHA-256")) {
                    throw commandError("Unsupported Postgres SASL mechanism.", "Use the Sporades-managed Postgres Capsule service, which authenticates with SCRAM-SHA-256.");
                }
                scram = createPostgresScramSession(crypto, options.password);
                const clientFirst = Buffer.from(scram.clientFirstMessage, "utf8");
                socket.write(postgresPasswordMessage(Buffer.concat([Buffer.from("SCRAM-SHA-256\0", "utf8"), postgresInt32(clientFirst.length), clientFirst])));
                continue;
            }
            if (authType === 11 && scram) {
                const clientFinal = scram.continue(message.body.subarray(4).toString("utf8"));
                socket.write(postgresPasswordMessage(Buffer.from(clientFinal, "utf8")));
                continue;
            }
            if (authType === 12 && scram) {
                scram.verify(message.body.subarray(4).toString("utf8"));
                continue;
            }
            throw commandError("Unsupported Postgres authentication method.", "Use the Sporades-managed Postgres Capsule service with the generated Capsule service credentials.");
        }
        if (message.type === "K") {
            backendKeyData = message.body;
            continue;
        }
        if (message.type === "E") {
            throw postgresErrorFromBody(message.body);
        }
        if (message.type === "Z") {
            ready = true;
        }
    }
    return {
        get backendKeyData() {
            return backendKeyData;
        },
        query(sql) {
            if (closed) {
                throw new Error("database is not open");
            }
            const pending = queryQueue.then(() => executePostgresQuery(sql), () => executePostgresQuery(sql));
            queryQueue = pending.catch(() => { });
            return pending;
        },
        async close() {
            await queryQueue.catch(() => { });
            if (closed) {
                return;
            }
            closed = true;
            socket.write(Buffer.from([0x58, 0, 0, 0, 4]));
            socket.end();
        },
    };
    async function executePostgresQuery(sql) {
        if (closed) {
            throw new Error("database is not open");
        }
        socket.write(postgresQueryMessage(sql));
        const fields = [];
        const rows = [];
        let rowCount = 0;
        let queryError = null;
        while (true) {
            const message = await readPostgresMessage();
            if (message.type === "T") {
                fields.splice(0, fields.length, ...postgresParseRowDescription(message.body));
                continue;
            }
            if (message.type === "D") {
                rows.push(postgresParseDataRow(message.body, fields));
                continue;
            }
            if (message.type === "C") {
                rowCount = postgresRowCountFromCommand(message.body.toString("utf8").replace(/\0$/, ""));
                continue;
            }
            if (message.type === "E") {
                // Keep reading to the ReadyForQuery message so the next queued query
                // does not consume this query's remaining response messages.
                queryError = postgresErrorFromBody(message.body);
                continue;
            }
            if (message.type === "Z") {
                if (queryError) {
                    throw queryError;
                }
                return { fields, rows, rowCount };
            }
        }
    }
    async function readPostgresMessage() {
        while (buffer.length < 5) {
            await waitForPostgresData(waiters);
        }
        const type = String.fromCharCode(buffer[0]);
        const length = buffer.readInt32BE(1);
        while (buffer.length < 1 + length) {
            await waitForPostgresData(waiters);
        }
        const body = buffer.subarray(5, 1 + length);
        buffer = buffer.subarray(1 + length);
        return { type, body };
    }
}
function postgresUrlOptions(url) {
    const parsed = new URL(String(url));
    return {
        host: parsed.hostname || "127.0.0.1",
        port: parsed.port ? Number(parsed.port) : 5432,
        user: decodeURIComponent(parsed.username || "sporades"),
        password: decodeURIComponent(parsed.password || ""),
        database: decodeURIComponent(parsed.pathname.replace(/^\/+/, "") || "sporades"),
    };
}
function postgresPasswordMessage(body) {
    const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return Buffer.concat([Buffer.from("p"), postgresInt32(bodyBuffer.length + 4), bodyBuffer]);
}
function createPostgresScramSession(crypto, password) {
    const clientNonce = crypto.randomBytes(18).toString("base64");
    const clientFirstBare = `n=,r=${clientNonce}`;
    let serverSignature = null;
    return {
        clientFirstMessage: `n,,${clientFirstBare}`,
        continue(serverFirstMessage) {
            const attributes = new Map(serverFirstMessage.split(",").map((part) => [part.slice(0, 1), part.slice(2)]));
            const serverNonce = attributes.get("r") ?? "";
            const salt = Buffer.from(attributes.get("s") ?? "", "base64");
            const iterations = Number(attributes.get("i") ?? "0");
            if (!serverNonce.startsWith(clientNonce) || salt.length === 0 || !Number.isInteger(iterations) || iterations <= 0) {
                throw new Error("Invalid Postgres SCRAM server-first message.");
            }
            const saltedPassword = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
            const clientKey = crypto.createHmac("sha256", saltedPassword).update("Client Key").digest();
            const storedKey = crypto.createHash("sha256").update(clientKey).digest();
            const clientFinalWithoutProof = `c=biws,r=${serverNonce}`;
            const authMessage = `${clientFirstBare},${serverFirstMessage},${clientFinalWithoutProof}`;
            const clientSignature = crypto.createHmac("sha256", storedKey).update(authMessage).digest();
            const clientProof = Buffer.from(clientKey.map((byte, index) => byte ^ clientSignature[index]));
            const serverKey = crypto.createHmac("sha256", saltedPassword).update("Server Key").digest();
            serverSignature = crypto.createHmac("sha256", serverKey).update(authMessage).digest("base64");
            return `${clientFinalWithoutProof},p=${clientProof.toString("base64")}`;
        },
        verify(serverFinalMessage) {
            if (serverFinalMessage !== `v=${serverSignature}`) {
                throw new Error("Postgres SCRAM server signature verification failed.");
            }
        },
    };
}
function postgresStartupMessage(options) {
    const params = [
        ["user", options.user],
        ["database", options.database],
        ["client_encoding", "UTF8"],
    ];
    const bodyParts = [postgresInt32(196608)];
    for (const [key, value] of params) {
        bodyParts.push(Buffer.from(`${key}\0${value}\0`, "utf8"));
    }
    bodyParts.push(Buffer.from([0]));
    const body = Buffer.concat(bodyParts);
    return Buffer.concat([postgresInt32(body.length + 4), body]);
}
function postgresQueryMessage(sql) {
    const body = Buffer.from(`${sql}\0`, "utf8");
    return Buffer.concat([Buffer.from("Q"), postgresInt32(body.length + 4), body]);
}
function postgresInt32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value, 0);
    return buffer;
}
function waitForPostgresData(waiters) {
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
}
function wakePostgresWaiters(waiters) {
    for (const waiter of waiters.splice(0)) {
        waiter.resolve();
    }
}
function postgresParseRowDescription(body) {
    const fields = [];
    let offset = 0;
    const count = body.readInt16BE(offset);
    offset += 2;
    for (let index = 0; index < count; index += 1) {
        const nameEnd = body.indexOf(0, offset);
        const name = body.subarray(offset, nameEnd).toString("utf8");
        offset = nameEnd + 1;
        offset += 6;
        const dataTypeID = body.readInt32BE(offset);
        offset += 4;
        offset += 8;
        fields.push({ name, dataTypeID });
    }
    return fields;
}
function postgresParseDataRow(body, fields) {
    const row = {};
    let offset = 0;
    const count = body.readInt16BE(offset);
    offset += 2;
    for (let index = 0; index < count; index += 1) {
        const field = fields[index];
        if (!field) {
            throw new Error("Postgres protocol error: data row did not match row description.");
        }
        const length = body.readInt32BE(offset);
        offset += 4;
        if (length === -1) {
            row[field.name] = null;
            continue;
        }
        const raw = body.subarray(offset, offset + length).toString("utf8");
        offset += length;
        row[field.name] = postgresValueFromText(raw, field.dataTypeID);
    }
    return row;
}
function postgresValueFromText(value, dataTypeID) {
    if ([20, 21, 23].includes(dataTypeID)) {
        return Number(value);
    }
    if ([700, 701, 1700].includes(dataTypeID)) {
        return Number(value);
    }
    if (dataTypeID === 16) {
        return value === "t";
    }
    return value;
}
function postgresRowCountFromCommand(tag) {
    const match = tag.match(/\s(\d+)$/);
    return match ? Number(match[1]) : 0;
}
function postgresErrorFromBody(body) {
    const fields = {};
    let offset = 0;
    while (offset < body.length && body[offset] !== 0) {
        const type = String.fromCharCode(body[offset]);
        offset += 1;
        const end = body.indexOf(0, offset);
        fields[type] = body.subarray(offset, end).toString("utf8");
        offset = end + 1;
    }
    const error = new Error(fields.M ?? "Postgres query failed.");
    // SQLSTATE and constraint name are operational metadata: callers use them
    // only to retry a known idempotent race, never as a browser-facing error.
    if (fields.C)
        error.code = fields.C;
    if (fields.n)
        error.constraint = fields.n;
    return error;
}
// `?` placeholders replaced with literals, skipping the ones inside strings and comments.
//
// **This is a second SQL lexer, it is on the read-only inspection path, and it is deliberately not
// collapsed into `skipSqlQuotedOrCommented`.** Recording that here rather than leaving it to be
// rediscovered, because the collapse in the inspection region reads as a completeness claim and
// this is the exception to it:
//
//     runReadOnlyInspectionQuery -> prepare(sqlWithoutTrailingTerminator(sql))
//       all()     -> query(sql, params)      -> client.query(postgresInterpolate(sql, params))
//       columns() -> query(`SELECT * FROM (…) AS … LIMIT 0`) -> the same
//
// So every Postgres inspection query passes through it twice, and it disagrees with the one
// tokenizer on four points: it ends a line comment at LF only where that one ends it at CR too, and
// it knows neither dollar quoting, nor E-strings, nor `[…]`.
//
// It is **not** inert there, and the first draft of this comment claimed it was. `params` is empty
// on the whole inspection path — `prepare(sql).all()` is called with no arguments — so there is
// nothing to substitute, and on almost every admitted statement this copies its input character for
// character. But a `?` sitting inside a form this lexer does not know is not protected by it, and
// `SELECT $$?$$ AS s` is admitted by the gate, is legal Postgres, and dies here with
// `Missing Postgres query parameter.` A corpus without `?` in its alphabet reports this clean, and
// one did.
//
// What that costs is a **false rejection on Postgres only**, and only that. The failure is a throw
// before the wire, so it fails closed: with no parameters this function can return its input
// unchanged or it can throw, and there is no third case in which it silently returns *different*
// text. That is the property the gate actually depends on — the text checked is the text executed —
// and it is asserted rather than argued in
// `test/database-adapter-engine-seam.test.js`. It is also byte-identical to the pre-work base, so
// none of this is new.
//
// Collapsing it would fix that false rejection and would reach well past this ticket to do it. Its
// quoting regime treats `\` as an escape inside every string, which the union dialect does not, so
// routing it through changes what `'a\'b'` means on the *write* path — every ordinary query the
// runtime issues to Postgres, not just inspection. That is a larger behavioural surface than the
// read-only gate and wants its own ticket with its own differential rather than a free ride on
// this one.
export function postgresInterpolate(sql, params = []) {
    let index = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    let result = "";
    const text = String(sql ?? "");
    for (let position = 0; position < text.length; position += 1) {
        const char = text[position];
        const next = text[position + 1];
        if (lineComment) {
            result += char;
            if (char === "\n") {
                lineComment = false;
            }
            continue;
        }
        if (blockComment) {
            result += char;
            if (char === "*" && next === "/") {
                result += next;
                position += 1;
                blockComment = false;
            }
            continue;
        }
        if (quote) {
            result += char;
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === "\\") {
                escaped = true;
                continue;
            }
            if (char === quote) {
                quote = null;
            }
            continue;
        }
        if (char === "-" && next === "-") {
            result += char + next;
            position += 1;
            lineComment = true;
            continue;
        }
        if (char === "/" && next === "*") {
            result += char + next;
            position += 1;
            blockComment = true;
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            quote = char;
            result += char;
            continue;
        }
        if (char === "?") {
            if (index >= params.length) {
                throw new Error("Missing Postgres query parameter.");
            }
            result += toSqlLiteral(params[index]);
            index += 1;
            continue;
        }
        result += char;
    }
    if (index < params.length) {
        throw new Error("Too many Postgres query parameters.");
    }
    return result;
}
function postgresRowsFromResult(normalization, result) {
    return result.rows.map((row) => normalization.row(row));
}
export async function createLibsqlDatabaseAdapter(options) {
    const url = typeof options === "string" ? options : options?.url;
    if (!url) {
        throw commandError("Missing libSQL database service URL.", "Start a Dev session or local Container session with services.database.engine set to libsql.");
    }
    const endpoint = libsqlPipelineUrl(url);
    const authToken = typeof options === "object" ? options.authToken : null;
    let closed = false;
    const activeTransactions = new Set();
    // libSQL speaks SQLite's SQL, so it takes SQLite's dialect. That is a statement about the two
    // engines rather than a borrowing: the dialect is a value both adapters ask for, not an adapter
    // one of them builds and strips for parts.
    const dialect = sqliteDatabaseDialect();
    // Normalization is libSQL's own, though: the pipeline protocol tags every value with its type,
    // where node:sqlite hands back JavaScript directly.
    const normalization = libsqlRowNormalization();
    const createOperations = (transaction = null) => ({
        exec(sql) {
            assertLibsqlOpen(closed);
            const request = libsqlHasMultipleStatements(sql)
                ? { type: "sequence", sql }
                : { type: "execute", stmt: { sql } };
            return libsqlPipeline({ endpoint, authToken, transaction, requests: [request], close: !transaction }).then(() => undefined);
        },
        prepare(sql) {
            assertLibsqlOpen(closed);
            return {
                all(...params) {
                    return libsqlExecute({ endpoint, authToken, transaction, sql, params, close: !transaction }).then((result) => libsqlRowsFromResult(normalization, result));
                },
                get(...params) {
                    return this.all(...params).then((rows) => rows[0] ?? null);
                },
                run(...params) {
                    return libsqlExecute({ endpoint, authToken, transaction, sql, params, close: !transaction }).then((result) => ({
                        changes: Number(result.affected_row_count ?? result.affectedRowCount ?? 0),
                        lastInsertRowid: result.last_insert_rowid === null || result.last_insert_rowid === undefined
                            ? undefined
                            : BigInt(result.last_insert_rowid),
                    }));
                },
                columns() {
                    return libsqlDescribe({ endpoint, authToken, transaction, sql, close: !transaction });
                },
            };
        },
    });
    const adapter = {
        ...createSharedDatabaseAdapterMethods(dialect),
        ...createOperations(),
        engine: "libsql",
        dialect,
        normalization,
        // No behavioural method body lives here either, for the reasons ADR-0037 records and the
        // Postgres adapter states above. Six used to: the two storage bootstraps, the OAuth state
        // consume, and three await-shims over Log index methods that ADR-0036 corrected in the shared
        // body instead.
        async withTransaction(fn) {
            const transaction = { baton: null, baseUrl: endpoint };
            const transactionAdapter = createTransactionScopedAdapter({
                ...adapter,
                ...createOperations(transaction),
            });
            activeTransactions.add(transaction);
            try {
                await libsqlExecute({ endpoint, authToken, transaction, sql: "BEGIN", params: [], close: false });
                const result = await fn(transactionAdapter);
                await libsqlExecute({ endpoint, authToken, transaction, sql: "COMMIT", params: [], close: true });
                return result;
            }
            catch (error) {
                try {
                    await libsqlExecute({ endpoint, authToken, transaction, sql: "ROLLBACK", params: [], close: true });
                }
                catch { }
                throw error;
            }
            finally {
                activeTransactions.delete(transaction);
            }
        },
        async withReadOnlySnapshot(fn) {
            const transaction = { baton: null, baseUrl: endpoint };
            const snapshotAdapter = createTransactionScopedAdapter({ ...adapter, ...createOperations(transaction) });
            activeTransactions.add(transaction);
            try {
                await libsqlExecute({ endpoint, authToken, transaction, sql: "BEGIN", params: [], close: false });
                await libsqlExecute({ endpoint, authToken, transaction, sql: "PRAGMA query_only = ON", params: [], close: false });
                const result = await fn(snapshotAdapter);
                await libsqlExecute({ endpoint, authToken, transaction, sql: "COMMIT", params: [], close: true });
                return result;
            }
            catch (error) {
                try {
                    await libsqlExecute({ endpoint, authToken, transaction, sql: "ROLLBACK", params: [], close: true });
                }
                catch { }
                throw error;
            }
            finally {
                activeTransactions.delete(transaction);
            }
        },
        async close() {
            closed = true;
            for (const transaction of activeTransactions) {
                if (transaction.baton) {
                    await libsqlPipeline({ endpoint, authToken, transaction, requests: [], close: true }).catch(() => { });
                }
            }
            activeTransactions.clear();
        },
    };
    return adapter;
}
function libsqlPipelineUrl(url) {
    const parsed = new URL(String(url));
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/v2/pipeline`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
}
function assertLibsqlOpen(closed) {
    if (closed) {
        throw new Error("database is not open");
    }
}
function libsqlHasMultipleStatements(sql) {
    return splitSqlStatements(sql).length > 1;
}
async function libsqlExecute({ endpoint, authToken, transaction, sql, params = [], close }) {
    const [result] = await libsqlPipeline({
        endpoint,
        authToken,
        transaction,
        requests: [{ type: "execute", stmt: { sql, args: params.map(libsqlValueFromJs) } }],
        close,
    });
    return result.result;
}
async function libsqlDescribe({ endpoint, authToken, transaction, sql, close }) {
    const [result] = await libsqlPipeline({
        endpoint,
        authToken,
        transaction,
        requests: [{ type: "describe", sql }],
        close,
    });
    return (result.result?.cols ?? []).map((column) => ({ name: column.name }));
}
async function libsqlPipeline({ endpoint, authToken, transaction = null, requests, close = true }) {
    const requestUrl = transaction?.baseUrl ?? endpoint;
    const payload = {
        ...(transaction ? { baton: transaction.baton } : {}),
        requests: close ? [...requests, { type: "close" }] : requests,
    };
    const response = await fetch(requestUrl, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify(payload),
    });
    // Annotated rather than inferred. `tsconfig.json` compiles with the DOM lib, where `json()` is
    // `Promise<any>` and every read below checks out; `tsconfig.runtime.json` compiles without it, and
    // @types/node's `json()` is `Promise<unknown>`. The annotation is the type this binding already
    // had under the main config, so it states what was inferred rather than widening anything.
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(body?.error?.message ?? `libSQL request failed with HTTP ${response.status}.`);
    }
    if (transaction) {
        transaction.baton = body.baton ?? null;
        transaction.baseUrl = body.base_url ? new URL("/v2/pipeline", body.base_url).toString() : requestUrl;
    }
    const results = body.results ?? [];
    const errorResult = results.find((result) => result.type === "error");
    if (errorResult) {
        throw new Error(errorResult.error?.message ?? "libSQL statement failed.");
    }
    return results.filter((result) => result.response?.type !== "close").map((result) => result.response);
}
function libsqlRowsFromResult(normalization, result) {
    const columns = (result.cols ?? []).map((column) => column.name);
    return (result.rows ?? []).map((row) => normalization.row(Array.isArray(row) ? Object.fromEntries(columns.map((column, index) => [column, row[index]])) : row));
}
function libsqlValueFromJs(value) {
    if (value === null || value === undefined) {
        return { type: "null" };
    }
    if (typeof value === "boolean") {
        return { type: "integer", value: value ? "1" : "0" };
    }
    if (typeof value === "bigint") {
        return { type: "integer", value: String(value) };
    }
    if (typeof value === "number" && Number.isInteger(value)) {
        return { type: "integer", value: String(value) };
    }
    if (typeof value === "number") {
        return { type: "float", value };
    }
    if (value instanceof Uint8Array) {
        return { type: "blob", base64: Buffer.from(value).toString("base64") };
    }
    return { type: "text", value: String(value) };
}
function libsqlValueToJs(value) {
    if (value === null || value === undefined || value.type === "null") {
        return null;
    }
    if (value.type === "integer") {
        const number = Number(value.value);
        return Number.isSafeInteger(number) ? number : String(value.value);
    }
    if (value.type === "float") {
        return Number(value.value);
    }
    if (value.type === "blob") {
        return Buffer.from(value.base64 ?? "", "base64");
    }
    if (Object.hasOwn(value, "value")) {
        return value.value;
    }
    return value;
}
// The one definition of what a Capsule schema migration does, run inside a transaction the caller
// has already opened. Its caller is the `migrateAppSchema` adapter method, which is what supplies
// that transaction; it takes the transaction-scoped adapter rather than the adapter itself so that
// every statement it and the table rebuilds below emit belongs to the same unit of work.
function migrateAppSchemaInTransaction(sqlite, schema) {
    const nextSchema = normalizeSchema(schema);
    const nextSchemaJson = JSON.stringify(nextSchema);
    const nextSchemaHash = hashSchema(nextSchemaJson);
    // ADR-0034: the recorded schema is read before anything is derived from it. On an asynchronous
    // engine `readSchemaMetadata()` answers a Promise, which is truthy even when there is no recorded
    // schema at all, so every branch below — whether a schema exists, whether it parses, whether it
    // changed, and whether the change is additive — has to be taken against the resolved row.
    return thenIfPromise(sqlite.readSchemaMetadata(), (existingSchemaRow) => {
        let existingSchema = null;
        let schemaChanged = false;
        if (existingSchemaRow) {
            try {
                existingSchema = JSON.parse(existingSchemaRow.value);
            }
            catch {
                throw commandError("Invalid Sporades schema metadata.", "Delete the Runtime directory only if you can lose local data, then restart the Capsule.");
            }
            schemaChanged = hashSchema(JSON.stringify(existingSchema)) !== nextSchemaHash;
            if (schemaChanged) {
                assertAdditiveSchemaMigration(existingSchema, nextSchema);
            }
        }
        const existingTables = new Map((existingSchema?.tables ?? []).map((table) => [table.name, table]));
        return chainMaybePromise([
            ...schema.tables.map((table) => () => {
                const existingTable = existingTables.get(table.name);
                // The in-transaction table rebuild rather than the adapter method, which opens a
                // transaction of its own and would nest inside the one already enclosing this migration —
                // and libSQL's transaction adapter throws on a nested `withTransaction`.
                //
                // Issue 09's review asked what happens when an engine overrides `migrateExistingAppTable`:
                // this call would bypass it, from inside a migration, silently. ADR-0037 answers it — an
                // engine supplies statement primitives, a dialect and normalization, and has nowhere to put
                // a behavioural method body. What this call skips is the transaction wrapper and nothing
                // else, and `test/database-adapter-engine-seam.test.js` fails if that stops being true.
                return schemaChanged && existingTable
                    ? migrateExistingAppTableInTransaction(sqlite, existingTable, table)
                    : sqlite.createAppTable(table);
            }),
            () => sqlite.writeSchemaMetadata({
                schemaVersion: "v1:additive-fields",
                schemaHash: nextSchemaHash,
                schemaJson: nextSchemaJson,
            }),
        ]);
    });
}
function normalizeSchema(schema) {
    return {
        tables: schema.tables
            .map((table) => ({
            name: table.name,
            fields: table.fields.map((field) => ({
                name: field.name,
                kind: field.kind,
                sqliteType: field.sqliteType,
                targetTable: field.targetTable,
                defaultValue: field.defaultValue,
            })),
            uniqueConstraints: table.uniqueConstraints ?? [],
        }))
            .sort((left, right) => left.name.localeCompare(right.name)),
    };
}
function hashSchema(schemaJson) {
    return nodeCryptoModule.createHash("sha256").update(schemaJson).digest("hex");
}
function assertAdditiveSchemaMigration(existingSchema, nextSchema) {
    const nextTables = new Map(nextSchema.tables.map((table) => [table.name, table]));
    for (const existingTable of existingSchema.tables ?? []) {
        const nextTable = nextTables.get(existingTable.name);
        if (!nextTable) {
            throw commandError("Unsupported Capsule schema change.", "Only adding new tables or fields is supported right now. Revert table or field changes, or move data aside and recreate the Runtime directory.");
        }
        const nextFields = new Map(nextTable.fields.map((field) => [field.name, field]));
        for (const existingField of existingTable.fields ?? []) {
            const nextField = nextFields.get(existingField.name);
            if (!nextField || JSON.stringify(existingField) !== JSON.stringify(nextField)) {
                throw commandError("Unsupported Capsule schema change.", "Only adding new tables or fields is supported right now. Revert table or field changes, or move data aside and recreate the Runtime directory.");
            }
        }
        if (JSON.stringify(existingTable.uniqueConstraints ?? []) !== JSON.stringify(nextTable.uniqueConstraints ?? [])) {
            throw commandError("Unsupported Capsule schema change.", "Only adding new tables or fields is supported right now. Revert table or field changes, or move data aside and recreate the Runtime directory.");
        }
    }
}
// The one definition of an additive table rebuild, run inside a transaction the caller has already
// opened. SQLite cannot add a column to a table that carries a default without rewriting it, so the
// rebuild copies every row of the table into a temporary copy and renames it into place — which is
// precisely the work that must not be left half done, and precisely why its caller wraps it.
function migrateExistingAppTableInTransaction(sqlite, existingTable, nextTable) {
    // The dialect is reached through the adapter rather than passed alongside it, so a helper the
    // shared method set delegates to cannot end up emitting a different engine's SQL than the method
    // that called it.
    const dialect = sqlite.dialect;
    const tempTableName = `__sporades_migrating_${nextTable.name}`;
    const columns = ["id", "createdAt", "updatedAt", ...nextTable.fields.map((field) => field.name)];
    return chainMaybePromise([
        ...addedFieldsForTable(existingTable, nextTable)
            .filter((field) => field.kind === "Reference" && field.defaultValue !== undefined && field.defaultValue !== null)
            .map((field) => () => thenIfPromise(sqlite.referenceExists(field, field.defaultValue), (exists) => {
            if (!exists) {
                throw invalidReferenceError(field);
            }
        })),
        () => sqlite.exec(`DROP TABLE IF EXISTS ${dialect.quoteIdentifier(tempTableName)}`),
        () => sqlite.createAppTable(nextTable, tempTableName),
        () => sqlite.exec(`INSERT INTO ${dialect.quoteIdentifier(tempTableName)} (${columns.map((column) => dialect.quoteIdentifier(column)).join(", ")}) ` +
            `SELECT ${columns.map((column) => columnSelectExpressionForMigration(dialect, existingTable, nextTable, column)).join(", ")} ` +
            `FROM ${dialect.quoteIdentifier(nextTable.name)}`),
        () => sqlite.exec(`DROP TABLE ${dialect.quoteIdentifier(nextTable.name)}`),
        () => sqlite.exec(`ALTER TABLE ${dialect.quoteIdentifier(tempTableName)} RENAME TO ${dialect.quoteIdentifier(nextTable.name)}`),
    ]);
}
function columnSelectExpressionForMigration(dialect, existingTable, nextTable, columnName) {
    if (["id", "createdAt", "updatedAt"].includes(columnName)) {
        return dialect.quoteIdentifier(columnName);
    }
    if ((existingTable.fields ?? []).some((field) => field.name === columnName)) {
        return dialect.quoteIdentifier(columnName);
    }
    const field = nextTable.fields.find((candidate) => candidate.name === columnName);
    return field?.defaultValue === undefined ? "NULL" : toSqlLiteral(field.defaultValue, field);
}
function addedFieldsForTable(existingTable, nextTable) {
    const existingFields = new Set((existingTable.fields ?? []).map((field) => field.name));
    return (nextTable.fields ?? []).filter((field) => !existingFields.has(field.name));
}
export function createAppTable(sqlite, table, tableName = table.name) {
    return sqlite.exec(`CREATE TABLE IF NOT EXISTS ${sqlite.dialect.quoteIdentifier(tableName)} (` +
        appTableColumnDefinitions(sqlite.dialect, table).join(", ") +
        ")");
}
// `id`, `createdAt` and `updatedAt` are quoted like every other column. Postgres folds an unquoted
// identifier to lower case, and its adapter used to carry a whole copy of `createAppTable` for no
// other reason; on SQLite and libSQL, which fold nothing, quoting a name that needed no quoting
// declares exactly the same column. One definition, and the difference the engines actually have is
// answered by the dialect entry rather than by a second method body.
function appTableColumnDefinitions(dialect, table) {
    return [
        `${dialect.quoteIdentifier("id")} TEXT PRIMARY KEY`,
        `${dialect.quoteIdentifier("createdAt")} TEXT NOT NULL`,
        `${dialect.quoteIdentifier("updatedAt")} TEXT NOT NULL`,
        ...table.fields.map((field) => appFieldColumnDefinition(dialect, field)),
        ...(table.uniqueConstraints ?? []).map((fields) => `UNIQUE (${fields.map((field) => dialect.quoteIdentifier(field)).join(", ")})`),
    ];
}
function appFieldColumnDefinition(dialect, field) {
    const defaultSql = fieldColumnDefaultSql(field);
    const notNullSql = field.defaultValue !== undefined && !fieldDefaultIsSqlNull(field) ? " NOT NULL" : "";
    return `${dialect.quoteIdentifier(field.name)} ${dialect.columnType(field)}${notNullSql}${defaultSql}`;
}
function fieldDefaultIsSqlNull(field) {
    return field.defaultValue === null && field.kind !== "Json";
}
function fieldColumnDefaultSql(field) {
    return field.defaultValue === undefined ? "" : ` DEFAULT ${toSqlLiteral(field.defaultValue, field)}`;
}
function isDuplicateColumnError(error) {
    const text = [error?.message, error?.stdout, error?.stderr, error].map((value) => String(value ?? "")).join("\n");
    return /duplicate column|already exists/i.test(text);
}
function runSchemaExecIgnoringDuplicateColumn(sqlite, sql) {
    try {
        const result = sqlite.exec(sql);
        if (isPromiseLike(result)) {
            return result.catch((error) => {
                if (!isDuplicateColumnError(error))
                    throw error;
            });
        }
        return result;
    }
    catch (error) {
        if (!isDuplicateColumnError(error))
            throw error;
        return undefined;
    }
}
function toSqlLiteral(value, field = null) {
    if (field?.kind === "Json") {
        assertJsonCompatible(value);
        return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
    }
    if (value === null) {
        return "NULL";
    }
    if (field?.kind === "Date") {
        return `'${normalizeDateValue(value, field.name).replaceAll("'", "''")}'`;
    }
    if (typeof value === "boolean") {
        return value ? "1" : "0";
    }
    if (typeof value === "number") {
        return String(value);
    }
    return `'${String(value).replaceAll("'", "''")}'`;
}
export async function listDatabaseTables(database) {
    return await (database.adapter ?? database.adapter).listInspectableTables();
}
export async function dumpDatabase(database) {
    return await (database.adapter ?? database.adapter).dumpInspectableDatabase();
}
export async function runReadOnlyQuery(database, sql) {
    return await (database.adapter ?? database.adapter).runReadOnlyInspectionQuery(sql);
}
export function splitSqlStatements(sql) {
    const statements = [];
    let start = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    const text = String(sql ?? "");
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        if (lineComment) {
            if (char === "\n") {
                lineComment = false;
            }
            continue;
        }
        if (blockComment) {
            if (char === "*" && next === "/") {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === "\\") {
                escaped = true;
                continue;
            }
            if (char === quote) {
                if (text[index + 1] === quote && quote !== "`") {
                    index += 1;
                    continue;
                }
                quote = null;
            }
            continue;
        }
        if (char === "-" && next === "-") {
            lineComment = true;
            index += 1;
            continue;
        }
        if (char === "/" && next === "*") {
            blockComment = true;
            index += 1;
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            quote = char;
            continue;
        }
        if (char === ";") {
            const statement = text.slice(start, index).trim();
            if (statement) {
                statements.push(statement);
            }
            start = index + 1;
        }
    }
    const last = text.slice(start).trim();
    if (last) {
        statements.push(last);
    }
    return statements;
}
export function quoteIdentifier(identifier) {
    return `"${String(identifier).replaceAll('"', '""')}"`;
}
//# sourceMappingURL=database-runtime.js.map