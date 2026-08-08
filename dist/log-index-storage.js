// The Log index's storage: the `sporades_log_events` table, its additive migration, the runtime
// sequence that orders it (ADR-0036), and the three statements that write, prune and read it.
//
// **This is not the platform log, and the line between them is the Database adapter.** The log sink
// and the log envelope — `createRuntimeLogSink`, `createRuntimeLogger`, `createLogEnvelope`, the
// redactor and the size cap — are still in `server-runtime-source.ts`, and they reach this file
// through nothing at all. They call `database.insertLogIndexEvent(…)`, `database.pruneLogIndex(…)`
// and `database.readRecentLogEvents(…)`: adapter methods, on the adapter object, resolved at run
// time. Everything above that seam decides *what* a log event says; everything here is *how a row
// of it is stored*, which is why it travels with the engines rather than with the sink.
//
// **Why it is its own module rather than part of `database-runtime.ts`.** Four of these nine are
// the shared adapter method set's own bodies — `insertLogIndexEvent`, `pruneLogIndex` and
// `readRecentLogEvents` carry ADR-0034 comments naming the await-shims the service engines used to
// hold, and `createLogIndexTables` is the `ensureLogStorage()` delegate. That is the same shape as
// `createFileStorageTables`, `createUserPreferencesTables` and `createAnonymousAuthTables`, and all
// three of those live in the module that owns the tables rather than in the adapter that calls
// them. This is the fourth, and it had no module to go home to, so batch 9 made one.
//
// The alternative — folding it into `database-runtime.ts` — would have put ADR-0036's whole subject
// inside a file about engines, dialects and wire protocols, and left the log index's ordering rule
// with no address of its own. `log-index-guard.ts` is the sibling that conceals this table from
// `sporades db query`; between them the two files are the whole of what the runtime does about the
// Log index, and neither is the other's business. ADR-0038 draws that same gate/guard line for the
// inspection validator.
//
// **This is a domain ticket 04's nine batches did not name**, and batch 9 is the last of them, so
// it is worth saying plainly rather than leaving in a commit message: the sequence's batch 1 was the
// log-index *guard*, four functions that conceal this table, and no batch was ever scoped to the
// index itself. It surfaced as a blocker of the last batch rather than as a batch of its own, and
// it is extracted here on the rule batch 6 established for `maybe-promise.ts` — a blocker that
// belongs to no batch on the list is not a later batch's and never will be, and extracting it is
// cheaper than cutting a domain in half. Left behind, these nine would have held
// `createSharedDatabaseAdapterMethods`, and with it every engine, every dialect and the whole of
// batch 9.
//
// **Why `randomUUID` comes from the Web Crypto global.** ADR-0042 ranks a global that already
// provides what is needed above `process.getBuiltinModule`, and this module needs `randomUUID` and
// nothing else from `node:crypto` — the case that ADR names as the one where the ranking still
// matters, because binding the namespace for one call reaches for a heavier route than the work
// requires. The mail domain does the same. `insertLogIndexEvent` is the one call site.
//
// **Nothing is redesigned.** Every body is byte-identical to the declaration it moved from, apart
// from that one `crypto.` prefix. Four names are exported, which is what the shared adapter method
// set resolves; the other five are private and each was an entry in
// `SERVER_RUNTIME_SOURCE_FUNCTIONS` until this batch, because under the emitted list a helper of a
// registered function had to be registered too or it was a `ReferenceError` in a deployed Capsule.
//
// `chainSchemaOperation` is the fifth private one, and batch 6 predicted where it would land: its
// reverse-graph pass found it sitting inside the file-storage region with no file caller and named
// it "the log index's". Its two callers are `createLogIndexTables` and `backfillLogIndexSequences`,
// both here, and nothing else in the repository has ever called it.
import { isPromiseLike, thenIfPromise } from "./maybe-promise.js";
// Nanoseconds since the epoch is around 1.76e18 today, so the 20-digit width below reaches the year
// 5138. The width is fixed rather than natural because the values are compared as text: a value
// that grew a digit would sort before every narrower one and silently invert the whole index.
function formatLogIndexSequence(nanosSinceEpoch) {
    return String(nanosSinceEpoch).padStart(20, "0");
}
// Nanoseconds since the epoch, strictly increasing for as long as this process lives.
//
// `Date.now()` alone is not enough: it has millisecond resolution, so events indexed in the same
// burst — the routine case, not the exotic one — would tie, and a tie is exactly the undefined
// order this field exists to remove. `process.hrtime.bigint()` alone is not enough either: its
// origin is arbitrary per process, so two runs of the same Capsule would produce values that do not
// order against each other. So the two clocks are read together, once, and every sequence is that
// wall anchor plus the monotonic delta: ordered within the process, and correctly placed against
// sequences any other run wrote.
//
// The previous value is carried forward and stepped past, which is what makes the field monotonic
// by construction rather than by trusting the platform's clock resolution. `process.hrtime.bigint()`
// is strictly increasing on the platforms Sporades runs on, but "increasing because the call takes
// longer than the tick" is a property of the host rather than of this code, and a rare tie would
// leave the order undefined in precisely the case the conformance specification asserts.
function nextLogIndexSequence() {
    const state = nextLogIndexSequence;
    state.anchor ??= { wallNanos: BigInt(Date.now()) * 1000000n, monotonic: process.hrtime.bigint() };
    const derived = state.anchor.wallNanos + (process.hrtime.bigint() - state.anchor.monotonic);
    const previous = state.previous ?? 0n;
    state.previous = derived > previous ? derived : previous + 1n;
    return formatLogIndexSequence(state.previous);
}
// The sequence a row stored before this field existed is given. Its envelope timestamp is the only
// evidence of when it happened, so it is converted to the same units and the same width as a live
// sequence; that is what lets a backfilled row and a newly indexed one sort against each other
// rather than beside each other. Ties among already-stored rows are historical and unrecoverable,
// so the backfill only has to preserve the order the timestamps do record.
function backfilledLogIndexSequence(timestamp) {
    const parsed = Date.parse(String(timestamp ?? ""));
    return Number.isFinite(parsed) ? BigInt(parsed) * 1000000n : 0n;
}
export function createLogIndexTables(sqlite) {
    // Kept outside any transaction by its caller. The ALTER below tolerates the column already
    // existing by swallowing the engine's duplicate-column error, and on Postgres a swallowed error
    // aborts the enclosing transaction, so everything after it would fail with `current transaction
    // is aborted`. Storage bootstrap runs before the migration transaction opens; it has to stay
    // there.
    let chain = chainSchemaOperation(undefined, () => sqlite.exec(sqlite.dialect.sql("CREATE TABLE IF NOT EXISTS [sporades_log_events] (" +
        "[id] TEXT PRIMARY KEY, " +
        "[timestamp] TEXT NOT NULL, " +
        "[category] TEXT NOT NULL, " +
        "[event] TEXT NOT NULL, " +
        "[level] TEXT NOT NULL, " +
        "[message] TEXT NOT NULL, " +
        "[capsuleName] TEXT, " +
        "[capsuleId] TEXT, " +
        "[releaseId] TEXT, " +
        "[requestId] TEXT, " +
        "[correlationId] TEXT, " +
        "[indexSequence] TEXT, " +
        "[payload] TEXT NOT NULL" +
        ")")));
    // The additive migration for a Log index table that already exists. Declaring a column an older
    // database may not have is a dialect entry, because the strategies genuinely differ: `PRAGMA
    // table_info` is SQLite's alone, SQLite has no `ADD COLUMN IF NOT EXISTS`, and Postgres does.
    chain = chainSchemaOperation(chain, () => sqlite.dialect.addMissingColumn(sqlite, "sporades_log_events", "indexSequence", "TEXT"));
    return chainSchemaOperation(chain, () => backfillLogIndexSequences(sqlite));
}
// Gives every row stored before the ordering field existed a sequence derived from its timestamp.
// After the first Capsule start that runs it the selection is empty, so later starts cost one
// bounded read and write nothing.
function backfillLogIndexSequences(sqlite) {
    return thenIfPromise(sqlite
        .prepare(sqlite.dialect.sql("SELECT [id], [timestamp] FROM [sporades_log_events] WHERE [indexSequence] IS NULL " +
        "ORDER BY [timestamp] ASC, [id] ASC"))
        .all(), (rows) => {
        // Rows sharing a timestamp are separated by a nanosecond each, in the order the read
        // returned them, so that the backfilled values are distinct and the result of running the
        // backfill is the same on every engine. Which of two historically tied rows comes first is
        // not recoverable; that they come back in a defined order is.
        let previous = 0n;
        let chain = undefined;
        for (const row of rows) {
            const derived = backfilledLogIndexSequence(row.timestamp);
            previous = derived > previous ? derived : previous + 1n;
            const sequence = formatLogIndexSequence(previous);
            chain = chainSchemaOperation(chain, () => sqlite
                .prepare(sqlite.dialect.sql("UPDATE [sporades_log_events] SET [indexSequence] = ? WHERE [id] = ?"))
                .run(sequence, row.id));
        }
        return chain;
    });
}
export function insertLogIndexEvent(sqlite, event) {
    // ADR-0034: a Database adapter method that writes returns its statement result rather than
    // discarding it. Without the return the caller has nothing to await, so the write has landed on
    // SQLite and has not landed on Postgres or libSQL by the time the method returns — and the Log
    // index caller's `isPromiseLike` probe can never fire.
    return sqlite
        .prepare(sqlite.dialect.sql("INSERT INTO [sporades_log_events] " +
        "([id], [timestamp], [category], [event], [level], [message], [capsuleName], [capsuleId], [releaseId], " +
        "[requestId], [correlationId], [indexSequence], [payload]) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"))
        .run(crypto.randomUUID(), event.timestamp, event.category, event.event, event.level, event.message, event.capsule?.name ?? null, event.capsule?.id ?? null, event.release?.id ?? event.release ?? null, event.request?.id ?? null, event.correlation?.id ?? event.correlation ?? null, 
    // ADR-0036: assigned here, as the event is indexed, and deliberately not added to the
    // envelope that is stringified into `payload` below. The field orders the Log index; it is
    // not part of what a log event says.
    nextLogIndexSequence(), JSON.stringify(event));
}
export function pruneLogIndex(sqlite, limit) {
    // ADR-0034: returned rather than discarded, for the same reason as the insert above.
    //
    // ADR-0036: the bound is expressed as "keep the most recently indexed N" rather than "delete
    // everything past offset N". The offset form needed `LIMIT -1 OFFSET ?`, which is SQLite's alone
    // and is why Postgres carried its own copy of this method; naming the kept set instead is
    // portable, so there is one definition and one answer. It also states the intent directly: this
    // is the same subset a bounded `readRecentLogEvents` returns, which is what stops two Capsules on
    // different engines retaining different history.
    //
    // A bound of zero keeps nothing, so `NOT IN` an empty set removes every row. `id` is the primary
    // key and never null, so the `NOT IN` has no null to be confused by.
    return sqlite
        .prepare(sqlite.dialect.sql("DELETE FROM [sporades_log_events] WHERE [id] NOT IN (" +
        "SELECT [id] FROM (" +
        "SELECT [id] FROM [sporades_log_events] ORDER BY [indexSequence] DESC LIMIT ?" +
        ") AS [retained]" +
        ")"))
        .run(limit);
}
export function readRecentLogEvents(sqlite, limit = 200) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 200;
    // ADR-0034: the rows are reversed and parsed, so they must be resolved first. Reading them
    // unresolved reversed and mapped a Promise, which is why libSQL carried an await-shim.
    //
    // ADR-0036: ordered by the runtime-assigned sequence alone. The envelope `timestamp` no longer
    // participates, because it is a millisecond-resolution value that ties routinely and left the
    // order to a tie-break that differed by engine.
    return thenIfPromise(sqlite
        .prepare(sqlite.dialect.sql("SELECT [payload] FROM [sporades_log_events] ORDER BY [indexSequence] DESC LIMIT ?"))
        .all(safeLimit), (rows) => rows.reverse().map((row) => JSON.parse(row.payload)));
}
function chainSchemaOperation(previous, operation) {
    if (isPromiseLike(previous)) {
        return previous.then(operation);
    }
    return operation();
}
//# sourceMappingURL=log-index-storage.js.map