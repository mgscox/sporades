// Table-scoped live query refresh. A subscription records the app and runtime tables its last
// run read; writes record the tables they changed. refreshQueries then re-runs only the
// subscriptions whose read set meets a changed table, instead of every subscription for every
// client after each writing mutation or job.
//
// Only adapters that record every statement they execute can scope a refresh. Such an adapter
// carries `liveQueryTablesTracked`; with any other adapter the refresh stays unscoped.

const { AsyncLocalStorage } = process.getBuiltinModule("node:async_hooks");

/** Marks a database adapter whose statement operations report reads and writes here. */
export const liveQueryTablesTracked = Symbol.for("sporades.database.liveQueryTablesTracked");

/** Stands for a statement whose tables could not be identified; it matches every subscription. */
export const LIVE_QUERY_ANY_TABLE = "*";

const liveQueryReads = new AsyncLocalStorage<Set<string>>();
let dirtyTables = new Set<string>();
let writeGeneration = 0;

function recordTableWrite(table: string, tables: Set<string>) {
  tables.add(table);
  // Query evaluation may write diagnostic logs. Keep those writes in the
  // completion window, but do not let them recursively refresh failed queries.
  if (tables === dirtyTables && !liveQueryReads.getStore()) writeGeneration++;
}

/** Generation of writes published outside live-query evaluation. */
export function liveQueryWriteGeneration(): number { return writeGeneration; }

// Dialects render `[name]` identifiers as `"name"` before execution; accept either form.
const quotedIdentifier = String.raw`(?:\[([^\]]+)\]|"([^"]+)")`;
const readTablePattern = new RegExp(String.raw`\b(?:FROM|JOIN)\s+${quotedIdentifier}`, "gi");
const writeTablePattern = new RegExp(
  String.raw`^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+${quotedIdentifier}`,
  "i",
);
const nonWritingStatementPattern = /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|SELECT|LOCK\s+TABLE)\b/i;

/** Runs a live query, collecting every table it reads into `tables`. */
export function trackLiveQueryReads<T>(tables: Set<string>, run: () => T): T {
  return liveQueryReads.run(tables, run);
}

export function recordLiveQueryStatementRead(sql: string) {
  const tables = liveQueryReads.getStore();
  if (!tables) return;
  let identified = false;
  for (const match of String(sql).matchAll(readTablePattern)) {
    tables.add(match[1] ?? match[2]);
    identified = true;
  }
  if (!identified) tables.add(LIVE_QUERY_ANY_TABLE);
}

/** Records a read served without a statement, such as a runtime row cache hit. */
export function recordLiveQueryTableRead(table: string) {
  liveQueryReads.getStore()?.add(table);
}

/**
 * Records the table a statement wrote. Recognized single-table writes with a trustworthy
 * zero-row count are ignored. Unknown statements and batches always mark every table, because
 * their reported count may describe only the final operation (including data-modifying CTEs).
 */
export function recordLiveQueryStatementWrite(sql: string, result?: unknown, tables = dirtyTables) {
  const text = String(sql);
  // exec can execute several statements but has no per-statement change counts. A semicolon
  // inside a literal or comment can over-refresh; treating a second statement as just the first
  // table would under-refresh. A single trailing terminator is harmless.
  const terminator = text.indexOf(";");
  if (terminator !== -1 && /\S/.test(text.slice(terminator + 1))) {
    recordTableWrite(LIVE_QUERY_ANY_TABLE, tables);
    return;
  }
  if (nonWritingStatementPattern.test(text)) return;
  const match = writeTablePattern.exec(text);
  if (match && result && typeof result === "object" && "changes" in result && Number((result as { changes: unknown }).changes) === 0) return;
  recordTableWrite(match ? (match[1] ?? match[2]) : LIVE_QUERY_ANY_TABLE, tables);
}

/** Publishes a settled transaction's writes into the current refresh window. */
export function publishLiveQueryDirtyTables(tables: Set<string>) {
  for (const table of tables) recordTableWrite(table, dirtyTables);
}

/** Returns the tables written since the previous call, and starts a new window. */
export function takeLiveQueryDirtyTables(): Set<string> {
  const taken = dirtyTables;
  dirtyTables = new Set();
  return taken;
}

/**
 * Whether a subscription must re-run for the given changed tables. A subscription with no read
 * set yet (first run still in flight) or an unidentified read always re-runs.
 */
export function liveQueryNeedsRefresh(readTables: Set<string> | null | undefined, dirty: Set<string>) {
  if (!readTables || dirty.has(LIVE_QUERY_ANY_TABLE)) return true;
  for (const table of readTables) if (dirty.has(table)) return true;
  return false;
}
