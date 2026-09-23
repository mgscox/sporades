// Table-scoped live query refresh. A subscription records the app and runtime tables its last
// run read; writes record the tables they changed. refreshQueries then re-runs only the
// subscriptions whose read set meets a changed table, instead of every subscription for every
// client after each writing mutation or job.
//
// Only adapters that record every statement they execute can scope a refresh. Such an adapter
// carries `liveQueryTablesTracked`; with any other adapter the refresh stays unscoped (#105).

const { AsyncLocalStorage } = process.getBuiltinModule("node:async_hooks");

/** Marks a database adapter whose statement operations report reads and writes here. */
export const liveQueryTablesTracked = Symbol.for("sporades.database.liveQueryTablesTracked");

/** Stands for a statement whose tables could not be identified; it matches every subscription. */
export const LIVE_QUERY_ANY_TABLE = "*";

const liveQueryReads = new AsyncLocalStorage<Set<string>>();
let dirtyTables = new Set<string>();

// Dialects render `[name]` identifiers as `"name"` before execution; accept either form.
const quotedIdentifier = String.raw`(?:\[([^\]]+)\]|"([^"]+)")`;
const readTablePattern = new RegExp(String.raw`\b(?:FROM|JOIN)\s+${quotedIdentifier}`, "gi");
const writeTablePattern = new RegExp(
  String.raw`^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+${quotedIdentifier}`,
  "i",
);
const nonWritingStatementPattern = /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|SELECT)\b/i;

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
 * Records the table a statement wrote. Statements that changed no rows are ignored, and a
 * statement whose table cannot be identified (DDL, multi-statement exec) marks every table.
 */
export function recordLiveQueryStatementWrite(sql: string, result?: unknown) {
  if (result && typeof result === "object" && "changes" in result && Number((result as { changes: unknown }).changes) === 0) return;
  const text = String(sql);
  if (nonWritingStatementPattern.test(text)) return;
  const match = writeTablePattern.exec(text);
  dirtyTables.add(match ? (match[1] ?? match[2]) : LIVE_QUERY_ANY_TABLE);
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
