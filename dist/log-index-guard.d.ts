import type { SQLOutputValue } from "node:sqlite";
export declare function targetsInternalLogIndexTable(sql: any): boolean;
export declare function readSqlTableReference(sql: string, startIndex: number): string[];
export declare function isInternalLogIndexMetadataRow(row: Record<string, SQLOutputValue>, sql?: string): boolean;
//# sourceMappingURL=log-index-guard.d.ts.map