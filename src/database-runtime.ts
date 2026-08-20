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

import { randomUUID, type BinaryLike } from "node:crypto";
import type { PathLike } from "node:fs";

import { assertNotReservedAuthUserId, authIdentityRowUnlessReserved, authIdentityRowsUnlessReserved, createAnonymousAuthTables, isReservedAuthUserId } from "./auth-runtime.js";
import { ACCESS_KEY_CURRENT_LIMIT, ACCESS_KEY_RETAINED_LIMIT } from "./access-keys-runtime.js";
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

// The monolith's own aliases, redeclared rather than imported: they are types, so they are erased
// before either bundle is built and there is no binding to collide with.
type LooseRecord = Record<string, any>;
type RuntimeConfig = LooseRecord;
type RuntimeEnv = Record<string, string | undefined>;

// A connection can queue SQL statements, but it cannot safely interleave the BEGIN/work/COMMIT
// sequences of two callers. Adapters backed by one connection use this gate for every transaction
// mode, preserving the transaction boundary that the runtime has already chosen (ADR-0026).
function createConnectionTransactionGate() {
  const AsyncLocalStorage = process.getBuiltinModule("node:async_hooks").AsyncLocalStorage;
  const transactionOwnership = new AsyncLocalStorage();
  const transactionOwner = Object.freeze({});
  let transactionTail: Promise<void> = Promise.resolve();
  let transactionActive = false;
  const pending: Array<{ operation: () => any; resolve: (value: any) => void; reject: (error: any) => void; }> = [];

  const drainPending = async () => {
    while (pending.length > 0) {
      const next = pending.shift()!;
      try {
        next.resolve(await next.operation());
      } catch (error) {
        next.reject(error);
      }
    }
  };

  const runOperation = <Value>(operation: () => Value): Value | Promise<Awaited<Value>> => {
    // A root adapter captured by its own transaction callback cannot queue
    // behind that transaction: the owner is waiting for the callback, so the
    // queued operation could never begin. Scoped owner operations bypass this
    // gate through runDirectly; genuinely external callers still wait below.
    if (transactionOwnership.getStore() === transactionOwner) return rejectNestedTransactionScope();
    if (!transactionActive) return operation();
    return new Promise((resolve, reject) => pending.push({ operation, resolve, reject }));
  };

  const runTransaction = async <Value>(operation: () => Value): Promise<Awaited<Value>> => {
    if (transactionOwnership.getStore() === transactionOwner) return await rejectNestedTransactionScope();
    const previous = transactionTail;
    let release: () => void = () => {};
    transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    transactionActive = true;
    try {
      return await transactionOwnership.run(transactionOwner, operation);
    } finally {
      transactionActive = false;
      await drainPending();
      release();
    }
  };

  const whenIdle = async () => await transactionTail.catch(() => {});

  return { runOperation, runTransaction, whenIdle };
}

async function rejectNestedTransactionScope(): Promise<never> {
  throw commandError(
    "Nested database transactions are not supported.",
    "Keep mutation work inside a single Sporades mutation transaction.",
  );
}

type TransactionScopeKind = "transaction" | "snapshot";

const transactionScopes = new WeakMap<object, { revoke: () => void; owner: object; kind: TransactionScopeKind }>();

export function isActiveTransactionScopedAdapter(value: any, owner?: any) {
  const scope = value && typeof value === "object" ? transactionScopes.get(value) : undefined;
  return Boolean(
    scope
    && scope.kind === "transaction"
    && (owner === undefined || scope.owner === owner),
  );
}

function createTransactionScopedAdapter(adapter: LooseRecord, operations: LooseRecord, owner: LooseRecord, kind: TransactionScopeKind) {
  let active = true;
  const assertActive = () => {
    if (!active) throw commandError(
      "Transaction-scoped database access is no longer active.",
      "Do not retain ctx.db operations after the trusted handler has completed.",
    );
  };
  const operationOwner = typeof operations.exec === "function" ? operations : adapter;
  const exec = operationOwner.exec;
  const prepare = operationOwner.prepare;
  const guardedOperations = {
    exec(...args: any[]) { assertActive(); return Reflect.apply(exec, operationOwner, args); },
    prepare(...args: any[]) {
      assertActive();
      const statement: any = Reflect.apply(prepare, operationOwner, args);
      const guardedStatement: any = Object.create(statement);
      for (const method of ["all", "get", "run", "columns"]) {
        if (typeof statement[method] !== "function") continue;
        guardedStatement[method] = (...params: any[]) => {
          assertActive();
          return Reflect.apply(statement[method], statement, params);
        };
      }
      return guardedStatement;
    },
  };
  const scopedAdapter = Object.assign(Object.create(adapter), guardedOperations, {
    withTransaction: rejectNestedTransactionScope,
    withReadOnlySnapshot: rejectNestedTransactionScope,
  });
  transactionScopes.set(scopedAdapter, {
    revoke: () => { active = false; },
    owner,
    kind,
  });
  return scopedAdapter;
}

function revokeTransactionScopedAdapter(adapter: LooseRecord) {
  transactionScopes.get(adapter)?.revoke();
  transactionScopes.delete(adapter);
}

const transactionOperations = Symbol.for("sporades.database.transactionOperations");
const transactionBeforeCommitChecks = Symbol.for("sporades.database.transactionBeforeCommitChecks");

async function runTransactionBeforeCommitChecks(transactionAdapter: LooseRecord) {
  for (const check of (transactionAdapter as any)[transactionBeforeCommitChecks] ?? []) await check();
}

export async function createRuntimeDatabaseAdapter(databasePath: any, serverEnv: RuntimeEnv = {}, config: RuntimeConfig = {}): Promise<LooseRecord> {
  if (
    config.services?.database?.engine === "libsql" &&
    serverEnv.SPORADES_SERVICE_DATABASE_ENGINE === "libsql" &&
    serverEnv.SPORADES_SERVICE_DATABASE_URL
  ) {
    return await createLibsqlDatabaseAdapter({
      url: serverEnv.SPORADES_SERVICE_DATABASE_URL,
      authToken: serverEnv.SPORADES_SERVICE_DATABASE_AUTH_TOKEN,
    });
  }
  if (
    config.services?.database?.engine === "postgres" &&
    serverEnv.SPORADES_SERVICE_DATABASE_ENGINE === "postgres" &&
    serverEnv.SPORADES_SERVICE_DATABASE_URL
  ) {
    return await createPostgresDatabaseAdapter({
      url: serverEnv.SPORADES_SERVICE_DATABASE_URL,
    });
  }
  return await createSqliteDatabaseAdapter(databasePath);
}

export async function createRuntimeInspectionAdapter(databasePath: any, serverEnv: RuntimeEnv = {}, config: RuntimeConfig = {}): Promise<LooseRecord | null> {
  if (config.services?.database?.engine === "libsql" && serverEnv.SPORADES_SERVICE_DATABASE_ENGINE === "libsql" && serverEnv.SPORADES_SERVICE_DATABASE_URL) {
    return await createLibsqlDatabaseAdapter({ url: serverEnv.SPORADES_SERVICE_DATABASE_URL, authToken: serverEnv.SPORADES_SERVICE_DATABASE_AUTH_TOKEN });
  }
  if (config.services?.database?.engine === "postgres" && serverEnv.SPORADES_SERVICE_DATABASE_ENGINE === "postgres" && serverEnv.SPORADES_SERVICE_DATABASE_URL) {
    return await createPostgresDatabaseAdapter({ url: serverEnv.SPORADES_SERVICE_DATABASE_URL });
  }
  if (!nodeFsModule.existsSync(String(databasePath))) return null;
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
export function createDatabaseDialect(spec: LooseRecord): LooseRecord {
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
    throw commandError(
      `Incomplete Database adapter dialect: ${missing.join(", ")}.`,
      "A Database engine supplies statement primitives, a dialect and row normalization. Answer every dialect entry.",
    );
  }
  // `sql` is derived from `quoteIdentifier` rather than supplied, for the same reason normalization
  // derives `row` from `columnName` and `value`: an engine that answered the quoting entry and then
  // received statement text that had bypassed it would fold anyway. ADR-0039 records why every
  // identifier goes through it.
  return { ...spec, sql: (statement: string) => quoteSqlIdentifiers(spec.quoteIdentifier, statement) };
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
function quoteSqlIdentifiers(quoteIdentifier: (identifier: string) => string, statement: string) {
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
export function createDatabaseNormalization(spec: LooseRecord): LooseRecord {
  const missing = ["name", "columnName", "value"].filter((key) => spec[key] == null);
  if (missing.length > 0) {
    throw commandError(
      `Incomplete Database adapter normalization: ${missing.join(", ")}.`,
      "A Database engine supplies statement primitives, a dialect and row normalization. Answer every normalization entry.",
    );
  }
  return {
    ...spec,
    row: (raw: LooseRecord) =>
      Object.fromEntries(Object.entries(raw).map(([key, value]) => [spec.columnName(key), spec.value(value)])),
  };
}

// SQLite preserves the case it was given and `node:sqlite` already hands back JavaScript values, so
// both entries are the identity. Its statement primitives therefore return rows as the driver
// produced them rather than rebuilding each one to prove a no-op; the identity is declared here so
// it can be read, and paid for nowhere.
export function sqliteRowNormalization() {
  return createDatabaseNormalization({
    name: "sqlite",
    columnName: (name: string) => name,
    value: (value: any) => value,
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
    columnName: (name: string) => name,
    // Values are already coerced by the wire parser, which reads each column's type oid from the
    // row description. The row does not carry the oid, so the per-value entry cannot repeat that
    // work and does not need to.
    value: (value: any) => value,
  });
}

export function libsqlRowNormalization() {
  return createDatabaseNormalization({
    name: "libsql",
    // libSQL preserves declared case, so there is nothing to restore.
    columnName: (name: string) => name,
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
    columnType: (field: LooseRecord) => field.sqliteType,
    // Write-or-replace a row identified by its key columns. Table and column names arrive
    // unquoted and are quoted here, so the upsert asks for the columns in the style every other
    // statement names them.
    upsertSql: (table: string, columns: string[], _conflictColumns: string[]) =>
      `INSERT OR REPLACE INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) ` +
      `VALUES (${columns.map(() => "?").join(", ")})`,
    // The catalog. Both entries answer rows carrying a `name`, whatever the engine's catalog calls
    // the column, so the shared inspection methods read one shape.
    listTables: (adapter: LooseRecord) =>
      adapter
        .prepare(
          `SELECT ${quoteIdentifier("name")} FROM ${quoteIdentifier("sqlite_schema")} ` +
          `WHERE ${quoteIdentifier("type")} = 'table' AND ${quoteIdentifier("name")} NOT LIKE 'sqlite_%' ` +
          `ORDER BY ${quoteIdentifier("name")}`,
        )
        .all(),
    describeColumns: (adapter: LooseRecord, tableName: string) =>
      adapter.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all(),
    // Declare a column that an older database may not have. SQLite has no
    // `ADD COLUMN IF NOT EXISTS`, so the ALTER is issued and a duplicate-column error swallowed.
    // Probing `PRAGMA table_info` first would work here and nowhere else, which is exactly why the
    // strategy is a dialect entry rather than a line in a shared body.
    addMissingColumn: (adapter: LooseRecord, table: string, column: string, type: string) =>
      runSchemaExecIgnoringDuplicateColumn(
        adapter,
        `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${type}`,
      ),
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
    columnType: (field: LooseRecord) => field.sqliteType,
    // Postgres has no `INSERT OR REPLACE`; the same intent is `ON CONFLICT ... DO UPDATE`, which
    // updates the non-key columns from the row that was offered.
    upsertSql: (table: string, columns: string[], conflictColumns: string[]) => {
      const updated = columns.filter((column) => !conflictColumns.includes(column));
      return (
        `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) ` +
        `VALUES (${columns.map(() => "?").join(", ")}) ` +
        `ON CONFLICT (${conflictColumns.map(quoteIdentifier).join(", ")}) DO UPDATE SET ` +
        updated.map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`).join(", ")
      );
    },
    // `sqlite_schema` and `PRAGMA table_info` are SQLite's alone; `information_schema` is the
    // standard catalog. Both answer rows carrying a `name`, which is the shape the shared
    // inspection methods read.
    listTables: (adapter: LooseRecord) =>
      adapter
        .prepare(
          `SELECT ${quoteIdentifier("table_name")} AS ${quoteIdentifier("name")} ` +
          `FROM ${quoteIdentifier("information_schema")}.${quoteIdentifier("tables")} ` +
          `WHERE ${quoteIdentifier("table_schema")} = current_schema() ` +
          `AND ${quoteIdentifier("table_type")} = 'BASE TABLE' ORDER BY ${quoteIdentifier("table_name")}`,
        )
        .all(),
    describeColumns: (adapter: LooseRecord, tableName: string) =>
      adapter
        .prepare(
          `SELECT ${quoteIdentifier("column_name")} AS ${quoteIdentifier("name")} ` +
          `FROM ${quoteIdentifier("information_schema")}.${quoteIdentifier("columns")} ` +
          `WHERE ${quoteIdentifier("table_schema")} = current_schema() AND ${quoteIdentifier("table_name")} = ? ` +
          `ORDER BY ${quoteIdentifier("ordinal_position")}`,
        )
        .all(tableName),
    // Postgres has `ADD COLUMN IF NOT EXISTS`, and using it is not merely tidier than swallowing a
    // duplicate-column error. A swallowed error on Postgres aborts the enclosing transaction, so
    // every statement after it fails with `current transaction is aborted`. Storage bootstrap runs
    // outside the migration transaction to keep that hazard out of reach; asking the engine not to
    // raise the error in the first place removes it.
    addMissingColumn: (adapter: LooseRecord, table: string, column: string, type: string) =>
      adapter.exec(
        `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN IF NOT EXISTS ${quoteIdentifier(column)} ${type}`,
      ),
  });
}

// The engine-agnostic Database adapter method set, defined once. Composed into every engine's
// adapter by spreading, so each method is an own enumerable property and the conformance coverage
// gate's enumeration sees the same names on every engine.
export function createSharedDatabaseAdapterMethods(dialect: LooseRecord): LooseRecord {
  // Every identifier below is written as `[name]` and quoted through the dialect here. ADR-0039
  // records why: a statement that names a column in a style its table was not created with errors
  // outright on Postgres, and the runtime's own DDL goes through the same call so nothing folds.
  const sql = dialect.sql;
  return {
    ensureSystemTable() {
      return this.exec(sql("CREATE TABLE IF NOT EXISTS [sporades] ([key] TEXT PRIMARY KEY, [value] TEXT NOT NULL)"));
    },
    readSystemMetadata(key: string) {
      return this.prepare(sql("SELECT [value] FROM [sporades] WHERE [key] = ?")).get(key) ?? null;
    },
    writeSystemMetadata(key: string, value: any) {
      return this.prepare(dialect.upsertSql("sporades", ["key", "value"], ["key"])).run(key, value);
    },
    readSchemaMetadata() {
      return this.readSystemMetadata("schema");
    },
    writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: LooseRecord) {
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
    insertLogIndexEvent(event: any) {
      return insertLogIndexEvent(this, event);
    },
    pruneLogIndex(limit: any) {
      return pruneLogIndex(this, limit);
    },
    readRecentLogEvents(limit: number | undefined) {
      return readRecentLogEvents(this, limit);
    },
    ensureFileStorage() {
      return createFileStorageTables(this);
    },
    findFileBucket(ownerId: any, name: any) {
      return this.prepare(sql("SELECT * FROM [sporades_file_buckets] WHERE [ownerId] = ? AND [name] = ?")).get(ownerId, name) ?? null;
    },
    createFileBucket(row: { id: any; ownerId: any; name: any; createdAt: any; }) {
      return this.prepare(
        sql("INSERT INTO [sporades_file_buckets] ([id], [ownerId], [name], [createdAt]) VALUES (?, ?, ?, ?)"),
      ).run(
        row.id,
        row.ownerId,
        row.name,
        row.createdAt,
      );
    },
    insertFileRow(row: { id: any; ownerId: any; bucketId: any; bucketName: any; path: any; name: any; type: any; size: any; version: any; status: any; createdAt: any; updatedAt: any; }) {
      return this.prepare(
        sql(
          "INSERT INTO [sporades_files] " +
          "([id], [ownerId], [bucketId], [bucketName], [path], [name], [type], [size], [version], [status], [createdAt], [updatedAt], [deletedAt]) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        ),
      ).run(
        row.id,
        row.ownerId,
        row.bucketId,
        row.bucketName,
        row.path,
        row.name,
        row.type,
        row.size,
        row.version,
        row.status,
        row.createdAt,
        row.updatedAt,
      );
    },
    updatePendingFileRow(row: { bucketId: any; bucketName: any; path: any; name: any; type: any; size: any; version: any; status: any; updatedAt: any; id: any; }) {
      return this.prepare(
        sql(
          "UPDATE [sporades_files] SET [bucketId] = ?, [bucketName] = ?, [path] = ?, [name] = ?, [type] = ?, [size] = ?, " +
          "[version] = ?, [status] = ?, [updatedAt] = ?, [deletedAt] = NULL WHERE [id] = ?",
        ),
      ).run(row.bucketId, row.bucketName, row.path, row.name, row.type, row.size, row.version, row.status, row.updatedAt, row.id);
    },
    insertFileUpload(row: { id: any; fileId: any; ownerId: any; bucketId: any; bucketName: any; path: any; name: any; type: any; version: any; expectedSize: any; createdAt: any; }) {
      return this.prepare(
        sql(
          "INSERT INTO [sporades_file_uploads] " +
          "([id], [fileId], [ownerId], [bucketId], [bucketName], [path], [name], [type], [version], [expectedSize], [createdAt]) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ),
      ).run(
        row.id,
        row.fileId,
        row.ownerId,
        row.bucketId,
        row.bucketName,
        row.path,
        row.name,
        row.type,
        row.version,
        row.expectedSize,
        row.createdAt,
      );
    },
    selectFileById(fileId: any) {
      return this.prepare(sql("SELECT * FROM [sporades_files] WHERE [id] = ?")).get(fileId) ?? null;
    },
    selectLiveFileByPath(path: any) {
      return this.prepare(
        sql("SELECT * FROM [sporades_files] WHERE [path] = ? AND [deletedAt] IS NULL AND [status] = ?"),
      ).all(path, "uploaded");
    },
    selectActiveFileByPath(path: any) {
      return this.prepare(
        sql("SELECT * FROM [sporades_files] WHERE [path] = ? AND [deletedAt] IS NULL AND [status] IN (?, ?)"),
      ).all(
        path,
        "pending",
        "uploaded",
      );
    },
    selectPendingFileUploadByPath(path: any) {
      return (
        this.prepare(
          sql("SELECT * FROM [sporades_file_uploads] WHERE [path] = ? ORDER BY [createdAt] DESC, [id] DESC LIMIT 1"),
        ).get(path) ?? null
      );
    },
    selectFileUpload(uploadId: any) {
      return this.prepare(sql("SELECT * FROM [sporades_file_uploads] WHERE [id] = ?")).get(uploadId) ?? null;
    },
    completeFileUpload(upload: { id: any; fileId: any; version: any; bucketId: any; bucketName: any; path: any; name: any; type: any; ownerId: any; createdAt: any; }, size: any, updatedAt: any) {
      return thenIfPromise(
        this.prepare(sql("DELETE FROM [sporades_file_uploads] WHERE [id] = ? AND [fileId] = ? AND [version] = ?")).run(
          upload.id,
          upload.fileId,
          upload.version,
        ),
        (consumed: any) => {
          if (consumed.changes === 0) {
            return consumed;
          }
          return thenIfPromise(this.selectFileById(upload.fileId), (existing: any) => {
            if (existing) {
              if (existing.deletedAt !== null && existing.deletedAt !== undefined) {
                return { changes: 0 };
              }
              return this.prepare(
                sql(
                  "UPDATE [sporades_files] SET [bucketId] = ?, [bucketName] = ?, [path] = ?, [name] = ?, [type] = ?, [size] = ?, " +
                  "[version] = ?, [status] = ?, [updatedAt] = ? WHERE [id] = ? AND [deletedAt] IS NULL",
                ),
              ).run(
                upload.bucketId,
                upload.bucketName,
                upload.path,
                upload.name,
                upload.type,
                size,
                upload.version,
                "uploaded",
                updatedAt,
                upload.fileId,
              );
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
        },
      );
    },
    deleteFileUploadsForPath(path: any) {
      return this.prepare(sql("DELETE FROM [sporades_file_uploads] WHERE [path] = ?")).run(path);
    },
    deleteFileUploadsForFile(ownerId: any, fileId: any) {
      return this.prepare(sql("DELETE FROM [sporades_file_uploads] WHERE [ownerId] = ? AND [fileId] = ?")).run(ownerId, fileId);
    },
    deleteFileUpload(uploadId: any) {
      return this.prepare(sql("DELETE FROM [sporades_file_uploads] WHERE [id] = ?")).run(uploadId);
    },
    selectPublicFileRow(publicUrlId: any) {
      return (
        this.prepare(
          sql(
            "SELECT [p].[id] AS [publicUrlId], [p].[fileId], [p].[version] AS [publicVersion], [p].[expiresAt], [p].[revokedAt], " +
            "[f].[id], [f].[ownerId], [f].[bucketId], [f].[bucketName], [f].[path], [f].[name], [f].[type], [f].[size], " +
            "[f].[version], [f].[status], [f].[createdAt], [f].[updatedAt], [f].[deletedAt] " +
            "FROM [sporades_file_public_urls] [p] JOIN [sporades_files] [f] ON [f].[id] = [p].[fileId] " +
            "WHERE [p].[id] = ?",
          ),
        ).get(publicUrlId) ?? null
      );
    },
    insertPublicFileUrl(row: { id: any; fileId: any; ownerId: any; version: any; expiresAt: any; createdAt: any; }) {
      return this.prepare(
        sql(
          "INSERT INTO [sporades_file_public_urls] ([id], [fileId], [ownerId], [version], [expiresAt], [createdAt], [revokedAt]) " +
          "VALUES (?, ?, ?, ?, ?, ?, NULL)",
        ),
      ).run(row.id, row.fileId, row.ownerId, row.version, row.expiresAt, row.createdAt);
    },
    revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any) {
      return this.prepare(
        sql("UPDATE [sporades_file_public_urls] SET [revokedAt] = ? WHERE [id] = ? AND [ownerId] = ? AND [revokedAt] IS NULL"),
      ).run(
        revokedAt,
        publicUrlId,
        ownerId,
      );
    },
    revokePublicFileUrlsForFile(fileId: any, revokedAt: any) {
      return this.prepare(
        sql("UPDATE [sporades_file_public_urls] SET [revokedAt] = ? WHERE [fileId] = ? AND [revokedAt] IS NULL"),
      ).run(
        revokedAt,
        fileId,
      );
    },
    markFileDeleted(fileId: any, deletedAt: any) {
      return this.prepare(sql("UPDATE [sporades_files] SET [deletedAt] = ?, [updatedAt] = ? WHERE [id] = ?")).run(deletedAt, deletedAt, fileId);
    },
    fileRowForOwner(fileId: any, ownerId: any) {
      return (
        this.prepare(
          sql("SELECT * FROM [sporades_files] WHERE [id] = ? AND [ownerId] = ? AND [deletedAt] IS NULL AND [status] = ?"),
        ).get(
          fileId,
          ownerId,
          "uploaded",
        ) ?? null
      );
    },
    ensureAuthStorage(authConfig: any = null) {
      return createAnonymousAuthTables(this, authConfig);
    },
    issueAccessKeyRecord(row: LooseRecord) {
      let outcome: LooseRecord | null = null;
      const sequence = chainMaybePromise([
        () => thenIfPromise(this.prepare(
          sql(
            "SELECT [id] FROM [sporades_auth_users] " +
            "WHERE [id] = ? AND [isAuthenticated] = ? AND [isGuest] = ?",
          ),
        ).get(row.ownerUserId, 1, 0), (owner: LooseRecord | null) => {
          if (!owner) outcome = { status: "owner-ineligible" };
        }),
        () => outcome ?? this.prepare(
          sql(
            "INSERT INTO [sporades_auth_access_key_owners] " +
            "([ownerUserId], [currentCount], [totalCount], [operationRevision]) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT ([ownerUserId]) DO NOTHING",
          ),
        ).run(row.ownerUserId, 0, 0, 0),
        () => outcome ?? thenIfPromise(this.prepare(
          sql(
            "UPDATE [sporades_auth_access_key_owners] " +
            "SET [currentCount] = [currentCount] + 1, [totalCount] = [totalCount] + 1, " +
            "[operationRevision] = [operationRevision] + 1 " +
            "WHERE [ownerUserId] = ? AND [currentCount] < ? AND [totalCount] < ?",
          ),
        ).run(row.ownerUserId, ACCESS_KEY_CURRENT_LIMIT, ACCESS_KEY_RETAINED_LIMIT), (reserved: LooseRecord) => {
          if (reserved.changes === 0) outcome = { status: "limit" };
        }),
        () => outcome ?? thenIfPromise(this.prepare(
          sql(
            "INSERT INTO [sporades_auth_access_keys] " +
            "([id], [ownerUserId], [name], [reservedName], [grantsJson], [secretVersion], [selector], " +
            "[verifierDigest], [lifecycleRevision], [createdAt], [expiresAt], [rotatedAt], [revokedAt], " +
            "[revocationCause], [lastUsedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL) " +
            "ON CONFLICT DO NOTHING",
          ),
        ).run(
          row.id, row.ownerUserId, row.name, row.reservedName, row.grantsJson, row.secretVersion,
          row.selector, row.verifierDigest, row.lifecycleRevision, row.createdAt, row.expiresAt,
        ), (inserted: LooseRecord) => {
          if (inserted.changes !== 0) outcome = { status: "issued" };
        }),
        () => outcome ?? this.prepare(
          sql(
            "UPDATE [sporades_auth_access_key_owners] " +
            "SET [currentCount] = [currentCount] - 1, [totalCount] = [totalCount] - 1, " +
            "[operationRevision] = [operationRevision] + 1 WHERE [ownerUserId] = ?",
          ),
        ).run(row.ownerUserId),
        () => outcome ?? thenIfPromise(this.prepare(
          sql("SELECT [id] FROM [sporades_auth_access_keys] WHERE [ownerUserId] = ? AND [reservedName] = ?"),
        ).get(row.ownerUserId, row.reservedName), (nameCollision: LooseRecord | null) => {
          outcome = { status: nameCollision ? "name-conflict" : "selector-conflict" };
        }),
      ]);
      return thenIfPromise(sequence, () => outcome);
    },
    listAccessKeyRecordsForOwner(ownerUserId: string) {
      return this.prepare(
        sql(
          "SELECT [id], [ownerUserId], [name], [grantsJson], [lifecycleRevision], [createdAt], [expiresAt], " +
          "[rotatedAt], [revokedAt], [revocationCause], [lastUsedAt] FROM [sporades_auth_access_keys] " +
          "WHERE [ownerUserId] = ? ORDER BY [createdAt] DESC, [id] DESC",
        ),
      ).all(ownerUserId);
    },
    findAccessKeyAuthenticationRecord(selector: string) {
      return this.prepare(
        sql(
          "SELECT [k].*, [u].[displayName] AS [ownerDisplayName], [u].[email] AS [ownerEmail], " +
          "[u].[picture] AS [ownerPicture], [u].[isAuthenticated] AS [ownerIsAuthenticated], " +
          "[u].[isGuest] AS [ownerIsGuest] FROM [sporades_auth_access_keys] [k] " +
          "LEFT JOIN [sporades_auth_users] [u] ON [u].[id] = [k].[ownerUserId] " +
          "WHERE [k].[secretVersion] = ? AND [k].[selector] = ?",
        ),
      ).get(1, selector) ?? null;
    },
    touchAccessKeyLastUsed(id: string, usedAt: string, coalesceBefore: string) {
      return this.prepare(
        sql(
          "UPDATE [sporades_auth_access_keys] SET [lastUsedAt] = ? " +
          "WHERE [id] = ? AND [revokedAt] IS NULL AND ([lastUsedAt] IS NULL OR [lastUsedAt] < ?)",
        ),
      ).run(usedAt, id, coalesceBefore);
    },
    revokeAccessKeyRecord(input: LooseRecord) {
      let existing: LooseRecord | null = null;
      let revoked = false;
      const sequence = chainMaybePromise([
        () => this.prepare(
          sql(
            "UPDATE [sporades_auth_access_key_owners] SET [operationRevision] = [operationRevision] + 1 " +
            "WHERE [ownerUserId] = ?",
          ),
        ).run(input.ownerUserId),
        () => thenIfPromise(this.prepare(
          sql("SELECT * FROM [sporades_auth_access_keys] WHERE [ownerUserId] = ? AND [id] = ?"),
        ).get(input.ownerUserId, input.id), (row: LooseRecord | null | undefined) => { existing = row ?? null; }),
        () => !existing || existing.revokedAt ? existing : thenIfPromise(this.prepare(
          sql(
            "UPDATE [sporades_auth_access_keys] SET [reservedName] = NULL, [selector] = NULL, " +
            "[verifierDigest] = NULL, [revokedAt] = ?, [revocationCause] = ?, " +
            "[lifecycleRevision] = [lifecycleRevision] + 1 " +
            "WHERE [ownerUserId] = ? AND [id] = ? AND [revokedAt] IS NULL",
          ),
        ).run(input.revokedAt, input.revocationCause, input.ownerUserId, input.id), (result: LooseRecord) => {
          revoked = result.changes !== 0;
        }),
        () => !revoked ? undefined : this.prepare(
          sql(
            "UPDATE [sporades_auth_access_key_owners] SET [currentCount] = [currentCount] - 1 " +
            "WHERE [ownerUserId] = ?",
          ),
        ).run(input.ownerUserId),
        () => !existing ? undefined : thenIfPromise(this.prepare(
          sql("SELECT * FROM [sporades_auth_access_keys] WHERE [ownerUserId] = ? AND [id] = ?"),
        ).get(input.ownerUserId, input.id), (row: LooseRecord | null | undefined) => { existing = row ?? null; }),
      ]);
      return thenIfPromise(sequence, () => existing);
    },
    rotateAccessKeyRecord(input: LooseRecord) {
      let existing: LooseRecord | null = null;
      let status = "not-found";
      const sequence = chainMaybePromise([
        () => this.prepare(sql(
          "UPDATE [sporades_auth_access_key_owners] SET [operationRevision] = [operationRevision] + 1 WHERE [ownerUserId] = ?",
        )).run(input.ownerUserId),
        () => thenIfPromise(this.prepare(
          sql("SELECT * FROM [sporades_auth_access_keys] WHERE [ownerUserId] = ? AND [id] = ?"),
        ).get(input.ownerUserId, input.id), (row: LooseRecord | null | undefined) => {
          existing = row ?? null;
          if (!existing) status = "not-found";
          else if (existing.revokedAt || (existing.expiresAt && Date.parse(existing.expiresAt) <= Date.parse(input.rotatedAt))) status = "not-active";
          else if (Number(existing.lifecycleRevision) !== Number(input.lifecycleRevision)) status = "revision-conflict";
          else status = "ready";
        }),
        () => status !== "ready" ? undefined : thenIfPromise(this.prepare(
          sql("SELECT [id] FROM [sporades_auth_access_keys] WHERE [secretVersion] = ? AND [selector] = ?"),
        ).get(input.secretVersion, input.selector), (collision: LooseRecord | null | undefined) => {
          if (collision) status = "selector-conflict";
        }),
        () => status !== "ready" ? undefined : thenIfPromise(this.prepare(sql(
          "UPDATE [sporades_auth_access_keys] SET [secretVersion] = ?, [selector] = ?, [verifierDigest] = ?, " +
          "[rotatedAt] = ?, [lifecycleRevision] = [lifecycleRevision] + 1 " +
          "WHERE [ownerUserId] = ? AND [id] = ? AND [lifecycleRevision] = ? AND [revokedAt] IS NULL",
        )).run(
          input.secretVersion, input.selector, input.verifierDigest, input.rotatedAt,
          input.ownerUserId, input.id, input.lifecycleRevision,
        ), (result: LooseRecord) => { status = result.changes === 1 ? "rotated" : "revision-conflict"; }),
        () => status !== "rotated" ? undefined : thenIfPromise(this.prepare(
          sql("SELECT * FROM [sporades_auth_access_keys] WHERE [ownerUserId] = ? AND [id] = ?"),
        ).get(input.ownerUserId, input.id), (row: LooseRecord | null | undefined) => { existing = row ?? null; }),
      ]);
      return thenIfPromise(sequence, () => ({ status, record: existing }));
    },
    deleteRevokedAccessKeyRecord(input: LooseRecord) {
      let existing: LooseRecord | null = null;
      let status = "not-found";
      const sequence = chainMaybePromise([
        () => this.prepare(sql(
          "UPDATE [sporades_auth_access_key_owners] SET [operationRevision] = [operationRevision] + 1 WHERE [ownerUserId] = ?",
        )).run(input.ownerUserId),
        () => thenIfPromise(this.prepare(
          sql("SELECT * FROM [sporades_auth_access_keys] WHERE [ownerUserId] = ? AND [id] = ?"),
        ).get(input.ownerUserId, input.id), (row: LooseRecord | null | undefined) => {
          existing = row ?? null;
          status = !existing ? "not-found" : existing.revokedAt ? "ready" : "requires-revoked";
        }),
        () => status !== "ready" ? undefined : thenIfPromise(this.prepare(
          sql("DELETE FROM [sporades_auth_access_keys] WHERE [ownerUserId] = ? AND [id] = ? AND [revokedAt] IS NOT NULL"),
        ).run(input.ownerUserId, input.id), (result: LooseRecord) => { status = result.changes === 1 ? "deleted" : "not-found"; }),
        () => status !== "deleted" ? undefined : this.prepare(sql(
          "UPDATE [sporades_auth_access_key_owners] SET [totalCount] = [totalCount] - 1 WHERE [ownerUserId] = ?",
        )).run(input.ownerUserId),
      ]);
      return thenIfPromise(sequence, () => ({ status, id: status === "deleted" ? input.id : null, record: existing }));
    },
    bulkRevokeAccessKeysForOwner(input: LooseRecord) {
      let revokedCount = 0;
      let records: LooseRecord[] = [];
      const sequence = chainMaybePromise([
        () => this.prepare(sql(
          "UPDATE [sporades_auth_access_key_owners] SET [operationRevision] = [operationRevision] + 1 WHERE [ownerUserId] = ?",
        )).run(input.ownerUserId),
        () => thenIfPromise(this.prepare(sql(
          "SELECT [id], [ownerUserId], [name], [grantsJson], [lifecycleRevision], [createdAt], [expiresAt], " +
          "[rotatedAt], [revokedAt], [revocationCause], [lastUsedAt] FROM [sporades_auth_access_keys] " +
          "WHERE [ownerUserId] = ? AND [revokedAt] IS NULL ORDER BY [createdAt] DESC, [id] DESC",
        )).all(input.ownerUserId), (rows: LooseRecord[]) => { records = rows; }),
        () => thenIfPromise(this.prepare(sql(
          "UPDATE [sporades_auth_access_keys] SET [reservedName] = NULL, [selector] = NULL, [verifierDigest] = NULL, " +
          "[revokedAt] = ?, [revocationCause] = ?, [lifecycleRevision] = [lifecycleRevision] + 1 " +
          "WHERE [ownerUserId] = ? AND [revokedAt] IS NULL",
        )).run(input.revokedAt, input.revocationCause, input.ownerUserId), (result: LooseRecord) => {
          revokedCount = Number(result.changes ?? 0);
        }),
        () => revokedCount === 0 ? undefined : this.prepare(sql(
          "UPDATE [sporades_auth_access_key_owners] SET [currentCount] = 0 WHERE [ownerUserId] = ?",
        )).run(input.ownerUserId),
      ]);
      return thenIfPromise(sequence, () => ({ revokedCount, records }));
    },
    ensureUserPreferencesStorage() {
      return createUserPreferencesTables(this);
    },
    ensureTeamsStorage() {
      return createTeamTables(this);
    },
    readUserPreferences(userId: any) {
      return this.prepare(
        sql("SELECT [userId], [value], [updatedAt] FROM [sporades_user_preferences] WHERE [userId] = ?"),
      ).get(userId) ?? null;
    },
    saveUserPreferences(row: { userId: any; value: any; updatedAt: any; }) {
      return this.prepare(
        dialect.upsertSql("sporades_user_preferences", ["userId", "value", "updatedAt"], ["userId"]),
      ).run(row.userId, row.value, row.updatedAt);
    },
    findAuthIdentityByProviderSubject(provider: any, subject: any) {
      const row = this.prepare(
        sql(
          "SELECT [id], [userId], [provider], [subject], [email], [displayName], [picture], [createdAt], [updatedAt] " +
          "FROM [sporades_auth_identities] WHERE [provider] = ? AND [subject] = ?",
        ),
      ).get(provider, subject) ?? null;
      return authIdentityRowUnlessReserved(row);
    },
    findLegacyAuthIdentitiesByProviderEmail(provider: any, email: any) {
      const rows = this.prepare(
        sql(
          "SELECT [id], [userId], [provider], [subject], [email], [displayName], [picture], [createdAt], [updatedAt] " +
          "FROM [sporades_auth_identities] WHERE [provider] = ? AND [email] = ? AND [subject] LIKE 'legacy:%' " +
          "ORDER BY [createdAt], [id]",
        ),
      ).all(provider, email);
      return authIdentityRowsUnlessReserved(rows);
    },
    insertAuthIdentity(row: { id: any; userId: any; provider: any; subject: any; email: any; displayName: any; picture: any; createdAt: any; updatedAt: any; }) {
      assertNotReservedAuthUserId(row.userId);
      return this.prepare(
        sql(
          "INSERT INTO [sporades_auth_identities] " +
          "([id], [userId], [provider], [subject], [email], [displayName], [picture], [createdAt], [updatedAt]) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ),
      ).run(row.id, row.userId, row.provider, row.subject, row.email, row.displayName, row.picture, row.createdAt, row.updatedAt);
    },
    updateAuthIdentity(row: { id: any; subject: any; email: any; displayName: any; picture: any; updatedAt: any; }) {
      return this.prepare(
        sql(
          "UPDATE [sporades_auth_identities] SET [subject] = ?, [email] = ?, [displayName] = ?, [picture] = ?, " +
          "[updatedAt] = ? WHERE [id] = ?",
        ),
      ).run(row.subject, row.email, row.displayName, row.picture, row.updatedAt, row.id);
    },
    insertAuthUser(row: { id: any; createdAt: any; displayName: any; email: any; picture: any; isAuthenticated: any; isGuest: any; provider: any; }) {
      assertNotReservedAuthUserId(row.id);
      return this.prepare(
        sql(
          "INSERT INTO [sporades_auth_users] " +
          "([id], [createdAt], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider]) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ),
      ).run(row.id, row.createdAt, row.displayName, row.email, row.picture, row.isAuthenticated, row.isGuest, row.provider);
    },
    updateAuthUserProfile(row: { displayName: any; picture: any; isAuthenticated: any; isGuest: any; id: any; }) {
      assertNotReservedAuthUserId(row.id);
      return this.prepare(
        sql(
          "UPDATE [sporades_auth_users] SET [displayName] = ?, [picture] = ?, [isAuthenticated] = ?, [isGuest] = ? WHERE [id] = ?",
        ),
      ).run(row.displayName, row.picture, row.isAuthenticated, row.isGuest, row.id);
    },
    linkAuthUser(row: { displayName: any; email: any; picture: any; isAuthenticated: any; isGuest: any; provider: any; id: any; }) {
      assertNotReservedAuthUserId(row.id);
      return this.prepare(
        sql(
          "UPDATE [sporades_auth_users] SET [displayName] = ?, [email] = ?, [picture] = ?, [isAuthenticated] = ?, " +
          "[isGuest] = ? WHERE [id] = ?",
        ),
      ).run(row.displayName, row.email, row.picture, row.isAuthenticated, row.isGuest, row.id);
    },
    insertAuthSession(row: { token: any; userId: any; provider: any; createdAt: any; expiresAt: any; }) {
      assertNotReservedAuthUserId(row.userId);
      return this.prepare(
        sql(
          "INSERT INTO [sporades_auth_sessions] ([token], [userId], [provider], [createdAt], [expiresAt]) " +
          "VALUES (?, ?, ?, ?, ?)",
        ),
      ).run(
        row.token,
        row.userId,
        row.provider,
        row.createdAt,
        row.expiresAt,
      );
    },
    deleteAuthSession(token: any) {
      return this.prepare(sql("DELETE FROM [sporades_auth_sessions] WHERE [token] = ?")).run(token);
    },
    refreshAuthSession(token: any, expiresAt: any) {
      return this.prepare(sql("UPDATE [sporades_auth_sessions] SET [expiresAt] = ? WHERE [token] = ?")).run(expiresAt, token);
    },
    setAuthSessionProvider(token: any, provider: any) {
      return this.prepare(sql("UPDATE [sporades_auth_sessions] SET [provider] = ? WHERE [token] = ?")).run(provider, token);
    },
    rotateAuthSession(previousToken: any, row: { token: any; userId: any; provider: any; createdAt: any; expiresAt: any; }) {
      assertNotReservedAuthUserId(row.userId);
      return this.prepare(
        sql(
          "UPDATE [sporades_auth_sessions] SET [token] = ?, [userId] = ?, [provider] = ?, [createdAt] = ?, " +
          "[expiresAt] = ? WHERE [token] = ?",
        ),
      ).run(
        row.token,
        row.userId,
        row.provider,
        row.createdAt,
        row.expiresAt,
        previousToken,
      );
    },
    readAuthSessionWithUser(token: any) {
      return thenIfPromise(
        this.prepare(
          sql(
            "SELECT [s].[token], [s].[expiresAt], [u].[id] AS [userId], [u].[displayName], [u].[email], [u].[picture], " +
            "[u].[isAuthenticated], [u].[isGuest], [s].[provider] AS [provider] " +
            "FROM [sporades_auth_sessions] [s] " +
            "JOIN [sporades_auth_users] [u] ON [u].[id] = [s].[userId] " +
            "WHERE [s].[token] = ?",
          ),
        ).get(token),
        (row: any) => (isReservedAuthUserId(row?.userId) ? null : row ?? null),
      );
    },
    insertOAuthState(row: LooseRecord) {
      const provider = row.provider ?? "google";
      const expiresAt = row.expiresAt ?? new Date(Date.parse(row.createdAt) + 10 * 60 * 1000).toISOString();
      return this.prepare(
        sql(
          "INSERT INTO [sporades_auth_oauth_states] " +
          "([state], [provider], [sessionToken], [returnTo], [redirectUri], [createdAt], [expiresAt], [nonce], [pkceVerifier]) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ),
      ).run(row.state, provider, row.sessionToken, row.returnTo, row.redirectUri, row.createdAt, expiresAt, row.nonce ?? null, row.pkceVerifier ?? null);
    },
    // One statement, not a SELECT followed by a DELETE. The two-statement form was correct on
    // SQLite and a race everywhere else: nothing ordered the delete after the read, so on an
    // asynchronous engine the two were in flight together. Both service engines carried their own
    // `DELETE ... RETURNING` copy for exactly that reason, and node:sqlite speaks RETURNING too, so
    // there is one definition and no ordering left to get wrong.
    consumeOAuthState(state: any) {
      return thenIfPromise(
        this.prepare(
          sql(
            "DELETE FROM [sporades_auth_oauth_states] WHERE [state] = ? " +
            "RETURNING [state], [provider], [sessionToken], [returnTo], [redirectUri], [createdAt], [expiresAt], " +
            "[nonce], [pkceVerifier]",
          ),
        ).get(state),
        (row: any) => row ?? null,
      );
    },
    emailCredentialExists(email: any) {
      return thenIfPromise(
        this.prepare(sql("SELECT [email] FROM [sporades_auth_email_credentials] WHERE [email] = ?")).get(email),
        (row: any) => Boolean(row),
      );
    },
    insertEmailCredential(row: { email: any; userId: any; passwordHash: any; passwordSalt: any; createdAt: any; }) {
      assertNotReservedAuthUserId(row.userId);
      return this.prepare(
        sql(
          "INSERT INTO [sporades_auth_email_credentials] ([email], [userId], [passwordHash], [passwordSalt], [createdAt]) " +
          "VALUES (?, ?, ?, ?, ?)",
        ),
      ).run(row.email, row.userId, row.passwordHash, row.passwordSalt, row.createdAt);
    },
    updateEmailCredentialPassword(email: any, passwordHash: any, passwordSalt: any) {
      return this.prepare(
        sql("UPDATE [sporades_auth_email_credentials] SET [passwordHash] = ?, [passwordSalt] = ? WHERE [email] = ?"),
      ).run(passwordHash, passwordSalt, email);
    },
    findEmailCredentialWithUser(email: any) {
      return thenIfPromise(
        this.prepare(
          sql(
            "SELECT [c].[email], [c].[userId], [c].[passwordHash], [c].[passwordSalt], [u].[displayName], [u].[picture], " +
            "[u].[isAuthenticated], [u].[isGuest] " +
            "FROM [sporades_auth_email_credentials] [c] " +
            "JOIN [sporades_auth_users] [u] ON [u].[id] = [c].[userId] " +
            "WHERE [c].[email] = ?",
          ),
        ).get(email),
        (row: any) => (isReservedAuthUserId(row?.userId) ? null : row ?? null),
      );
    },
    deleteAuthSessionsForUser(userId: any) {
      return this.prepare(sql("DELETE FROM [sporades_auth_sessions] WHERE [userId] = ?")).run(userId);
    },
    insertPasswordResetCode(row: LooseRecord) {
      assertNotReservedAuthUserId(row.userId);
      return this.prepare(
        sql(
          "INSERT INTO [sporades_auth_password_reset_codes] " +
          "([selector], [verifierHash], [email], [userId], [createdAt], [expiresAt]) VALUES (?, ?, ?, ?, ?, ?)",
        ),
      ).run(row.selector, row.verifierHash, row.email, row.userId, row.createdAt, row.expiresAt);
    },
    findPasswordResetCode(selector: any) {
      return this.prepare(
        sql(
          "SELECT [selector], [verifierHash], [email], [userId], [createdAt], [expiresAt] " +
          "FROM [sporades_auth_password_reset_codes] WHERE [selector] = ?",
        ),
      ).get(selector) ?? null;
    },
    deletePasswordResetCode(selector: any) {
      return this.prepare(sql("DELETE FROM [sporades_auth_password_reset_codes] WHERE [selector] = ?")).run(selector);
    },
    countPasswordResetCodesForEmail(email: any, now: any) {
      return thenIfPromise(
        this.prepare(
          sql(
            "SELECT COUNT(*) AS [count] FROM [sporades_auth_password_reset_codes] " +
            "WHERE [email] = ? AND [expiresAt] > ?",
          ),
        ).get(email, now),
        (row: any) => Number(row?.count ?? 0),
      );
    },
    deletePasswordResetCodesForUser(userId: any) {
      return this.prepare(sql("DELETE FROM [sporades_auth_password_reset_codes] WHERE [userId] = ?")).run(userId);
    },
    prunePasswordResetCodes(now: any) {
      return this.prepare(sql("DELETE FROM [sporades_auth_password_reset_codes] WHERE [expiresAt] <= ?")).run(now);
    },
    // ADR-0026: a schema migration is a multi-write workflow that has to succeed or fail as one
    // unit, so it runs inside the adapter's own transaction primitive rather than emitting BEGIN
    // and COMMIT itself. Doing it with bare statements only worked on a synchronous engine: an
    // unawaited `exec("BEGIN")` leaves the enclosing `try`/`catch` unable to see an asynchronous
    // rejection, and the COMMIT fires before the migration it is meant to enclose has finished.
    migrateAppSchema(schema: LooseRecord) {
      return this.withTransaction((transaction: LooseRecord) => migrateAppSchemaInTransaction(transaction, schema));
    },
    createAppTable(table: { name: any; }, tableName = table.name) {
      return createAppTable(this, table, tableName);
    },
    migrateExistingAppTable(existingTable: any, nextTable: any) {
      return this.withTransaction((transaction: LooseRecord) =>
        migrateExistingAppTableInTransaction(transaction, existingTable, nextTable),
      );
    },
    referenceExists(field: { targetTable: any; }, value: any) {
      return thenIfPromise(
        this.prepare(
          `SELECT 1 FROM ${dialect.quoteIdentifier(field.targetTable)} WHERE ${dialect.quoteIdentifier("id")} = ? LIMIT 1`,
        ).get(String(value)),
        (row: any) => Boolean(row),
      );
    },
    insertAppRow(table: { name: any; }, row: { [x: string]: any; }) {
      const columns = Object.keys(row);
      return this.prepare(
        `INSERT INTO ${dialect.quoteIdentifier(table.name)} (${columns
          .map((column) => dialect.quoteIdentifier(column))
          .join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      ).run(...columns.map((column) => row[column]));
    },
    insertAppRowOrIgnore(table: { name: any; }, row: { [x: string]: any; }, conflictFields: readonly string[]) {
      const columns = Object.keys(row);
      return this.prepare(
        `INSERT INTO ${dialect.quoteIdentifier(table.name)} (${columns
          .map((column) => dialect.quoteIdentifier(column))
          .join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ` +
        `ON CONFLICT (${conflictFields.map((field) => dialect.quoteIdentifier(field)).join(", ")}) DO NOTHING`,
      ).run(...columns.map((column) => row[column]));
    },
    selectAppRowById(table: { name: any; }, id: any) {
      return (
        this.prepare(
          `SELECT * FROM ${dialect.quoteIdentifier(table.name)} WHERE ${dialect.quoteIdentifier("id")} = ?`,
        ).get(String(id)) ?? null
      );
    },
    updateAppRow(table: { name: any; }, id: any, values: { [x: string]: any; }, options: LooseRecord = {}) {
      const columns = Object.keys(values);
      if (columns.length === 0) {
        return { changes: 0 };
      }
      // The owner-scope predicate is quoted like every other identifier here. Emitted bare it
      // folded to `ownerid` on Postgres against a column `appFieldColumnDefinition` had created as
      // `"ownerId"`, so every owner-scoped update on an app table — the tables Capsule code reaches
      // through `ctx.db` — failed outright with `column "ownerid" does not exist`.
      return this.prepare(
        `UPDATE ${dialect.quoteIdentifier(table.name)} SET ${columns.map((column) => `${dialect.quoteIdentifier(column)} = ?`).join(", ")} ` +
        `WHERE ${dialect.quoteIdentifier("id")} = ?` +
        (options.ownerId === undefined ? "" : ` AND ${dialect.quoteIdentifier("ownerId")} = ?`),
      ).run(
        ...columns.map((column) => values[column]),
        String(id),
        ...(options.ownerId === undefined ? [] : [options.ownerId]),
      );
    },
    deleteAppRow(table: { name: any; }, id: any) {
      return this.prepare(
        `DELETE FROM ${dialect.quoteIdentifier(table.name)} WHERE ${dialect.quoteIdentifier("id")} = ?`,
      ).run(String(id));
    },
    selectAppRows(table: { name: any; }, query: LooseRecord = {}) {
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
        ? ` ORDER BY ${dialect.quoteIdentifier(query.orderBy.fieldName)} ${String(query.orderBy.direction).toLowerCase() === "desc" ? "DESC" : "ASC"
        }`
        : "";
      const limit = Number.isInteger(query.limit) && query.limit >= 0 ? query.limit : null;
      const limitSql = limit === null ? "" : " LIMIT ?";
      return this.prepare(
        `SELECT ${columns.map((column: string) => (column === "*" ? "*" : dialect.quoteIdentifier(column))).join(", ")} FROM ${dialect.quoteIdentifier(
          table.name,
        )}${whereSql}${orderSql}${limitSql}`,
      ).all(...(limit === null ? params : [...params, limit]));
    },
    // The three inspection methods below each derive from a statement result, so each resolves it
    // first (ADR-0034). They previously read `.all()` and `.columns()` unresolved and were correct
    // on the asynchronous engines only because each engine shadowed them with an await-shim.
    listInspectableTables() {
      return thenIfPromise(
        dialect.listTables(this),
        (rows: any[]) =>
          rows
            .map((row: any) => row.name)
            .filter(
              (name: any) =>
                name !== "sporades_log_events" && name !== "sporades_schedules" && name !== "sporades_schedule_occurrences",
            ),
      );
    },
    dumpInspectableDatabase() {
      const dumpTable = (tableName: any) =>
        thenIfPromise(dialect.describeColumns(this, tableName), (columnRows: any[]) =>
          thenIfPromise(this.prepare(`SELECT * FROM ${dialect.quoteIdentifier(tableName)}`).all(), (rows: any) => ({
            name: tableName,
            columns: columnRows.map((column: any) => column.name),
            rows,
          })),
        );
      // Tables are dumped one after another rather than concurrently, so an asynchronous engine
      // issues the same statement sequence a synchronous one does.
      return thenIfPromise(this.listInspectableTables(), (tableNames: any[]) =>
        tableNames.reduce(
          (pending: any, tableName: any) =>
            thenIfPromise(pending, (tables: any[]) => thenIfPromise(dumpTable(tableName), (table: any) => [...tables, table])),
          [] as any[],
        ),
      );
    },
    runReadOnlyInspectionQuery(sql: string | undefined) {
      const inspectionQueryFailure = (error: any) => ({
        ok: false,
        data: null as any,
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
        const result = thenIfPromise(statement.columns(), (columnMetadata: any[]) =>
          thenIfPromise(statement.all(), (allRows: any[]) => ({
            ok: true,
            data: {
              columns: columnMetadata.map((column: any) => column.name),
              rows: allRows.filter((row: any) => !isInternalLogIndexMetadataRow(row, sql)),
            },
            error: null as any,
          })),
        );
        // A rejected statement is the asynchronous form of the throw the `catch` below handles, so
        // it has to reach the same failure result rather than escape as an unhandled rejection.
        return isPromiseLike(result) ? result.then((value: any) => value, inspectionQueryFailure) : result;
      } catch (error: any) {
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
        const probe: any = this.prepare(sql("SELECT 1 AS [ok]")).get();
        return isPromiseLike(probe) ? probe.then(() => ({ ok: true }), () => ({ ok: false })) : { ok: true };
      } catch {
        return { ok: false };
      }
    },
  };
}

export async function createSqliteDatabaseAdapter(databasePath: PathLike, options: LooseRecord = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await import("node:path");
  if (!options.readOnly) nodeFsModule.mkdirSync(path.dirname(String(databasePath)), { recursive: true });
  const connection = new DatabaseSync(databasePath, { readOnly: Boolean(options.readOnly) });
  const dialect = sqliteDatabaseDialect();
  const connectionGate = createConnectionTransactionGate();
  const runDirectly = (operation: () => any) => operation();

  const createOperations = (run: (operation: () => any) => any) => ({
    exec(sql: string) {
      return run(() => connection.exec(sql));
    },
    prepare(sql: string) {
      return {
        all(...params: any[]) {
          return run(() => connection.prepare(sql).all(...params));
        },
        get(...params: any[]) {
          return run(() => connection.prepare(sql).get(...params));
        },
        run(...params: string[]) {
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
  const adapter: LooseRecord = {
    ...createSharedDatabaseAdapterMethods(dialect),
    ...createOperations(connectionGate.runOperation),
    engine: "sqlite",
    dialect,
    normalization: sqliteRowNormalization(),
    async withTransaction(fn: (transactionAdapter: LooseRecord) => any) {
      return await connectionGate.runTransaction(async () => {
        const ownerOperations: LooseRecord = typeof (this as any)[transactionOperations] === "function"
          ? (this as any)[transactionOperations]()
          : { exec: this.exec.bind(this), prepare: this.prepare.bind(this) };
        const transactionAdapter = createTransactionScopedAdapter(this, ownerOperations, this, "transaction");
        const transactionExec = ownerOperations.exec;
        await transactionExec("BEGIN");
        try {
          let result;
          try {
            result = await fn(transactionAdapter);
            await runTransactionBeforeCommitChecks(transactionAdapter);
          }
          finally { revokeTransactionScopedAdapter(transactionAdapter); }
          await transactionExec("COMMIT");
          return result;
        } catch (error) {
          await transactionExec("ROLLBACK");
          throw error;
        }
      });
    },
    async withReadOnlySnapshot(fn: (transactionAdapter: LooseRecord) => any) {
      return await connectionGate.runTransaction(async () => {
        const ownerOperations: LooseRecord = typeof (this as any)[transactionOperations] === "function"
          ? (this as any)[transactionOperations]()
          : { exec: this.exec.bind(this), prepare: this.prepare.bind(this) };
        const ownerAdapter = createTransactionScopedAdapter(this, ownerOperations, this, "snapshot");
        const transactionExec = ownerOperations.exec;
        await transactionExec("BEGIN"); await transactionExec("PRAGMA query_only = ON");
        try { let result; try { result = await fn(ownerAdapter); } finally { revokeTransactionScopedAdapter(ownerAdapter); } await transactionExec("COMMIT"); return result; }
        catch (error) { await transactionExec("ROLLBACK"); throw error; }
        finally { if (!options.readOnly) await transactionExec("PRAGMA query_only = OFF"); }
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

export async function createPostgresDatabaseAdapter(options: { url: any; }) {
  const url = typeof options === "string" ? options : options?.url;
  if (!url) {
    throw commandError(
      "Missing Postgres database service URL.",
      "Start a Dev session or local Container session with services.database.engine set to postgres.",
    );
  }

  const client = await createPostgresConnection(url);
  const connectionGate = createConnectionTransactionGate();
  const runDirectly = (operation: () => any) => operation();
  let closed = false;
  const dialect = postgresDatabaseDialect();
  const normalization = postgresRowNormalization();

  const assertOpen = () => {
    if (closed) {
      throw new Error("database is not open");
    }
  };

  const rawQuery = async (sql: string, params: any[] = []) => {
    assertOpen();
    return await client.query(postgresInterpolate(sql, params));
  };

  const createOperations = (run: (operation: () => any) => any) => ({
    exec(sql: string) {
      return run(() => rawQuery(sql).then((): undefined => undefined));
    },
    prepare(sql: string) {
      assertOpen();
      return {
        all(...params: (number | undefined)[]) {
          return run(() => rawQuery(sql, params).then((result: any) => postgresRowsFromResult(normalization, result)));
        },
        get(...params: undefined[]) {
          return this.all(...params).then((rows: any[]) => rows[0] ?? null);
        },
        run(...params: string[]) {
          return run(() => rawQuery(sql, params).then((result) => ({
            changes: Number(result.rowCount ?? 0),
            lastInsertRowid: undefined as any,
          })));
        },
        columns() {
          return run(() => rawQuery(
            `SELECT * FROM (${sqlWithoutTrailingTerminator(sql)}) AS __sporades_columns LIMIT 0`,
          ).then((result) => result.fields.map((field) => ({ name: normalization.columnName(field.name) }))));
        },
      };
    },
  });

  const adapter: LooseRecord = {
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
    async withTransaction(fn: (transactionAdapter: LooseRecord) => any) {
      return await connectionGate.runTransaction(async () => {
        await rawQuery("BEGIN");
        try {
          const transactionAdapter = createTransactionScopedAdapter(adapter, createOperations(runDirectly), adapter, "transaction");
          let result;
          try {
            result = await fn(transactionAdapter);
            await runTransactionBeforeCommitChecks(transactionAdapter);
          }
          finally { revokeTransactionScopedAdapter(transactionAdapter); }
          await rawQuery("COMMIT");
          return result;
        } catch (error) {
          try {
            await rawQuery("ROLLBACK");
          } catch { }
          throw error;
        }
      });
    },
    async withReadOnlySnapshot(fn: (adapter: LooseRecord) => any) {
      return await connectionGate.runTransaction(async () => {
        const transactionAdapter = createTransactionScopedAdapter(adapter, createOperations(runDirectly), adapter, "snapshot");
        await rawQuery("BEGIN TRANSACTION READ ONLY");
        try { let result; try { result = await fn(transactionAdapter); } finally { revokeTransactionScopedAdapter(transactionAdapter); } await rawQuery("COMMIT"); return result; }
        catch (error) { try { await rawQuery("ROLLBACK"); } catch {} throw error; }
      });
    },
    async close() {
      closed = true;
      await client.close();
    },
  };

  return adapter;
}

export async function createPostgresConnection(url: any) {
  const net = await import("node:net");
  const crypto = await import("node:crypto");
  const options = postgresUrlOptions(url);
  const socket = net.createConnection({ host: options.host, port: options.port });
  socket.setNoDelay(true);

  let buffer = Buffer.alloc(0);
  let ready = false;
  let closed = false;
  let backendKeyData = null;
  let queryQueue: Promise<any> = Promise.resolve();
  const waiters: any[] = [];

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
          throw commandError(
            "Unsupported Postgres SASL mechanism.",
            "Use the Sporades-managed Postgres Capsule service, which authenticates with SCRAM-SHA-256.",
          );
        }
        scram = createPostgresScramSession(crypto, options.password);
        const clientFirst = Buffer.from(scram.clientFirstMessage, "utf8");
        socket.write(
          postgresPasswordMessage(
            Buffer.concat([Buffer.from("SCRAM-SHA-256\0", "utf8"), postgresInt32(clientFirst.length), clientFirst]),
          ),
        );
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
      throw commandError(
        "Unsupported Postgres authentication method.",
        "Use the Sporades-managed Postgres Capsule service with the generated Capsule service credentials.",
      );
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
    query(sql: string) {
      if (closed) {
        throw new Error("database is not open");
      }
      const pending = queryQueue.then(
        () => executePostgresQuery(sql),
        () => executePostgresQuery(sql),
      );
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

  async function executePostgresQuery(sql: any) {
    if (closed) {
      throw new Error("database is not open");
    }
    socket.write(postgresQueryMessage(sql));
    const fields: any[] = [];
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

function postgresUrlOptions(url: any) {
  const parsed = new URL(String(url));
  return {
    host: parsed.hostname || "127.0.0.1",
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username || "sporades"),
    password: decodeURIComponent(parsed.password || ""),
    database: decodeURIComponent(parsed.pathname.replace(/^\/+/, "") || "sporades"),
  };
}

function postgresPasswordMessage(body: string | Uint8Array | Buffer) {
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.concat([Buffer.from("p"), postgresInt32(bodyBuffer.length + 4), bodyBuffer]);
}

function createPostgresScramSession(crypto: typeof import("node:crypto"), password: string) {
  const clientNonce = crypto.randomBytes(18).toString("base64");
  const clientFirstBare = `n=,r=${clientNonce}`;
  let serverSignature: string | null = null;
  return {
    clientFirstMessage: `n,,${clientFirstBare}`,
    continue(serverFirstMessage: string) {
      const attributes = new Map(serverFirstMessage.split(",").map((part: string) => [part.slice(0, 1), part.slice(2)]));
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
      const clientProof = Buffer.from(clientKey.map((byte: number, index: number) => byte ^ clientSignature[index]));
      const serverKey = crypto.createHmac("sha256", saltedPassword).update("Server Key").digest();
      serverSignature = crypto.createHmac("sha256", serverKey).update(authMessage).digest("base64");
      return `${clientFinalWithoutProof},p=${clientProof.toString("base64")}`;
    },
    verify(serverFinalMessage: string) {
      if (serverFinalMessage !== `v=${serverSignature}`) {
        throw new Error("Postgres SCRAM server signature verification failed.");
      }
    },
  };
}

function postgresStartupMessage(options: { host?: string; port?: number; user: any; password?: string; database: any; }) {
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

function postgresQueryMessage(sql: any) {
  const body = Buffer.from(`${sql}\0`, "utf8");
  return Buffer.concat([Buffer.from("Q"), postgresInt32(body.length + 4), body]);
}

function postgresInt32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}

function waitForPostgresData(waiters: any[]) {
  return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
}

function wakePostgresWaiters(waiters: any[]) {
  for (const waiter of waiters.splice(0)) {
    waiter.resolve();
  }
}

function postgresParseRowDescription(body: Buffer<ArrayBuffer>) {
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

function postgresParseDataRow(body: Buffer<ArrayBuffer>, fields: any[]) {
  const row: LooseRecord = {};
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

function postgresValueFromText(value: string, dataTypeID: number) {
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

function postgresRowCountFromCommand(tag: string) {
  const match = tag.match(/\s(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function postgresErrorFromBody(body: Buffer) {
  const fields: LooseRecord = {};
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const type = String.fromCharCode(body[offset]);
    offset += 1;
    const end = body.indexOf(0, offset);
    fields[type] = body.subarray(offset, end).toString("utf8");
    offset = end + 1;
  }
  const error: Error & { code?: string; constraint?: string } = new Error(fields.M ?? "Postgres query failed.");
  // SQLSTATE and constraint name are operational metadata: callers use them
  // only to retry a known idempotent race, never as a browser-facing error.
  if (fields.C) error.code = fields.C;
  if (fields.n) error.constraint = fields.n;
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
export function postgresInterpolate(sql: any, params: any[] = []) {
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

function postgresRowsFromResult(normalization: LooseRecord, result: { fields?: any[]; rows: any; rowCount?: number; }) {
  return result.rows.map((row: LooseRecord) => normalization.row(row));
}

export async function createLibsqlDatabaseAdapter(options: { url: any; authToken: any; }) {
  const url = typeof options === "string" ? options : options?.url;
  if (!url) {
    throw commandError(
      "Missing libSQL database service URL.",
      "Start a Dev session or local Container session with services.database.engine set to libsql.",
    );
  }

  const endpoint = libsqlPipelineUrl(url);
  const authToken = typeof options === "object" ? options.authToken : null;
  let closed = false;
  const activeTransactions = new Set<any>();
  const connectionGate = createConnectionTransactionGate();
  const runDirectly = (operation: () => any) => operation();

  // libSQL speaks SQLite's SQL, so it takes SQLite's dialect. That is a statement about the two
  // engines rather than a borrowing: the dialect is a value both adapters ask for, not an adapter
  // one of them builds and strips for parts.
  const dialect = sqliteDatabaseDialect();
  // Normalization is libSQL's own, though: the pipeline protocol tags every value with its type,
  // where node:sqlite hands back JavaScript directly.
  const normalization = libsqlRowNormalization();

  const createOperations = (transaction: any = null, run: (operation: () => any) => any = runDirectly) => ({
    exec(sql: string) {
      assertLibsqlOpen(closed);
      const request = libsqlHasMultipleStatements(sql)
        ? { type: "sequence", sql }
        : { type: "execute", stmt: { sql } };
      return run(() => {
        assertLibsqlOpen(closed);
        return libsqlPipeline({ endpoint, authToken, transaction, requests: [request], close: !transaction }).then((): undefined => undefined);
      });
    },
    prepare(sql: string) {
      assertLibsqlOpen(closed);
      return {
        all(...params: (number | undefined)[]) {
          return run(() => {
            assertLibsqlOpen(closed);
            return libsqlExecute({ endpoint, authToken, transaction, sql, params, close: !transaction }).then((result) =>
              libsqlRowsFromResult(normalization, result),
            );
          });
        },
        get(...params: undefined[]) {
          return this.all(...params).then((rows: any[]) => rows[0] ?? null);
        },
        run(...params: string[]) {
          return run(() => {
            assertLibsqlOpen(closed);
            return libsqlExecute({ endpoint, authToken, transaction, sql, params, close: !transaction }).then((result) => ({
              changes: Number(result.affected_row_count ?? result.affectedRowCount ?? 0),
              lastInsertRowid:
                result.last_insert_rowid === null || result.last_insert_rowid === undefined
                  ? undefined
                  : BigInt(result.last_insert_rowid),
            }));
          });
        },
        columns() {
          return run(() => {
            assertLibsqlOpen(closed);
            return libsqlDescribe({ endpoint, authToken, transaction, sql, close: !transaction });
          });
        },
      };
    },
  });

  const adapter = {
    ...createSharedDatabaseAdapterMethods(dialect),
    ...createOperations(null, connectionGate.runOperation),
    engine: "libsql",
    dialect,
    normalization,
    // No behavioural method body lives here either, for the reasons ADR-0037 records and the
    // Postgres adapter states above. Six used to: the two storage bootstraps, the OAuth state
    // consume, and three await-shims over Log index methods that ADR-0036 corrected in the shared
    // body instead.
    async withTransaction(fn: (transactionAdapter: LooseRecord) => any) {
      assertLibsqlOpen(closed);
      return await connectionGate.runTransaction(async () => {
        assertLibsqlOpen(closed);
        const transaction = { baton: null as any, baseUrl: endpoint };
        const transactionAdapter = createTransactionScopedAdapter({
          ...adapter,
          ...createOperations(transaction, runDirectly),
        }, {}, adapter, "transaction");
        activeTransactions.add(transaction);
        try {
          await libsqlExecute({ endpoint, authToken, transaction, sql: "BEGIN", params: [], close: false });
          let result;
          try {
            result = await fn(transactionAdapter);
            await runTransactionBeforeCommitChecks(transactionAdapter);
          }
          finally { revokeTransactionScopedAdapter(transactionAdapter); }
          await libsqlExecute({ endpoint, authToken, transaction, sql: "COMMIT", params: [], close: true });
          return result;
        } catch (error) {
          try {
            await libsqlExecute({ endpoint, authToken, transaction, sql: "ROLLBACK", params: [], close: true });
          } catch { }
          throw error;
        } finally {
          activeTransactions.delete(transaction);
        }
      });
    },
    async withReadOnlySnapshot(fn: (adapter: LooseRecord) => any) {
      assertLibsqlOpen(closed);
      return await connectionGate.runTransaction(async () => {
        assertLibsqlOpen(closed);
        const transaction = { baton: null as any, baseUrl: endpoint };
        const snapshotAdapter = createTransactionScopedAdapter({ ...adapter, ...createOperations(transaction, runDirectly) }, {}, adapter, "snapshot");
        activeTransactions.add(transaction);
        try {
          await libsqlExecute({ endpoint, authToken, transaction, sql: "BEGIN", params: [], close: false });
          await libsqlExecute({ endpoint, authToken, transaction, sql: "PRAGMA query_only = ON", params: [], close: false });
          let result;
          try { result = await fn(snapshotAdapter); }
          finally { revokeTransactionScopedAdapter(snapshotAdapter); }
          await libsqlExecute({ endpoint, authToken, transaction, sql: "COMMIT", params: [], close: false });
          await libsqlExecute({ endpoint, authToken, transaction, sql: "PRAGMA query_only = OFF", params: [], close: true });
          return result;
        } catch (error) {
          try { await libsqlExecute({ endpoint, authToken, transaction, sql: "ROLLBACK", params: [], close: false }); } catch {}
          try { await libsqlExecute({ endpoint, authToken, transaction, sql: "PRAGMA query_only = OFF", params: [], close: true }); } catch {}
          throw error;
        }
        finally { activeTransactions.delete(transaction); }
      });
    },
    async close() {
      if (closed) {
        await connectionGate.whenIdle();
        return;
      }
      closed = true;
      for (const transaction of activeTransactions as Set<any>) {
        if (transaction.baton) {
          await libsqlPipeline({ endpoint, authToken, transaction, requests: [], close: true }).catch(() => { });
        }
      }
      await connectionGate.whenIdle();
      activeTransactions.clear();
    },
  };

  return adapter;
}

function libsqlPipelineUrl(url: any) {
  const parsed = new URL(String(url));
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/v2/pipeline`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function assertLibsqlOpen(closed: boolean) {
  if (closed) {
    throw new Error("database is not open");
  }
}

function libsqlHasMultipleStatements(sql: any) {
  return splitSqlStatements(sql).length > 1;
}

async function libsqlExecute({ endpoint, authToken, transaction, sql, params = [], close }: LooseRecord) {
  const [result] = await libsqlPipeline({
    endpoint,
    authToken,
    transaction,
    requests: [{ type: "execute", stmt: { sql, args: params.map(libsqlValueFromJs) } }],
    close,
  });
  return result.result;
}

async function libsqlDescribe({ endpoint, authToken, transaction, sql, close }: LooseRecord) {
  const [result] = await libsqlPipeline({
    endpoint,
    authToken,
    transaction,
    requests: [{ type: "describe", sql }],
    close,
  });
  return (result.result?.cols ?? []).map((column: { name: any; }) => ({ name: column.name }));
}

async function libsqlPipeline({ endpoint, authToken, transaction = null, requests, close = true }: LooseRecord) {
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
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `libSQL request failed with HTTP ${response.status}.`);
  }
  if (transaction) {
    transaction.baton = body.baton ?? null;
    transaction.baseUrl = body.base_url ? new URL("/v2/pipeline", body.base_url).toString() : requestUrl;
  }
  const results = body.results ?? [];
  const errorResult = results.find((result: { type: string; }) => result.type === "error");
  if (errorResult) {
    throw new Error(errorResult.error?.message ?? "libSQL statement failed.");
  }
  return results.filter((result: { response: { type: string; }; }) => result.response?.type !== "close").map((result: { response: any; }) => result.response);
}

function libsqlRowsFromResult(normalization: LooseRecord, result: { cols: any; rows: any; }) {
  const columns = (result.cols ?? []).map((column: { name: any; }) => column.name);
  return (result.rows ?? []).map((row: LooseRecord) =>
    normalization.row(Array.isArray(row) ? Object.fromEntries(columns.map((column: any, index: number) => [column, row[index]])) : row),
  );
}

function libsqlValueFromJs(value: unknown) {
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

function libsqlValueToJs(value: any) {
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
function migrateAppSchemaInTransaction(sqlite: LooseRecord, schema: LooseRecord) {
  const nextSchema = normalizeSchema(schema);
  const nextSchemaJson = JSON.stringify(nextSchema);
  const nextSchemaHash = hashSchema(nextSchemaJson);

  // ADR-0034: the recorded schema is read before anything is derived from it. On an asynchronous
  // engine `readSchemaMetadata()` answers a Promise, which is truthy even when there is no recorded
  // schema at all, so every branch below — whether a schema exists, whether it parses, whether it
  // changed, and whether the change is additive — has to be taken against the resolved row.
  return thenIfPromise(sqlite.readSchemaMetadata(), (existingSchemaRow: any) => {
    let existingSchema = null;
    let schemaChanged = false;

    if (existingSchemaRow) {
      try {
        existingSchema = JSON.parse(existingSchemaRow.value);
      } catch {
        throw commandError(
          "Invalid Sporades schema metadata.",
          "Delete the Runtime directory only if you can lose local data, then restart the Capsule.",
        );
      }

      const comparableExistingSchema = Array.isArray(existingSchema?.tables) ? normalizeSchema(existingSchema) : existingSchema;
      schemaChanged = hashSchema(JSON.stringify(comparableExistingSchema)) !== nextSchemaHash;
      if (schemaChanged) {
        assertAdditiveSchemaMigration(existingSchema, nextSchema);
      }
    }

    const existingTables = new Map((existingSchema?.tables ?? []).map((table: { name: any; }) => [table.name, table]));
    return chainMaybePromise([
      ...schema.tables.map((table: { name: unknown; }) => () => {
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
      () =>
        sqlite.writeSchemaMetadata({
          schemaVersion: "v1:additive-fields",
          schemaHash: nextSchemaHash,
          schemaJson: nextSchemaJson,
        }),
    ]);
  });
}

function normalizeSchema(schema: LooseRecord) {
  return {
    tables: schema.tables
      .map((table: { name: any; fields: any[]; uniqueConstraints?: string[][]; }) => ({
        name: table.name,
        fields: table.fields.map((field: { name: any; kind: any; sqliteType: any; targetTable: any; defaultValue: any; }) => ({
          name: field.name,
          kind: field.kind,
          sqliteType: field.sqliteType,
          targetTable: field.targetTable,
          defaultValue: field.defaultValue,
        })),
        uniqueConstraints: table.uniqueConstraints ?? [],
      }))
      .sort((left: { name: string; }, right: { name: any; }) => left.name.localeCompare(right.name)),
  };
}

function hashSchema(schemaJson: BinaryLike) {
  return nodeCryptoModule.createHash("sha256").update(schemaJson).digest("hex");
}

function assertAdditiveSchemaMigration(existingSchema: LooseRecord, nextSchema: LooseRecord) {
  const nextTables = new Map<any, any>(nextSchema.tables.map((table: { name: any; }) => [table.name, table]));

  for (const existingTable of existingSchema.tables ?? []) {
    const nextTable = nextTables.get(existingTable.name);
    if (!nextTable) {
      throw commandError(
        "Unsupported Capsule schema change.",
        "Only adding new tables or fields is supported right now. Revert table or field changes, or move data aside and recreate the Runtime directory.",
      );
    }

    const nextFields = new Map(nextTable.fields.map((field: { name: any; }) => [field.name, field]));
    for (const existingField of existingTable.fields ?? []) {
      const nextField = nextFields.get(existingField.name);
      if (!nextField || JSON.stringify(existingField) !== JSON.stringify(nextField)) {
        throw commandError(
          "Unsupported Capsule schema change.",
          "Only adding new tables or fields is supported right now. Revert table or field changes, or move data aside and recreate the Runtime directory.",
        );
      }
    }

    if (!uniqueConstraintsAreAdditive(existingTable.uniqueConstraints ?? [], nextTable.uniqueConstraints ?? [])) {
      throw commandError(
        "Unsupported Capsule schema change.",
        "Only adding new tables, fields, or unique constraints is supported right now. Revert changed constraints, or move data aside and recreate the Runtime directory.",
      );
    }
  }
}

function uniqueConstraintsAreAdditive(existingConstraints: string[][], nextConstraints: string[][]) {
  return existingConstraints.every((existing) =>
    nextConstraints.some((next) => JSON.stringify(next) === JSON.stringify(existing)),
  );
}

function hasAddedUniqueConstraints(existingConstraints: string[][], nextConstraints: string[][]) {
  return nextConstraints.some((next) =>
    !existingConstraints.some((existing) => JSON.stringify(existing) === JSON.stringify(next)),
  );
}

function translateUniqueConstraintMigrationError(error: any) {
  if (!isUniqueConstraintError(error)) {
    return error;
  }
  return commandError(
    "Unable to apply unique constraint migration.",
    "Remove or resolve duplicate data, then restart the Capsule.",
  );
}

function isUniqueConstraintError(error: any) {
  if (error?.code === "23505" || error?.errcode === 2067 || error?.code === "SQLITE_CONSTRAINT_UNIQUE") {
    return true;
  }
  const message = String(error?.message ?? "");
  return /\bUNIQUE constraint failed(?::|$)|\bduplicate key value violates unique constraint\b/i.test(message);
}

function translateUniqueConstraintCopyFailure(operation: () => any) {
  try {
    const result = operation();
    return isPromiseLike(result)
      ? result.catch((error: any) => {
        throw translateUniqueConstraintMigrationError(error);
      })
      : result;
  } catch (error) {
    throw translateUniqueConstraintMigrationError(error);
  }
}

// The one definition of an additive table rebuild, run inside a transaction the caller has already
// opened. SQLite cannot add a column to a table that carries a default without rewriting it, so the
// rebuild copies every row of the table into a temporary copy and renames it into place — which is
// precisely the work that must not be left half done, and precisely why its caller wraps it.
function migrateExistingAppTableInTransaction(sqlite: LooseRecord, existingTable: any, nextTable: LooseRecord) {
  // The dialect is reached through the adapter rather than passed alongside it, so a helper the
  // shared method set delegates to cannot end up emitting a different engine's SQL than the method
  // that called it.
  const dialect = sqlite.dialect;
  const addsUniqueConstraints = hasAddedUniqueConstraints(
    existingTable.uniqueConstraints ?? [],
    nextTable.uniqueConstraints ?? [],
  );
  const columns = ["id", "createdAt", "updatedAt", ...nextTable.fields.map((field: { name: any; }) => field.name)];
  return thenIfPromise(sqlite.listInspectableTables(), (tableNames: string[]) => {
    const occupiedNames = new Set(tableNames);
    let tempTableName: string;
    // Keep the whole identifier below PostgreSQL's 63-byte limit and include a
    // per-migration nonce so overlapping runtimes do not select the same name.
    // The live-schema probe closes the remaining collision case for valid app
    // tables whose names deliberately use the internal-looking prefix.
    do {
      tempTableName = `__sporades_migrating_${randomUUID().replaceAll("-", "")}`;
    } while (occupiedNames.has(tempTableName));
    return chainMaybePromise([
      ...addedFieldsForTable(existingTable, nextTable)
        .filter((field: { kind: string; defaultValue: null | undefined; }) => field.kind === "Reference" && field.defaultValue !== undefined && field.defaultValue !== null)
        .map((field: { defaultValue: any; }) => () =>
          thenIfPromise(sqlite.referenceExists(field, field.defaultValue), (exists: any) => {
            if (!exists) {
              throw invalidReferenceError(field);
            }
          }),
        ),
      () => sqlite.createAppTable(nextTable, tempTableName),
      () => {
        const copyRows = () => sqlite.exec(
          `INSERT INTO ${dialect.quoteIdentifier(tempTableName)} (${columns.map((column) => dialect.quoteIdentifier(column)).join(", ")}) ` +
          `SELECT ${columns.map((column) => columnSelectExpressionForMigration(dialect, existingTable, nextTable, column)).join(", ")} ` +
          `FROM ${dialect.quoteIdentifier(nextTable.name)}`,
        );
        return addsUniqueConstraints ? translateUniqueConstraintCopyFailure(copyRows) : copyRows();
      },
      () => sqlite.exec(`DROP TABLE ${dialect.quoteIdentifier(nextTable.name)}`),
      () => sqlite.exec(`ALTER TABLE ${dialect.quoteIdentifier(tempTableName)} RENAME TO ${dialect.quoteIdentifier(nextTable.name)}`),
    ]);
  });
}

function columnSelectExpressionForMigration(dialect: LooseRecord, existingTable: LooseRecord, nextTable: LooseRecord, columnName: string) {
  if (["id", "createdAt", "updatedAt"].includes(columnName)) {
    return dialect.quoteIdentifier(columnName);
  }
  if ((existingTable.fields ?? []).some((field: { name: any; }) => field.name === columnName)) {
    return dialect.quoteIdentifier(columnName);
  }
  const field = nextTable.fields.find((candidate: { name: any; }) => candidate.name === columnName);
  return field?.defaultValue === undefined ? "NULL" : toSqlLiteral(field.defaultValue, field);
}

function addedFieldsForTable(existingTable: LooseRecord, nextTable: LooseRecord) {
  const existingFields = new Set((existingTable.fields ?? []).map((field: { name: any; }) => field.name));
  return (nextTable.fields ?? []).filter((field: { name: unknown; }) => !existingFields.has(field.name));
}

export function createAppTable(sqlite: LooseRecord, table: LooseRecord, tableName = table.name) {
  return sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${sqlite.dialect.quoteIdentifier(tableName)} (` +
    appTableColumnDefinitions(sqlite.dialect, table).join(", ") +
    ")",
  );
}

// `id`, `createdAt` and `updatedAt` are quoted like every other column. Postgres folds an unquoted
// identifier to lower case, and its adapter used to carry a whole copy of `createAppTable` for no
// other reason; on SQLite and libSQL, which fold nothing, quoting a name that needed no quoting
// declares exactly the same column. One definition, and the difference the engines actually have is
// answered by the dialect entry rather than by a second method body.
function appTableColumnDefinitions(dialect: LooseRecord, table: LooseRecord) {
  return [
    `${dialect.quoteIdentifier("id")} TEXT PRIMARY KEY`,
    `${dialect.quoteIdentifier("createdAt")} TEXT NOT NULL`,
    `${dialect.quoteIdentifier("updatedAt")} TEXT NOT NULL`,
    ...table.fields.map((field: any) => appFieldColumnDefinition(dialect, field)),
    ...(table.uniqueConstraints ?? []).map((fields: string[]) =>
      `UNIQUE (${fields.map((field) => dialect.quoteIdentifier(field)).join(", ")})`,
    ),
  ];
}

function appFieldColumnDefinition(dialect: LooseRecord, field: LooseRecord) {
  const defaultSql = fieldColumnDefaultSql(field);
  const notNullSql = field.defaultValue !== undefined && !fieldDefaultIsSqlNull(field) ? " NOT NULL" : "";
  return `${dialect.quoteIdentifier(field.name)} ${dialect.columnType(field)}${notNullSql}${defaultSql}`;
}

function fieldDefaultIsSqlNull(field: LooseRecord) {
  return field.defaultValue === null && field.kind !== "Json";
}

function fieldColumnDefaultSql(field: LooseRecord) {
  return field.defaultValue === undefined ? "" : ` DEFAULT ${toSqlLiteral(field.defaultValue, field)}`;
}

function isDuplicateColumnError(error: any) {
  const text = [error?.message, error?.stdout, error?.stderr, error].map((value) => String(value ?? "")).join("\n");
  return /duplicate column|already exists/i.test(text);
}

function runSchemaExecIgnoringDuplicateColumn(sqlite: LooseRecord, sql: string) {
  try {
    const result = sqlite.exec(sql);
    if (isPromiseLike(result)) {
      return result.catch((error: any) => {
        if (!isDuplicateColumnError(error)) throw error;
      });
    }
    return result;
  } catch (error: any) {
    if (!isDuplicateColumnError(error)) throw error;
    return undefined;
  }
}

function toSqlLiteral(value: any, field: any = null) {
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

export async function listDatabaseTables(database: { adapter: any; sqlite: any; }) {
  return await (database.adapter ?? database.adapter).listInspectableTables();
}

export async function dumpDatabase(database: { adapter: any; sqlite: any; }) {
  return await (database.adapter ?? database.adapter).dumpInspectableDatabase();
}

export async function runReadOnlyQuery(database: { adapter: any; sqlite: any; }, sql: any) {
  return await (database.adapter ?? database.adapter).runReadOnlyInspectionQuery(sql);
}

export function splitSqlStatements(sql: any) {
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

export function quoteIdentifier(identifier: any) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}
