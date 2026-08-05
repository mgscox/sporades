import type { IncomingMessage, ServerResponse } from "node:http";
import { PathLike, PathOrFileDescriptor } from "node:fs";
import { SQLOutputValue, StatementResultingChanges, StatementColumnMetadata } from "node:sqlite";
import { Duplex } from "stream";
type LooseRecord = Record<string, any>;
type RuntimeConfig = LooseRecord;
type RuntimeEnv = Record<string, string | undefined>;
type RuntimeSecurityPolicy = {
    cors: {
        sameOrigin: boolean;
        publicDev: boolean;
        allowedOrigins: string[];
        allowedOriginPatterns: string[];
        requireExplicitCrossOrigin: boolean;
        publicOrigin: string | null;
    };
    csp: {
        mode: string;
        header: string;
        directives: Record<string, string[] | string>;
    };
};
export declare const SERVER_RUNTIME_SOURCE_FUNCTIONS: Function[];
export declare function readJsonRequest(request: IncomingMessage, limitSource?: LooseRecord | number | null): Promise<LooseRecord>;
export declare function writeUnhandledHttpError(database: LooseRecord, request: IncomingMessage, response: ServerResponse<IncomingMessage>, error: any): void;
export declare function prepareHttpSecurity(database: {
    securityPolicy?: RuntimeSecurityPolicy;
}, request: IncomingMessage, response: ServerResponse<IncomingMessage> & {
    req: IncomingMessage;
}): boolean;
export declare function injectPageConnectionToken(html: string, token: string): string;
export declare function openDevDatabase(databasePath: string, serverSource: any, serverEnv?: RuntimeEnv, config?: RuntimeConfig, capsuleDefinition?: any, options?: LooseRecord): Promise<LooseRecord>;
export declare function enqueueScheduledOccurrence(database: LooseRecord, definition: any, occurrence: Date): Promise<any>;
/** Internal full-runtime test support; not exported from sporades/server or sporades/client. */
export declare function createControllableRuntimeClock(initialInstant: string | number | Date): {
    now: () => Date;
    setInstant(instant: string | number | Date): void;
    advanceBy(delayMs: number): void;
    setTimer(callback: () => any, delayMs: number): number;
    clearTimer(id: number): void;
    runDueTimers(): Promise<void>;
};
export declare function createRuntimeInspectionAdapter(databasePath: any, serverEnv?: RuntimeEnv, config?: RuntimeConfig): Promise<LooseRecord | null>;
export declare function createRuntimeFileStorageAdapter({ config, databasePath, serviceEnv }: {
    config?: RuntimeConfig;
    databasePath: string;
    serviceEnv?: RuntimeEnv;
}): Promise<{
    engine: string;
    endpoint: string;
    bucket: string;
    region: string;
    namespace: string;
    objectKeyPrefix: string;
    writeFileVersion({ fileId, version, bytes }: {
        fileId: string;
        version: string | number;
        bytes: Uint8Array | Buffer | string;
    }): Promise<void>;
    readFileVersion({ fileId, version }: {
        fileId: string;
        version: string | number;
    }): Promise<Buffer<ArrayBufferLike>>;
    deleteFileVersion({ fileId, version }: {
        fileId: string;
        version: string | number;
    }): Promise<void>;
    checkHealth(): Promise<{
        ok: boolean;
        adapter: string;
    }>;
    close(): void;
} | {
    engine: string;
    storagePath: string;
    writeFileVersion({ fileId, version, bytes }: {
        fileId: string;
        version: string | number;
        bytes: Uint8Array | Buffer | string;
    }): Promise<void>;
    readFileVersion({ fileId, version }: {
        fileId: string;
        version: string | number;
    }): Promise<NonSharedBuffer>;
    deleteFileVersion({ fileId, version }: {
        fileId: string;
        version: string | number;
    }): Promise<void>;
    checkHealth(): Promise<{
        ok: boolean;
    }>;
    close(): void;
}>;
export declare function createLocalFileStorageAdapter({ storagePath }: {
    storagePath: string;
}): {
    engine: string;
    storagePath: string;
    writeFileVersion({ fileId, version, bytes }: {
        fileId: string;
        version: string | number;
        bytes: Uint8Array | Buffer | string;
    }): Promise<void>;
    readFileVersion({ fileId, version }: {
        fileId: string;
        version: string | number;
    }): Promise<NonSharedBuffer>;
    deleteFileVersion({ fileId, version }: {
        fileId: string;
        version: string | number;
    }): Promise<void>;
    checkHealth(): Promise<{
        ok: boolean;
    }>;
    close(): void;
};
export declare function createS3CompatibleFileStorageAdapter({ endpoint, bucket, region, accessKey, secretKey, namespace, }: {
    endpoint: string;
    bucket: string;
    region: string;
    accessKey: string;
    secretKey: string;
    namespace: string;
}): {
    engine: string;
    endpoint: string;
    bucket: string;
    region: string;
    namespace: string;
    objectKeyPrefix: string;
    writeFileVersion({ fileId, version, bytes }: {
        fileId: string;
        version: string | number;
        bytes: Uint8Array | Buffer | string;
    }): Promise<void>;
    readFileVersion({ fileId, version }: {
        fileId: string;
        version: string | number;
    }): Promise<Buffer<ArrayBufferLike>>;
    deleteFileVersion({ fileId, version }: {
        fileId: string;
        version: string | number;
    }): Promise<void>;
    checkHealth(): Promise<{
        ok: boolean;
        adapter: string;
    }>;
    close(): void;
};
export declare function createSqliteDatabaseAdapter(databasePath: PathLike, options?: LooseRecord): Promise<{
    engine: string;
    exec(sql: string): void;
    prepare(sql: string): {
        all(...params: any[]): Record<string, SQLOutputValue>[];
        get(...params: any[]): Record<string, SQLOutputValue> | undefined;
        run(...params: string[]): StatementResultingChanges;
        columns(): StatementColumnMetadata[];
    };
    ensureSystemTable(): void;
    readSystemMetadata(key: string): Record<string, SQLOutputValue> | null;
    writeSystemMetadata(key: string, value: any): StatementResultingChanges;
    readSchemaMetadata(): Record<string, SQLOutputValue> | null;
    writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: LooseRecord): void;
    ensureLogStorage(): void;
    insertLogIndexEvent(event: any): void;
    pruneLogIndex(limit: any): void;
    readRecentLogEvents(limit: number | undefined): any;
    ensureFileStorage(): void;
    findFileBucket(ownerId: any, name: any): Record<string, SQLOutputValue> | null;
    createFileBucket(row: {
        id: any;
        ownerId: any;
        name: any;
        createdAt: any;
    }): StatementResultingChanges;
    insertFileRow(row: {
        id: any;
        ownerId: any;
        bucketId: any;
        bucketName: any;
        path: any;
        name: any;
        type: any;
        size: any;
        version: any;
        status: any;
        createdAt: any;
        updatedAt: any;
    }): StatementResultingChanges;
    updatePendingFileRow(row: {
        bucketId: any;
        bucketName: any;
        path: any;
        name: any;
        type: any;
        size: any;
        version: any;
        status: any;
        updatedAt: any;
        id: any;
    }): StatementResultingChanges;
    insertFileUpload(row: {
        id: any;
        fileId: any;
        ownerId: any;
        bucketId: any;
        bucketName: any;
        path: any;
        name: any;
        type: any;
        version: any;
        expectedSize: any;
        createdAt: any;
    }): StatementResultingChanges;
    selectFileById(fileId: any): Record<string, SQLOutputValue> | null;
    selectLiveFileByPath(path: any): Record<string, SQLOutputValue>[];
    selectActiveFileByPath(path: any): Record<string, SQLOutputValue>[];
    selectPendingFileUploadByPath(path: any): Record<string, SQLOutputValue> | null;
    selectFileUpload(uploadId: any): Record<string, SQLOutputValue> | null;
    completeFileUpload(upload: {
        id: any;
        fileId: any;
        version: any;
        bucketId: any;
        bucketName: any;
        path: any;
        name: any;
        type: any;
        ownerId: any;
        createdAt: any;
    }, size: any, updatedAt: any): StatementResultingChanges | {
        changes: number;
    };
    deleteFileUploadsForPath(path: any): StatementResultingChanges;
    deleteFileUploadsForFile(ownerId: any, fileId: any): StatementResultingChanges;
    deleteFileUpload(uploadId: any): StatementResultingChanges;
    selectPublicFileRow(publicUrlId: any): Record<string, SQLOutputValue> | null;
    insertPublicFileUrl(row: {
        id: any;
        fileId: any;
        ownerId: any;
        version: any;
        expiresAt: any;
        createdAt: any;
    }): StatementResultingChanges;
    revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): StatementResultingChanges;
    revokePublicFileUrlsForFile(fileId: any, revokedAt: any): StatementResultingChanges;
    markFileDeleted(fileId: any, deletedAt: any): StatementResultingChanges;
    fileRowForOwner(fileId: any, ownerId: any): Record<string, SQLOutputValue> | null;
    ensureAuthStorage(authConfig?: any): void;
    ensureUserPreferencesStorage(): Promise<void>;
    readUserPreferences(userId: any): Record<string, SQLOutputValue> | null;
    saveUserPreferences(row: {
        userId: any;
        value: any;
        updatedAt: any;
    }): StatementResultingChanges;
    findAuthIdentityByProviderSubject(provider: any, subject: any): any;
    findLegacyAuthIdentitiesByProviderEmail(provider: any, email: any): any;
    insertAuthIdentity(row: {
        id: any;
        userId: any;
        provider: any;
        subject: any;
        email: any;
        displayName: any;
        picture: any;
        createdAt: any;
        updatedAt: any;
    }): StatementResultingChanges;
    updateAuthIdentity(row: {
        id: any;
        subject: any;
        email: any;
        displayName: any;
        picture: any;
        updatedAt: any;
    }): StatementResultingChanges;
    insertAuthUser(row: {
        id: any;
        createdAt: any;
        displayName: any;
        email: any;
        picture: any;
        isAuthenticated: any;
        isGuest: any;
        provider: any;
    }): StatementResultingChanges;
    updateAuthUserProfile(row: {
        displayName: any;
        picture: any;
        isAuthenticated: any;
        isGuest: any;
        id: any;
    }): StatementResultingChanges;
    linkAuthUser(row: {
        displayName: any;
        email: any;
        picture: any;
        isAuthenticated: any;
        isGuest: any;
        provider: any;
        id: any;
    }): StatementResultingChanges;
    insertAuthSession(row: {
        token: any;
        userId: any;
        provider: any;
        createdAt: any;
        expiresAt: any;
    }): StatementResultingChanges;
    deleteAuthSession(token: any): StatementResultingChanges;
    refreshAuthSession(token: any, expiresAt: any): StatementResultingChanges;
    setAuthSessionProvider(token: any, provider: any): StatementResultingChanges;
    rotateAuthSession(previousToken: any, row: {
        token: any;
        userId: any;
        provider: any;
        createdAt: any;
        expiresAt: any;
    }): StatementResultingChanges;
    readAuthSessionWithUser(token: any): Record<string, SQLOutputValue> | null;
    insertOAuthState(row: LooseRecord): StatementResultingChanges;
    consumeOAuthState(state: any): Record<string, SQLOutputValue> | null;
    emailCredentialExists(email: any): boolean;
    insertEmailCredential(row: {
        email: any;
        userId: any;
        passwordHash: any;
        passwordSalt: any;
        createdAt: any;
    }): StatementResultingChanges;
    updateEmailCredentialPassword(email: any, passwordHash: any, passwordSalt: any): StatementResultingChanges;
    findEmailCredentialWithUser(email: any): Record<string, SQLOutputValue> | null;
    deleteAuthSessionsForUser(userId: any): StatementResultingChanges;
    insertPasswordResetCode(row: LooseRecord): StatementResultingChanges;
    findPasswordResetCode(selector: any): Record<string, SQLOutputValue> | null;
    countPasswordResetCodesForEmail(email: any, now: any): number;
    deletePasswordResetCodesForUser(userId: any): StatementResultingChanges;
    prunePasswordResetCodes(now: any): StatementResultingChanges;
    migrateAppSchema(schema: {
        tables: {
            name: any;
            acl: {
                allowByDefault: boolean;
            } | {
                allowByDefault: boolean;
                resolve(operation: any): any;
            };
            fields: {
                name: any;
                kind: any;
                sqliteType: string;
                targetTable: string | undefined;
                defaultValue: any;
            }[];
        }[];
    } | {
        tables: {
            name: string;
            fields: ({
                name: any;
                kind: any;
                sqliteType: string;
                targetTable: any;
                defaultValue: any;
            } | null)[];
        }[];
    }): any;
    createAppTable(table: {
        name: any;
    }, tableName?: any): any;
    migrateExistingAppTable(existingTable: any, nextTable: any): any;
    referenceExists(field: {
        targetTable: any;
    }, value: any): boolean;
    withTransaction(fn: (arg0: {
        engine: string;
        exec(sql: any): void;
        prepare(sql: any): {
            all(...params: any[]): Record<string, SQLOutputValue>[];
            get(...params: any[]): Record<string, SQLOutputValue> | undefined;
            run(...params: any[]): StatementResultingChanges;
            columns(): StatementColumnMetadata[];
        };
        ensureSystemTable(): void;
        readSystemMetadata(key: any): Record<string, SQLOutputValue> | null;
        writeSystemMetadata(key: any, value: any): StatementResultingChanges;
        readSchemaMetadata(): Record<string, SQLOutputValue> | null;
        writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: {
            schemaVersion: any;
            schemaHash: any;
            schemaJson: any;
        }): void;
        ensureLogStorage(): void;
        insertLogIndexEvent(event: any): void;
        pruneLogIndex(limit: any): void;
        readRecentLogEvents(limit: any): any;
        ensureFileStorage(): void;
        findFileBucket(ownerId: any, name: any): Record<string, SQLOutputValue> | null;
        createFileBucket(row: any): StatementResultingChanges;
        insertFileRow(row: any): StatementResultingChanges;
        updatePendingFileRow(row: any): StatementResultingChanges;
        insertFileUpload(row: any): StatementResultingChanges;
        selectFileById(fileId: any): Record<string, SQLOutputValue> | null;
        selectLiveFileByPath(path: any): Record<string, SQLOutputValue>[];
        selectActiveFileByPath(path: any): Record<string, SQLOutputValue>[];
        selectPendingFileUploadByPath(path: any): Record<string, SQLOutputValue> | null;
        selectFileUpload(uploadId: any): Record<string, SQLOutputValue> | null;
        completeFileUpload(upload: any, size: any, updatedAt: any): StatementResultingChanges | {
            changes: number;
        };
        deleteFileUploadsForPath(path: any): StatementResultingChanges;
        deleteFileUploadsForFile(ownerId: any, fileId: any): StatementResultingChanges;
        deleteFileUpload(uploadId: any): StatementResultingChanges;
        selectPublicFileRow(publicUrlId: any): Record<string, SQLOutputValue> | null;
        insertPublicFileUrl(row: any): StatementResultingChanges;
        revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): StatementResultingChanges;
        revokePublicFileUrlsForFile(fileId: any, revokedAt: any): StatementResultingChanges;
        markFileDeleted(fileId: any, deletedAt: any): StatementResultingChanges;
        fileRowForOwner(fileId: any, ownerId: any): Record<string, SQLOutputValue> | null;
        ensureAuthStorage(authConfig?: null): void;
        insertAuthUser(row: any): StatementResultingChanges;
        updateAuthUserProfile(row: any): StatementResultingChanges;
        linkAuthUser(row: any): StatementResultingChanges;
        insertAuthSession(row: any): StatementResultingChanges;
        deleteAuthSession(token: any): StatementResultingChanges;
        refreshAuthSession(token: any, expiresAt: any): StatementResultingChanges;
        rotateAuthSession(previousToken: any, row: any): StatementResultingChanges;
        readAuthSessionWithUser(token: any): Record<string, SQLOutputValue> | null;
        insertOAuthState(row: any): StatementResultingChanges;
        consumeOAuthState(state: any): Record<string, SQLOutputValue> | null;
        emailCredentialExists(email: any): boolean;
        insertEmailCredential(row: any): StatementResultingChanges;
        findEmailCredentialWithUser(email: any): Record<string, SQLOutputValue> | null;
        migrateAppSchema(schema: any): any;
        createAppTable(table: any, tableName?: any): any;
        migrateExistingAppTable(existingTable: any, nextTable: any): any;
        referenceExists(field: any, value: any): boolean;
        withTransaction(fn: any): Promise<any>;
        insertAppRow(table: any, row: any): StatementResultingChanges;
        selectAppRowById(table: any, id: any): Record<string, SQLOutputValue> | null;
        updateAppRow(table: any, id: any, values: any, options?: {}): StatementResultingChanges | {
            changes: number;
        };
        deleteAppRow(table: any, id: any): StatementResultingChanges;
        selectAppRows(table: any, query?: {}): Record<string, SQLOutputValue>[];
        listInspectableTables(): SQLOutputValue[];
        dumpInspectableDatabase(): {
            name: SQLOutputValue;
            columns: SQLOutputValue[];
            rows: Record<string, SQLOutputValue>[];
        }[];
        runReadOnlyInspectionQuery(sql: any): {
            ok: boolean;
            data: {
                columns: string[];
                rows: Record<string, SQLOutputValue>[];
            };
            error: null;
        } | {
            ok: boolean;
            data: null;
            error: {
                message: any;
                hint: string;
            };
        };
        checkHealth(): {
            ok: boolean;
        };
        close(): void;
    }) => any): Promise<any>;
    withReadOnlySnapshot(fn: (adapter: LooseRecord) => any): Promise<any>;
    insertAppRow(table: {
        name: any;
    }, row: {
        [x: string]: any;
    }): StatementResultingChanges;
    selectAppRowById(table: {
        name: any;
    }, id: any): Record<string, SQLOutputValue> | null;
    updateAppRow(table: {
        name: any;
    }, id: any, values: {
        [x: string]: any;
    }, options?: LooseRecord): StatementResultingChanges | {
        changes: number;
    };
    deleteAppRow(table: {
        name: any;
    }, id: any): StatementResultingChanges;
    selectAppRows(table: {
        name: any;
    }, query?: LooseRecord): Record<string, SQLOutputValue>[];
    listInspectableTables(): any[];
    dumpInspectableDatabase(): {
        name: any;
        columns: any[];
        rows: Record<string, SQLOutputValue>[];
    }[];
    runReadOnlyInspectionQuery(sql: string | undefined): {
        ok: false;
        data: any;
        error: {
            message: string;
            hint: string;
        };
    } | {
        ok: boolean;
        data: {
            columns: any[];
            rows: Record<string, SQLOutputValue>[];
        };
        error: any;
    } | {
        ok: boolean;
        data: null;
        error: {
            message: any;
            hint: string;
        };
    };
    checkHealth(): {
        ok: boolean;
    };
    close(): void;
}>;
export declare function createPostgresDatabaseAdapter(options: {
    url: any;
}): Promise<{
    engine: string;
    exec(sql: string): Promise<undefined>;
    prepare(sql: string): {
        all(...params: (number | undefined)[]): Promise<any>;
        get(...params: undefined[]): Promise<any>;
        run(...params: string[]): Promise<{
            changes: number;
            lastInsertRowid: any;
        }>;
        columns(): Promise<{
            name: string;
        }[]>;
    };
    writeSystemMetadata(keyOrMetadata: string | null, maybeValue: any): Promise<void | {
        changes: number;
        lastInsertRowid: any;
    }>;
    writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: LooseRecord): Promise<void>;
    ensureAuthStorage(authConfig?: any): Promise<void>;
    insertOAuthState(row: LooseRecord): Promise<{
        changes: number;
        lastInsertRowid: any;
    }>;
    consumeOAuthState(state: string): Promise<any>;
    ensureLogStorage(): Promise<void>;
    ensureFileStorage(): Promise<void>;
    ensureUserPreferencesStorage(): Promise<void>;
    readUserPreferences(userId: any): Promise<any>;
    saveUserPreferences(row: {
        userId: any;
        value: any;
        updatedAt: any;
    }): Promise<{
        changes: number;
        lastInsertRowid: any;
    }>;
    insertLogIndexEvent(event: {
        timestamp: any;
        category: any;
        event: any;
        level: any;
        message: any;
        capsule: {
            name: any;
            id: any;
        };
        release: {
            id: any;
        };
        request: {
            id: any;
        };
        correlation: {
            id: any;
        };
    }): Promise<void>;
    pruneLogIndex(limit: any): Promise<void>;
    readRecentLogEvents(limit?: number): Promise<any>;
    migrateAppSchema(schema: {
        tables: {
            name: any;
            acl: {
                allowByDefault: boolean;
            } | {
                allowByDefault: boolean;
                resolve(operation: any): any;
            };
            fields: {
                name: any;
                kind: any;
                sqliteType: string;
                targetTable: string | undefined;
                defaultValue: any;
            }[];
        }[];
    } | {
        tables: {
            name: string;
            fields: ({
                name: any;
                kind: any;
                sqliteType: string;
                targetTable: any;
                defaultValue: any;
            } | null)[];
        }[];
    }): Promise<any>;
    createAppTable(table: {
        name: any;
    }, tableName?: any): Promise<void>;
    migrateExistingAppTable(existingTable: any, nextTable: any): Promise<void>;
    listInspectableTables(): Promise<any>;
    dumpInspectableDatabase(): Promise<{
        name: any;
        columns: any;
        rows: any;
    }[]>;
    runReadOnlyInspectionQuery(sql: string | undefined): Promise<{
        ok: false;
        data: any;
        error: {
            message: string;
            hint: string;
        };
    } | {
        ok: boolean;
        data: {
            columns: string[];
            rows: any;
        };
        error: any;
    } | {
        ok: boolean;
        data: null;
        error: {
            message: any;
            hint: string;
        };
    }>;
    checkHealth(): Promise<{
        ok: boolean;
    }>;
    withTransaction(fn: (arg0: {
        engine: string;
        exec(sql: any): Promise<undefined>;
        prepare(sql: any): {
            all(...params: any[]): Promise<any>;
            get(...params: any[]): Promise<any>;
            run(...params: any[]): Promise<{
                changes: number;
                lastInsertRowid: undefined;
            }>;
            columns(): Promise<{
                name: any;
            }[]>;
        };
        writeSystemMetadata(keyOrMetadata: any, maybeValue: any): Promise<void | {
            changes: number;
            lastInsertRowid: undefined;
        }>;
        writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: {
            schemaVersion: any;
            schemaHash: any;
            schemaJson: any;
        }): Promise<void>;
        ensureAuthStorage(authConfig?: null): Promise<void>;
        ensureLogStorage(): Promise<void>;
        ensureFileStorage(): Promise<void>;
        insertLogIndexEvent(event: any): Promise<void>;
        pruneLogIndex(limit: any): Promise<void>;
        readRecentLogEvents(limit?: number): Promise<any>;
        migrateAppSchema(schema: any): Promise<void>;
        createAppTable(table: any, tableName?: any): Promise<void>;
        migrateExistingAppTable(existingTable: any, nextTable: any): Promise<void>;
        listInspectableTables(): Promise<any>;
        dumpInspectableDatabase(): Promise<{
            name: any;
            columns: any;
            rows: any;
        }[]>;
        runReadOnlyInspectionQuery(sql: any): Promise<{
            ok: boolean;
            data: {
                columns: any[];
                rows: any;
            };
            error: null;
        } | {
            ok: boolean;
            data: null;
            error: {
                message: any;
                hint: string;
            };
        }>;
        checkHealth(): Promise<{
            ok: boolean;
        }>;
        withTransaction(fn: any): Promise<any>;
        close(): Promise<void>;
        ensureSystemTable(): void;
        readSystemMetadata(key: any): Record<string, SQLOutputValue> | null;
        readSchemaMetadata(): Record<string, SQLOutputValue> | null;
        findFileBucket(ownerId: any, name: any): Record<string, SQLOutputValue> | null;
        createFileBucket(row: any): StatementResultingChanges;
        insertFileRow(row: any): StatementResultingChanges;
        updatePendingFileRow(row: any): StatementResultingChanges;
        insertFileUpload(row: any): StatementResultingChanges;
        selectFileById(fileId: any): Record<string, SQLOutputValue> | null;
        selectLiveFileByPath(path: any): Record<string, SQLOutputValue>[];
        selectActiveFileByPath(path: any): Record<string, SQLOutputValue>[];
        selectPendingFileUploadByPath(path: any): Record<string, SQLOutputValue> | null;
        selectFileUpload(uploadId: any): Record<string, SQLOutputValue> | null;
        completeFileUpload(upload: any, size: any, updatedAt: any): StatementResultingChanges | {
            changes: number;
        };
        deleteFileUploadsForPath(path: any): StatementResultingChanges;
        deleteFileUploadsForFile(ownerId: any, fileId: any): StatementResultingChanges;
        deleteFileUpload(uploadId: any): StatementResultingChanges;
        selectPublicFileRow(publicUrlId: any): Record<string, SQLOutputValue> | null;
        insertPublicFileUrl(row: any): StatementResultingChanges;
        revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): StatementResultingChanges;
        revokePublicFileUrlsForFile(fileId: any, revokedAt: any): StatementResultingChanges;
        markFileDeleted(fileId: any, deletedAt: any): StatementResultingChanges;
        fileRowForOwner(fileId: any, ownerId: any): Record<string, SQLOutputValue> | null;
        insertAuthUser(row: any): StatementResultingChanges;
        updateAuthUserProfile(row: any): StatementResultingChanges;
        linkAuthUser(row: any): StatementResultingChanges;
        insertAuthSession(row: any): StatementResultingChanges;
        deleteAuthSession(token: any): StatementResultingChanges;
        refreshAuthSession(token: any, expiresAt: any): StatementResultingChanges;
        rotateAuthSession(previousToken: any, row: any): StatementResultingChanges;
        readAuthSessionWithUser(token: any): Record<string, SQLOutputValue> | null;
        insertOAuthState(row: any): StatementResultingChanges;
        consumeOAuthState(state: any): Record<string, SQLOutputValue> | null;
        emailCredentialExists(email: any): boolean;
        insertEmailCredential(row: any): StatementResultingChanges;
        findEmailCredentialWithUser(email: any): Record<string, SQLOutputValue> | null;
        referenceExists(field: any, value: any): boolean;
        insertAppRow(table: any, row: any): StatementResultingChanges;
        selectAppRowById(table: any, id: any): Record<string, SQLOutputValue> | null;
        updateAppRow(table: any, id: any, values: any, options?: {}): StatementResultingChanges | {
            changes: number;
        };
        deleteAppRow(table: any, id: any): StatementResultingChanges;
        selectAppRows(table: any, query?: {}): Record<string, SQLOutputValue>[];
    }) => any): Promise<any>;
    withReadOnlySnapshot(fn: (adapter: LooseRecord) => any): Promise<any>;
    close(): Promise<void>;
    ensureSystemTable(): void;
    readSystemMetadata(key: string): Record<string, SQLOutputValue> | null;
    readSchemaMetadata(): Record<string, SQLOutputValue> | null;
    findFileBucket(ownerId: any, name: any): Record<string, SQLOutputValue> | null;
    createFileBucket(row: {
        id: any;
        ownerId: any;
        name: any;
        createdAt: any;
    }): StatementResultingChanges;
    insertFileRow(row: {
        id: any;
        ownerId: any;
        bucketId: any;
        bucketName: any;
        path: any;
        name: any;
        type: any;
        size: any;
        version: any;
        status: any;
        createdAt: any;
        updatedAt: any;
    }): StatementResultingChanges;
    updatePendingFileRow(row: {
        bucketId: any;
        bucketName: any;
        path: any;
        name: any;
        type: any;
        size: any;
        version: any;
        status: any;
        updatedAt: any;
        id: any;
    }): StatementResultingChanges;
    insertFileUpload(row: {
        id: any;
        fileId: any;
        ownerId: any;
        bucketId: any;
        bucketName: any;
        path: any;
        name: any;
        type: any;
        version: any;
        expectedSize: any;
        createdAt: any;
    }): StatementResultingChanges;
    selectFileById(fileId: any): Record<string, SQLOutputValue> | null;
    selectLiveFileByPath(path: any): Record<string, SQLOutputValue>[];
    selectActiveFileByPath(path: any): Record<string, SQLOutputValue>[];
    selectPendingFileUploadByPath(path: any): Record<string, SQLOutputValue> | null;
    selectFileUpload(uploadId: any): Record<string, SQLOutputValue> | null;
    completeFileUpload(upload: {
        id: any;
        fileId: any;
        version: any;
        bucketId: any;
        bucketName: any;
        path: any;
        name: any;
        type: any;
        ownerId: any;
        createdAt: any;
    }, size: any, updatedAt: any): StatementResultingChanges | {
        changes: number;
    };
    deleteFileUploadsForPath(path: any): StatementResultingChanges;
    deleteFileUploadsForFile(ownerId: any, fileId: any): StatementResultingChanges;
    deleteFileUpload(uploadId: any): StatementResultingChanges;
    selectPublicFileRow(publicUrlId: any): Record<string, SQLOutputValue> | null;
    insertPublicFileUrl(row: {
        id: any;
        fileId: any;
        ownerId: any;
        version: any;
        expiresAt: any;
        createdAt: any;
    }): StatementResultingChanges;
    revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): StatementResultingChanges;
    revokePublicFileUrlsForFile(fileId: any, revokedAt: any): StatementResultingChanges;
    markFileDeleted(fileId: any, deletedAt: any): StatementResultingChanges;
    fileRowForOwner(fileId: any, ownerId: any): Record<string, SQLOutputValue> | null;
    findAuthIdentityByProviderSubject(provider: any, subject: any): any;
    findLegacyAuthIdentitiesByProviderEmail(provider: any, email: any): any;
    insertAuthIdentity(row: {
        id: any;
        userId: any;
        provider: any;
        subject: any;
        email: any;
        displayName: any;
        picture: any;
        createdAt: any;
        updatedAt: any;
    }): StatementResultingChanges;
    updateAuthIdentity(row: {
        id: any;
        subject: any;
        email: any;
        displayName: any;
        picture: any;
        updatedAt: any;
    }): StatementResultingChanges;
    insertAuthUser(row: {
        id: any;
        createdAt: any;
        displayName: any;
        email: any;
        picture: any;
        isAuthenticated: any;
        isGuest: any;
        provider: any;
    }): StatementResultingChanges;
    updateAuthUserProfile(row: {
        displayName: any;
        picture: any;
        isAuthenticated: any;
        isGuest: any;
        id: any;
    }): StatementResultingChanges;
    linkAuthUser(row: {
        displayName: any;
        email: any;
        picture: any;
        isAuthenticated: any;
        isGuest: any;
        provider: any;
        id: any;
    }): StatementResultingChanges;
    insertAuthSession(row: {
        token: any;
        userId: any;
        provider: any;
        createdAt: any;
        expiresAt: any;
    }): StatementResultingChanges;
    deleteAuthSession(token: any): StatementResultingChanges;
    refreshAuthSession(token: any, expiresAt: any): StatementResultingChanges;
    setAuthSessionProvider(token: any, provider: any): StatementResultingChanges;
    rotateAuthSession(previousToken: any, row: {
        token: any;
        userId: any;
        provider: any;
        createdAt: any;
        expiresAt: any;
    }): StatementResultingChanges;
    readAuthSessionWithUser(token: any): Record<string, SQLOutputValue> | null;
    emailCredentialExists(email: any): boolean;
    insertEmailCredential(row: {
        email: any;
        userId: any;
        passwordHash: any;
        passwordSalt: any;
        createdAt: any;
    }): StatementResultingChanges;
    updateEmailCredentialPassword(email: any, passwordHash: any, passwordSalt: any): StatementResultingChanges;
    findEmailCredentialWithUser(email: any): Record<string, SQLOutputValue> | null;
    deleteAuthSessionsForUser(userId: any): StatementResultingChanges;
    insertPasswordResetCode(row: LooseRecord): StatementResultingChanges;
    findPasswordResetCode(selector: any): Record<string, SQLOutputValue> | null;
    countPasswordResetCodesForEmail(email: any, now: any): number;
    deletePasswordResetCodesForUser(userId: any): StatementResultingChanges;
    prunePasswordResetCodes(now: any): StatementResultingChanges;
    referenceExists(field: {
        targetTable: any;
    }, value: any): boolean;
    insertAppRow(table: {
        name: any;
    }, row: {
        [x: string]: any;
    }): StatementResultingChanges;
    selectAppRowById(table: {
        name: any;
    }, id: any): Record<string, SQLOutputValue> | null;
    updateAppRow(table: {
        name: any;
    }, id: any, values: {
        [x: string]: any;
    }, options?: LooseRecord): StatementResultingChanges | {
        changes: number;
    };
    deleteAppRow(table: {
        name: any;
    }, id: any): StatementResultingChanges;
    selectAppRows(table: {
        name: any;
    }, query?: LooseRecord): Record<string, SQLOutputValue>[];
}>;
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
    writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: LooseRecord): Promise<void>;
    ensureLogStorage(): Promise<void>;
    insertLogIndexEvent(event: {
        timestamp: any;
        category: any;
        event: any;
        level: any;
        message: any;
        capsule: {
            name: any;
            id: any;
        };
        release: {
            id: any;
        };
        request: {
            id: any;
        };
        correlation: {
            id: any;
        };
    }): Promise<void>;
    pruneLogIndex(limit: any): Promise<void>;
    readRecentLogEvents(limit?: number): Promise<any>;
    ensureFileStorage(): Promise<void>;
    ensureAuthStorage(authConfig?: any): Promise<void>;
    insertOAuthState(row: LooseRecord): Promise<{
        changes: number;
        lastInsertRowid: bigint | undefined;
    }>;
    consumeOAuthState(state: any): Promise<any>;
    migrateAppSchema(schema: {
        tables: {
            name: any;
            acl: {
                allowByDefault: boolean;
            } | {
                allowByDefault: boolean;
                resolve(operation: any): any;
            };
            fields: {
                name: any;
                kind: any;
                sqliteType: string;
                targetTable: string | undefined;
                defaultValue: any;
            }[];
        }[];
    } | {
        tables: {
            name: string;
            fields: ({
                name: any;
                kind: any;
                sqliteType: string;
                targetTable: any;
                defaultValue: any;
            } | null)[];
        }[];
    }): Promise<any>;
    migrateExistingAppTable(existingTable: any, nextTable: any): Promise<void>;
    listInspectableTables(): Promise<any>;
    dumpInspectableDatabase(): Promise<{
        name: any;
        columns: any;
        rows: any;
    }[]>;
    runReadOnlyInspectionQuery(sql: string | undefined): Promise<{
        ok: false;
        data: any;
        error: {
            message: string;
            hint: string;
        };
    } | {
        ok: boolean;
        data: {
            columns: any;
            rows: any;
        };
        error: any;
    } | {
        ok: boolean;
        data: null;
        error: {
            message: any;
            hint: string;
        };
    }>;
    checkHealth(): Promise<{
        ok: boolean;
    }>;
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
    ensureSystemTable(): void;
    readSystemMetadata(key: string): Record<string, SQLOutputValue> | null;
    writeSystemMetadata(key: string, value: any): StatementResultingChanges;
    readSchemaMetadata(): Record<string, SQLOutputValue> | null;
    findFileBucket(ownerId: any, name: any): Record<string, SQLOutputValue> | null;
    createFileBucket(row: {
        id: any;
        ownerId: any;
        name: any;
        createdAt: any;
    }): StatementResultingChanges;
    insertFileRow(row: {
        id: any;
        ownerId: any;
        bucketId: any;
        bucketName: any;
        path: any;
        name: any;
        type: any;
        size: any;
        version: any;
        status: any;
        createdAt: any;
        updatedAt: any;
    }): StatementResultingChanges;
    updatePendingFileRow(row: {
        bucketId: any;
        bucketName: any;
        path: any;
        name: any;
        type: any;
        size: any;
        version: any;
        status: any;
        updatedAt: any;
        id: any;
    }): StatementResultingChanges;
    insertFileUpload(row: {
        id: any;
        fileId: any;
        ownerId: any;
        bucketId: any;
        bucketName: any;
        path: any;
        name: any;
        type: any;
        version: any;
        expectedSize: any;
        createdAt: any;
    }): StatementResultingChanges;
    selectFileById(fileId: any): Record<string, SQLOutputValue> | null;
    selectLiveFileByPath(path: any): Record<string, SQLOutputValue>[];
    selectActiveFileByPath(path: any): Record<string, SQLOutputValue>[];
    selectPendingFileUploadByPath(path: any): Record<string, SQLOutputValue> | null;
    selectFileUpload(uploadId: any): Record<string, SQLOutputValue> | null;
    completeFileUpload(upload: {
        id: any;
        fileId: any;
        version: any;
        bucketId: any;
        bucketName: any;
        path: any;
        name: any;
        type: any;
        ownerId: any;
        createdAt: any;
    }, size: any, updatedAt: any): StatementResultingChanges | {
        changes: number;
    };
    deleteFileUploadsForPath(path: any): StatementResultingChanges;
    deleteFileUploadsForFile(ownerId: any, fileId: any): StatementResultingChanges;
    deleteFileUpload(uploadId: any): StatementResultingChanges;
    selectPublicFileRow(publicUrlId: any): Record<string, SQLOutputValue> | null;
    insertPublicFileUrl(row: {
        id: any;
        fileId: any;
        ownerId: any;
        version: any;
        expiresAt: any;
        createdAt: any;
    }): StatementResultingChanges;
    revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): StatementResultingChanges;
    revokePublicFileUrlsForFile(fileId: any, revokedAt: any): StatementResultingChanges;
    markFileDeleted(fileId: any, deletedAt: any): StatementResultingChanges;
    fileRowForOwner(fileId: any, ownerId: any): Record<string, SQLOutputValue> | null;
    ensureUserPreferencesStorage(): Promise<void>;
    readUserPreferences(userId: any): Record<string, SQLOutputValue> | null;
    saveUserPreferences(row: {
        userId: any;
        value: any;
        updatedAt: any;
    }): StatementResultingChanges;
    findAuthIdentityByProviderSubject(provider: any, subject: any): any;
    findLegacyAuthIdentitiesByProviderEmail(provider: any, email: any): any;
    insertAuthIdentity(row: {
        id: any;
        userId: any;
        provider: any;
        subject: any;
        email: any;
        displayName: any;
        picture: any;
        createdAt: any;
        updatedAt: any;
    }): StatementResultingChanges;
    updateAuthIdentity(row: {
        id: any;
        subject: any;
        email: any;
        displayName: any;
        picture: any;
        updatedAt: any;
    }): StatementResultingChanges;
    insertAuthUser(row: {
        id: any;
        createdAt: any;
        displayName: any;
        email: any;
        picture: any;
        isAuthenticated: any;
        isGuest: any;
        provider: any;
    }): StatementResultingChanges;
    updateAuthUserProfile(row: {
        displayName: any;
        picture: any;
        isAuthenticated: any;
        isGuest: any;
        id: any;
    }): StatementResultingChanges;
    linkAuthUser(row: {
        displayName: any;
        email: any;
        picture: any;
        isAuthenticated: any;
        isGuest: any;
        provider: any;
        id: any;
    }): StatementResultingChanges;
    insertAuthSession(row: {
        token: any;
        userId: any;
        provider: any;
        createdAt: any;
        expiresAt: any;
    }): StatementResultingChanges;
    deleteAuthSession(token: any): StatementResultingChanges;
    refreshAuthSession(token: any, expiresAt: any): StatementResultingChanges;
    setAuthSessionProvider(token: any, provider: any): StatementResultingChanges;
    rotateAuthSession(previousToken: any, row: {
        token: any;
        userId: any;
        provider: any;
        createdAt: any;
        expiresAt: any;
    }): StatementResultingChanges;
    readAuthSessionWithUser(token: any): Record<string, SQLOutputValue> | null;
    emailCredentialExists(email: any): boolean;
    insertEmailCredential(row: {
        email: any;
        userId: any;
        passwordHash: any;
        passwordSalt: any;
        createdAt: any;
    }): StatementResultingChanges;
    updateEmailCredentialPassword(email: any, passwordHash: any, passwordSalt: any): StatementResultingChanges;
    findEmailCredentialWithUser(email: any): Record<string, SQLOutputValue> | null;
    deleteAuthSessionsForUser(userId: any): StatementResultingChanges;
    insertPasswordResetCode(row: LooseRecord): StatementResultingChanges;
    findPasswordResetCode(selector: any): Record<string, SQLOutputValue> | null;
    countPasswordResetCodesForEmail(email: any, now: any): number;
    deletePasswordResetCodesForUser(userId: any): StatementResultingChanges;
    prunePasswordResetCodes(now: any): StatementResultingChanges;
    createAppTable(table: {
        name: any;
    }, tableName?: any): any;
    referenceExists(field: {
        targetTable: any;
    }, value: any): boolean;
    insertAppRow(table: {
        name: any;
    }, row: {
        [x: string]: any;
    }): StatementResultingChanges;
    selectAppRowById(table: {
        name: any;
    }, id: any): Record<string, SQLOutputValue> | null;
    updateAppRow(table: {
        name: any;
    }, id: any, values: {
        [x: string]: any;
    }, options?: LooseRecord): StatementResultingChanges | {
        changes: number;
    };
    deleteAppRow(table: {
        name: any;
    }, id: any): StatementResultingChanges;
    selectAppRows(table: {
        name: any;
    }, query?: LooseRecord): Record<string, SQLOutputValue>[];
}>;
export declare function createPrivilegedAuditLogInput(details?: LooseRecord): {
    category: string;
    event: string;
    level: any;
    message: string;
    data: {
        schema: string;
        actorKind: string;
        operation: string;
        surface: string;
        targetResourceKind: string;
        outcome: string;
        safeErrorCode: string | null;
        source: string;
        metadata: any;
    };
    request: any;
    release: any;
    correlation: any;
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
        acl: LooseRecord;
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
export declare function handleFileHttpRoute(database: LooseRecord, request: IncomingMessage, response: ServerResponse<IncomingMessage> & {
    req: IncomingMessage;
}, websocketHub?: any): Promise<boolean>;
export declare function routeRuntimeHealth(database: any, request: {
    url: string | URL;
    method: string;
    headers: {
        [x: string]: any;
    };
}, response: any): Promise<boolean>;
export declare function checkRuntimeSqlite(database: LooseRecord): Promise<any>;
export declare function checkRuntimeFileStorage(database: LooseRecord): Promise<any>;
export declare function createPendingFileUpload(database: LooseRecord, auth: LooseRecord, message: LooseRecord): Promise<any>;
export declare function completePendingFileUpload(database: LooseRecord, uploadId: string, request: any, websocketHub?: any): Promise<{
    ok: boolean;
    data: {
        file: {
            id: any;
            bucket: any;
            size: number;
            type: any;
            name: any;
            path: any;
            version: any;
        };
    };
    error: any;
} | {
    ok: boolean;
    data: null;
    error: {
        message: any;
        hint: any;
    };
}>;
export declare function getPrivateFileUrl(database: any, auth: LooseRecord, fileReference: any): Promise<any>;
export declare function createPublicFileUrl(database: LooseRecord, auth: LooseRecord, fileReference: any, options?: LooseRecord): Promise<any>;
export declare function deletePrivateFile(database: LooseRecord, auth: LooseRecord, fileReference: any): Promise<any>;
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
export declare function validateReadOnlyInspectionSql(sql: any): {
    ok: false;
    data: any;
    error: {
        message: string;
        hint: string;
    };
} | {
    ok: true;
};
export declare function simulateLocalIdentitySession(database: LooseRecord, options?: LooseRecord): Promise<any>;
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
export declare function routeSporadesAuth(database: LooseRecord, request: IncomingMessage, response: ServerResponse<IncomingMessage> & {
    req: IncomingMessage;
}): Promise<boolean>;
export declare function createEmailPasswordResetLink(database: LooseRecord, _session: LooseRecord, email: string): Promise<{
    ok: boolean;
    error: {
        message: string;
        hint: string;
    };
    link?: undefined;
    expiresAt?: undefined;
} | {
    ok: boolean;
    link: string;
    expiresAt: string;
    error?: undefined;
}>;
export declare function verifyPasswordResetCode(database: LooseRecord, _session: LooseRecord, code: any): Promise<{
    ok: boolean;
    error: {
        message: string;
        hint: string;
    };
    email?: undefined;
} | {
    ok: boolean;
    email: any;
    error?: undefined;
}>;
export declare function confirmPasswordReset(database: LooseRecord, _session: LooseRecord, code: any, newPassword: string): Promise<any>;
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
export declare function setOwnEmailPassword(database: LooseRecord, session: LooseRecord, email: string, newPassword: string): Promise<{
    ok: boolean;
    error: {
        message: string;
        hint: string;
    };
} | {
    ok: boolean;
    error?: undefined;
} | {
    ok: boolean;
    error: {
        code: any;
        message: any;
        hint: any;
    };
}>;
export declare function setEmailPassword(database: LooseRecord, _session: LooseRecord, email: string, newPassword: string): Promise<{
    ok: boolean;
    error: {
        message: string;
        hint: string;
    };
} | {
    ok: boolean;
    error?: undefined;
}>;
export declare function signUpWithEmail(database: LooseRecord, session: LooseRecord, provider: string, credentials: any): Promise<any>;
export declare function signInWithEmail(database: LooseRecord, session: any, credentials: any): Promise<any>;
export declare function resolveAnonymousSession(database: LooseRecord, sessionToken: string | null): Promise<{
    token: any;
    auth: {
        userId: any;
        displayName: any;
        email: any;
        picture: any;
        isAuthenticated: boolean;
        isGuest: boolean;
        provider: any;
    };
}>;
export declare function updateCurrentUserPreferences(database: LooseRecord, auth: LooseRecord, patch: any): Promise<{
    ok: boolean;
    data: {
        preferences: any;
    };
    changes: any;
    error: null;
} | {
    ok: boolean;
    data: null;
    error: any;
    changes?: undefined;
}>;
export declare function runQuery(database: LooseRecord, auth: any, queryName: string): Promise<any>;
export declare function runMutation(database: LooseRecord, auth: any, mutationName: string, args: any): Promise<any>;
/** Read the bounded operator view of every Job in one adapter snapshot. */
export declare function inspectRuntimeJobs(adapter: LooseRecord): Promise<any>;
/** Read the bounded operator view of every Schedule in one adapter snapshot. */
export declare function inspectRuntimeSchedules(adapter: LooseRecord): Promise<any>;
export {};
//# sourceMappingURL=server-runtime-source.d.ts.map