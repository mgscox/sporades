import type { IncomingMessage, ServerResponse } from "node:http";
import { PathOrFileDescriptor } from "node:fs";
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
export * from "./stored-value-coding.js";
export * from "./log-index-storage.js";
export * from "./database-runtime.js";
export * from "./acl-runtime.js";
export * from "./http-runtime.js";
type LooseRecord = Record<string, any>;
type RuntimeConfig = LooseRecord;
type RuntimeEnv = Record<string, string | undefined>;
export declare function shutdownAndCloseDatabase(database: LooseRecord): Promise<void>;
export declare function shutdownHttpServerAndRuntime(server: LooseRecord, shutdownRuntime: () => any): Promise<void>;
export declare function replaceRuntimeDatabase(currentDatabase: LooseRecord, candidateDatabase: LooseRecord): Promise<LooseRecord>;
export declare function openDevDatabase(databasePath: string, serverSource: any, serverEnv?: RuntimeEnv, config?: RuntimeConfig, capsuleDefinition?: any, options?: LooseRecord): Promise<LooseRecord>;
export declare function enqueueScheduledOccurrence(database: LooseRecord, definition: any, occurrence: Date): Promise<any>;
export declare function createRuntimeLogSink(options: {
    database: any;
    config: any;
    serverEnv: any;
    dataDir: any;
}): {
    path: any;
    withDatabase(database: LooseRecord): /*elided*/ any;
    emit(input: any): any;
    recent(limit?: number): any;
    tail(limit?: number): any[];
};
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
        uniqueConstraints: any[][];
    }[];
};
export declare function extractEndpoints(serverSource: string): {
    name: string;
    method: string;
    path: string;
    handlerSource: string;
}[];
export declare function routeEndpoint(database: {
    endpoints: any[];
}, request: IncomingMessage, response: ServerResponse<IncomingMessage> & {
    req: IncomingMessage;
}): Promise<boolean>;
export declare function runEndpoint(database: any, endpoint: {
    handler?: Function;
    handlerSource?: string;
}, requestUrl: URL, request: any): Promise<any>;
export declare function createEndpointDatabaseApi(database: LooseRecord, contextGetter?: any): {
    [k: string]: any;
};
export declare function withTrustedRead(database: LooseRecord, options: LooseRecord, callback: (db: LooseRecord) => any): Promise<any>;
export declare function normalizeJourneyPolicy(value: any): {
    ttlSeconds: any;
    capture: any;
} | null;
export declare function normalizeJourneyState(value: any, defaultTtlSeconds: number): {
    status: any;
    metadata: any;
    ttlSeconds: any;
};
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
export declare function runQuery(database: LooseRecord, auth: any, queryName: string, rawArgs?: unknown): Promise<any>;
export declare function runMutation(database: LooseRecord, auth: any, mutationName: string, args: any): Promise<any>;
export declare function runAppMessage(database: LooseRecord, auth: any, messageName: any, data: any, options?: LooseRecord): Promise<any>;
export declare function runCurrentUserJobWorker(database: LooseRecord): Promise<void>;
//# sourceMappingURL=server-runtime-source.d.ts.map