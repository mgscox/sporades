import type { IncomingMessage, ServerResponse } from "node:http";
import { PathLike, PathOrFileDescriptor } from "node:fs";
import { Duplex } from "stream";
export * from "./inspection-sql.js";
export * from "./log-index-guard.js";
export * from "./mail-config.js";
export * from "./mail-runtime.js";
export * from "./auth-runtime.js";
export * from "./runtime-errors.js";
export * from "./jobs-runtime.js";
export * from "./user-preferences-runtime.js";
export * from "./file-storage-runtime.js";
export * from "./maybe-promise.js";
export * from "./runtime-log-policy.js";
export * from "./stored-row-decoding.js";
export * from "./acl-runtime.js";
export * from "./http-runtime.js";
type LooseRecord = Record<string, any>;
type RuntimeConfig = LooseRecord;
type RuntimeEnv = Record<string, string | undefined>;
export declare const SERVER_RUNTIME_SOURCE_FUNCTIONS: Function[];
export declare function openDevDatabase(databasePath: string, serverSource: any, serverEnv?: RuntimeEnv, config?: RuntimeConfig, capsuleDefinition?: any, options?: LooseRecord): Promise<LooseRecord>;
export declare function enqueueScheduledOccurrence(database: LooseRecord, definition: any, occurrence: Date): Promise<any>;
export declare function createRuntimeInspectionAdapter(databasePath: any, serverEnv?: RuntimeEnv, config?: RuntimeConfig): Promise<LooseRecord | null>;
export declare function createDatabaseDialect(spec: LooseRecord): LooseRecord;
export declare function quoteSqlIdentifiers(quoteIdentifier: (identifier: string) => string, statement: string): string;
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
    exec(sql: string): Promise<undefined>;
    prepare(sql: string): {
        all(...params: (number | undefined)[]): Promise<any>;
        get(...params: undefined[]): Promise<any>;
        run(...params: string[]): Promise<{
            changes: number;
            lastInsertRowid: bigint | undefined;
        }>;
        columns(): Promise<any>;
    };
}>;
export declare function createLogEnvelope(input: {
    config: LooseRecord;
    timestamp: any;
    category: any;
    event: any;
    level: any;
    message: any;
    release: any;
    request: {
        id: any;
        method: any;
        path: any;
    };
    correlation: any;
    data: any;
    serverEnv: any;
}): LooseRecord;
export declare function readJsonlLogEvents(logPath: PathOrFileDescriptor, limit?: number): any[];
export declare function schemaFromCapsuleDefinition(definition: any): {
    tables: {
        name: string;
        acl: {
            [x: string]: any;
        };
        fields: {
            name: string;
            kind: any;
            sqliteType: string;
            targetTable: string | undefined;
            defaultValue: any;
        }[];
    }[];
};
export declare function routeEndpoint(database: {
    endpoints: any[];
}, request: IncomingMessage, response: ServerResponse<IncomingMessage> & {
    req: IncomingMessage;
}): Promise<boolean>;
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
type TrustedRefreshTransport = {
    subscribeType: "dev.refresh.subscribe";
    receivedType: "dev.refresh.received";
    subscribe(connectionId: string, requestId: string | null, send: (message: LooseRecord) => Promise<LooseRecord>): Promise<void> | void;
    received(connectionId: string, sequence: number): void;
    disconnected(connectionId: string): void;
};
export declare function createWebSocketHub(getDatabase: () => any, trustedRefresh?: TrustedRefreshTransport | null): {
    createConnectionToken(): string;
    accept(request: IncomingMessage, socket: Duplex): Promise<void>;
    disconnectAll(): void;
    listAuthClients(): {
        id: any;
        connectedAt: any;
        lastSeenAt: any;
        auth: {
            userId: any;
            displayName: any;
            email: any;
            picture: any;
            isAuthenticated: boolean;
            isGuest: any;
            provider: any;
        };
    }[];
    journeyDiagnostics(): {
        disableRequests: number;
        activeStates: number;
    };
    notifyFileEvent(userId: any, event: any): void;
    deliverAuthSession(target: any, sessionData: {
        localStorage: {
            value: any;
        };
        auth: any;
    }): {
        target: any;
        delivered: boolean;
        clients: number;
    };
};
export declare function sendEmailPasswordResetLink(database: LooseRecord, session: LooseRecord, email: string, options?: LooseRecord): Promise<{
    ok: boolean;
    error: {
        message: string;
        hint: string;
    };
} | {
    ok: boolean;
    error?: undefined;
}>;
export declare function runQuery(database: LooseRecord, auth: any, queryName: string): Promise<any>;
export declare function runMutation(database: LooseRecord, auth: any, mutationName: string, args: any): Promise<any>;
//# sourceMappingURL=server-runtime-source.d.ts.map