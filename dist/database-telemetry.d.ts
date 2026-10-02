export declare const databaseTelemetry: unique symbol;
type Engine = "sqlite" | "postgres" | "libsql";
export declare function withDatabaseSpan<T>(engine: Engine, operation: string, table: string | undefined, run: () => T): T;
export declare function createDatabaseTelemetry(engine: Engine): {
    registerTables(schema: any): void;
    operations(operations: Record<string, any>): Record<string, any> | {
        exec(sql: any): unknown;
        prepare(sql: any): any;
    };
};
export {};
//# sourceMappingURL=database-telemetry.d.ts.map