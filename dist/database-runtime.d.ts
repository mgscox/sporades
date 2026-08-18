import type { PathLike } from "node:fs";
type LooseRecord = Record<string, any>;
type RuntimeConfig = LooseRecord;
type RuntimeEnv = Record<string, string | undefined>;
export declare function isActiveTransactionScopedAdapter(value: any, owner?: any): boolean;
export declare function createRuntimeDatabaseAdapter(databasePath: any, serverEnv?: RuntimeEnv, config?: RuntimeConfig): Promise<LooseRecord>;
export declare function createRuntimeInspectionAdapter(databasePath: any, serverEnv?: RuntimeEnv, config?: RuntimeConfig): Promise<LooseRecord | null>;
export declare function createDatabaseDialect(spec: LooseRecord): LooseRecord;
export declare function createDatabaseNormalization(spec: LooseRecord): LooseRecord;
export declare function sqliteRowNormalization(): LooseRecord;
export declare function postgresRowNormalization(): LooseRecord;
export declare function libsqlRowNormalization(): LooseRecord;
export declare function sqliteDatabaseDialect(): LooseRecord;
export declare function postgresDatabaseDialect(): LooseRecord;
export declare function createSharedDatabaseAdapterMethods(dialect: LooseRecord): LooseRecord;
export declare function createSqliteDatabaseAdapter(databasePath: PathLike, options?: LooseRecord): Promise<LooseRecord>;
export declare function createPostgresDatabaseAdapter(options: {
    url: any;
}): Promise<LooseRecord>;
export declare function createPostgresConnection(url: any): Promise<{
    readonly backendKeyData: Buffer<ArrayBuffer> | null;
    query(sql: string): Promise<{
        fields: any[];
        rows: LooseRecord[];
        rowCount: number;
    }>;
    close(): Promise<void>;
}>;
export declare function postgresInterpolate(sql: any, params?: any[]): string;
export declare function createLibsqlDatabaseAdapter(options: {
    url: any;
    authToken: any;
}): Promise<{
    engine: string;
    dialect: LooseRecord;
    normalization: LooseRecord;
    withTransaction(fn: (transactionAdapter: LooseRecord) => any): Promise<any>;
    withReadOnlySnapshot(fn: (adapter: LooseRecord) => any): Promise<any>;
    close(): Promise<void>;
    exec(sql: string): any;
    prepare(sql: string): {
        all(...params: (number | undefined)[]): any;
        get(...params: undefined[]): any;
        run(...params: string[]): any;
        columns(): any;
    };
}>;
export declare function createAppTable(sqlite: LooseRecord, table: LooseRecord, tableName?: any): any;
export declare function listDatabaseTables(database: {
    adapter: any;
    sqlite: any;
}): Promise<any>;
export declare function dumpDatabase(database: {
    adapter: any;
    sqlite: any;
}): Promise<any>;
export declare function runReadOnlyQuery(database: {
    adapter: any;
    sqlite: any;
}, sql: any): Promise<any>;
export declare function splitSqlStatements(sql: any): string[];
export declare function quoteIdentifier(identifier: any): string;
export {};
//# sourceMappingURL=database-runtime.d.ts.map