/** Marks a database adapter whose statement operations report reads and writes here. */
export declare const liveQueryTablesTracked: unique symbol;
/** Stands for a statement whose tables could not be identified; it matches every subscription. */
export declare const LIVE_QUERY_ANY_TABLE = "*";
/** Runs a live query, collecting every table it reads into `tables`. */
export declare function trackLiveQueryReads<T>(tables: Set<string>, run: () => T): T;
export declare function recordLiveQueryStatementRead(sql: string): void;
/** Records a read served without a statement, such as a runtime row cache hit. */
export declare function recordLiveQueryTableRead(table: string): void;
/**
 * Records the table a statement wrote. Statements that changed no rows are ignored, and a
 * statement whose table cannot be identified (DDL, multi-statement exec) marks every table.
 */
export declare function recordLiveQueryStatementWrite(sql: string, result?: unknown): void;
/** Returns the tables written since the previous call, and starts a new window. */
export declare function takeLiveQueryDirtyTables(): Set<string>;
/**
 * Whether a subscription must re-run for the given changed tables. A subscription with no read
 * set yet (first run still in flight) or an unidentified read always re-runs.
 */
export declare function liveQueryNeedsRefresh(readTables: Set<string> | null | undefined, dirty: Set<string>): boolean;
//# sourceMappingURL=live-query-invalidation.d.ts.map