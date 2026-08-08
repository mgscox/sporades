type LooseRecord = Record<string, any>;
export declare function formatLogIndexSequence(nanosSinceEpoch: bigint): string;
export declare function nextLogIndexSequence(): string;
export declare function backfilledLogIndexSequence(timestamp: any): bigint;
export declare function createLogIndexTables(sqlite: LooseRecord): any;
export declare function insertLogIndexEvent(sqlite: LooseRecord, event: LooseRecord): any;
export declare function pruneLogIndex(sqlite: LooseRecord, limit: any): any;
export declare function readRecentLogEvents(sqlite: LooseRecord, limit?: number): any;
export {};
//# sourceMappingURL=log-index-storage.d.ts.map