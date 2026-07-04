export declare const SERVER_RUNTIME_SOURCE_FUNCTIONS: (typeof resolveRuntimeSecurityPolicy | typeof createRuntimeDatabaseAdapter | typeof postgresInterpolate | typeof logPayloadMaxBytes | typeof completePendingFileUpload | typeof runAppMessage | typeof createPublicFileUrl | typeof openDevDatabase | typeof readRecentLogEvents | typeof isInternalLogIndexMetadataRow | typeof createAppTable | typeof createEndpointTableApi | typeof runTableWriteWithAcl | typeof createAclDeniedError | typeof handleFileHttpRoute | typeof sessionExpiresAt)[];
export declare function readJsonRequest(request: any): Promise<any>;
export declare function prepareHttpSecurity(database: any, request: any, response: any): boolean;
declare function resolveRuntimeSecurityPolicy(config?: {}): {
    cors: {
        sameOrigin: boolean;
        publicDev: boolean;
        allowedOrigins: any;
        allowedOriginPatterns: string[];
        requireExplicitCrossOrigin: boolean;
    };
    csp: {
        mode: string;
        header: string;
        directives: any;
    };
};
export declare function openDevDatabase(databasePath: any, serverSource: any, serverEnv?: {}, config?: {}, capsuleDefinition?: any, options?: {}): Promise<{
    adapter: {
        engine: string;
        exec(sql: any): void;
        prepare(sql: any): {
            all(...params: any[]): Record<string, import("node:sqlite").SQLOutputValue>[];
            get(...params: any[]): Record<string, import("node:sqlite").SQLOutputValue>;
            run(...params: any[]): import("node:sqlite").StatementResultingChanges;
            columns(): import("node:sqlite").StatementColumnMetadata[];
        };
        ensureSystemTable(): any;
        readSystemMetadata(key: any): any;
        writeSystemMetadata(key: any, value: any): any;
        readSchemaMetadata(): any;
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
        findFileBucket(ownerId: any, name: any): any;
        createFileBucket(row: any): any;
        insertFileRow(row: any): any;
        updatePendingFileRow(row: any): any;
        insertFileUpload(row: any): any;
        selectFileById(fileId: any): any;
        selectLiveFileByPath(ownerId: any, path: any): any;
        selectActiveFileByPath(ownerId: any, path: any): any;
        selectPendingFileUploadByPath(ownerId: any, path: any): any;
        selectFileUpload(uploadId: any): any;
        completeFileUpload(upload: any, size: any, updatedAt: any): any;
        deleteFileUploadsForPath(ownerId: any, path: any): any;
        deleteFileUploadsForFile(ownerId: any, fileId: any): any;
        deleteFileUpload(uploadId: any): any;
        selectPublicFileRow(publicUrlId: any): any;
        insertPublicFileUrl(row: any): any;
        revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): any;
        revokePublicFileUrlsForFile(fileId: any, revokedAt: any): any;
        markFileDeleted(fileId: any, deletedAt: any): any;
        fileRowForOwner(fileId: any, ownerId: any): any;
        ensureAuthStorage(authConfig?: any): void;
        findAuthUserByProviderEmail(provider: any, email: any): any;
        insertAuthUser(row: any): any;
        updateAuthUserProfile(row: any): any;
        linkAuthUser(row: any): any;
        insertAuthSession(row: any): any;
        deleteAuthSession(token: any): any;
        refreshAuthSession(token: any, expiresAt: any): any;
        rotateAuthSession(previousToken: any, row: any): any;
        readAuthSessionWithUser(token: any): any;
        insertOAuthState(row: any): any;
        consumeOAuthState(state: any): any;
        emailCredentialExists(email: any): boolean;
        insertEmailCredential(row: any): any;
        findEmailCredentialWithUser(email: any): any;
        migrateAppSchema(schema: any): any;
        createAppTable(table: any, tableName?: any): any;
        migrateExistingAppTable(existingTable: any, nextTable: any): any;
        referenceExists(field: any, value: any): boolean;
        withTransaction(fn: any): Promise<any>;
        insertAppRow(table: any, row: any): any;
        selectAppRowById(table: any, id: any): any;
        updateAppRow(table: any, id: any, values: any, options?: {}): any;
        deleteAppRow(table: any, id: any): any;
        selectAppRows(table: any, query?: {}): any;
        listInspectableTables(): any;
        dumpInspectableDatabase(): any;
        runReadOnlyInspectionQuery(sql: any): {
            ok: boolean;
            data: {
                columns: any;
                rows: any;
            };
            error: any;
        } | {
            ok: boolean;
            data: any;
            error: {
                message: any;
                hint: string;
            };
        };
        checkHealth(): {
            ok: boolean;
        };
        close(): void;
    } | {
        engine: string;
        writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: {
            schemaVersion: any;
            schemaHash: any;
            schemaJson: any;
        }): Promise<void>;
        ensureLogStorage(): Promise<void>;
        insertLogIndexEvent(event: any): Promise<void>;
        pruneLogIndex(limit: any): Promise<void>;
        readRecentLogEvents(limit?: number): Promise<any>;
        ensureFileStorage(): Promise<void>;
        ensureAuthStorage(authConfig?: any): Promise<void>;
        consumeOAuthState(state: any): Promise<any>;
        migrateAppSchema(schema: any): Promise<void>;
        migrateExistingAppTable(existingTable: any, nextTable: any): Promise<void>;
        listInspectableTables(): Promise<any>;
        dumpInspectableDatabase(): Promise<any[]>;
        runReadOnlyInspectionQuery(sql: any): Promise<{
            ok: boolean;
            data: {
                columns: any;
                rows: any;
            };
            error: any;
        } | {
            ok: boolean;
            data: any;
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
        exec(sql: any): Promise<any>;
        prepare(sql: any): {
            all(...params: any[]): Promise<any>;
            get(...params: any[]): any;
            run(...params: any[]): Promise<{
                changes: number;
                lastInsertRowid: bigint;
            }>;
            columns(): Promise<any>;
        };
        ensureSystemTable(): any;
        readSystemMetadata(key: any): any;
        writeSystemMetadata(key: any, value: any): any;
        readSchemaMetadata(): any;
        findFileBucket(ownerId: any, name: any): any;
        createFileBucket(row: any): any;
        insertFileRow(row: any): any;
        updatePendingFileRow(row: any): any;
        insertFileUpload(row: any): any;
        selectFileById(fileId: any): any;
        selectLiveFileByPath(ownerId: any, path: any): any;
        selectActiveFileByPath(ownerId: any, path: any): any;
        selectPendingFileUploadByPath(ownerId: any, path: any): any;
        selectFileUpload(uploadId: any): any;
        completeFileUpload(upload: any, size: any, updatedAt: any): any;
        deleteFileUploadsForPath(ownerId: any, path: any): any;
        deleteFileUploadsForFile(ownerId: any, fileId: any): any;
        deleteFileUpload(uploadId: any): any;
        selectPublicFileRow(publicUrlId: any): any;
        insertPublicFileUrl(row: any): any;
        revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): any;
        revokePublicFileUrlsForFile(fileId: any, revokedAt: any): any;
        markFileDeleted(fileId: any, deletedAt: any): any;
        fileRowForOwner(fileId: any, ownerId: any): any;
        findAuthUserByProviderEmail(provider: any, email: any): any;
        insertAuthUser(row: any): any;
        updateAuthUserProfile(row: any): any;
        linkAuthUser(row: any): any;
        insertAuthSession(row: any): any;
        deleteAuthSession(token: any): any;
        refreshAuthSession(token: any, expiresAt: any): any;
        rotateAuthSession(previousToken: any, row: any): any;
        readAuthSessionWithUser(token: any): any;
        insertOAuthState(row: any): any;
        emailCredentialExists(email: any): boolean;
        insertEmailCredential(row: any): any;
        findEmailCredentialWithUser(email: any): any;
        createAppTable(table: any, tableName?: any): any;
        referenceExists(field: any, value: any): boolean;
        insertAppRow(table: any, row: any): any;
        selectAppRowById(table: any, id: any): any;
        updateAppRow(table: any, id: any, values: any, options?: {}): any;
        deleteAppRow(table: any, id: any): any;
        selectAppRows(table: any, query?: {}): any;
    } | {
        engine: string;
        exec(sql: any): Promise<any>;
        prepare(sql: any): {
            all(...params: any[]): Promise<any>;
            get(...params: any[]): any;
            run(...params: any[]): Promise<{
                changes: number;
                lastInsertRowid: any;
            }>;
            columns(): Promise<{
                name: any;
            }[]>;
        };
        writeSystemMetadata(keyOrMetadata: any, maybeValue: any): Promise<any>;
        writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: {
            schemaVersion: any;
            schemaHash: any;
            schemaJson: any;
        }): Promise<void>;
        ensureAuthStorage(authConfig?: any): Promise<void>;
        ensureLogStorage(): Promise<void>;
        ensureFileStorage(): Promise<void>;
        insertLogIndexEvent(event: any): Promise<void>;
        pruneLogIndex(limit: any): Promise<void>;
        readRecentLogEvents(limit?: number): Promise<any>;
        migrateAppSchema(schema: any): Promise<void>;
        createAppTable(table: any, tableName?: any): Promise<void>;
        migrateExistingAppTable(existingTable: any, nextTable: any): Promise<void>;
        listInspectableTables(): Promise<any>;
        dumpInspectableDatabase(): Promise<any[]>;
        runReadOnlyInspectionQuery(sql: any): Promise<{
            ok: boolean;
            data: {
                columns: any[];
                rows: any;
            };
            error: any;
        } | {
            ok: boolean;
            data: any;
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
        ensureSystemTable(): any;
        readSystemMetadata(key: any): any;
        readSchemaMetadata(): any;
        findFileBucket(ownerId: any, name: any): any;
        createFileBucket(row: any): any;
        insertFileRow(row: any): any;
        updatePendingFileRow(row: any): any;
        insertFileUpload(row: any): any;
        selectFileById(fileId: any): any;
        selectLiveFileByPath(ownerId: any, path: any): any;
        selectActiveFileByPath(ownerId: any, path: any): any;
        selectPendingFileUploadByPath(ownerId: any, path: any): any;
        selectFileUpload(uploadId: any): any;
        completeFileUpload(upload: any, size: any, updatedAt: any): any;
        deleteFileUploadsForPath(ownerId: any, path: any): any;
        deleteFileUploadsForFile(ownerId: any, fileId: any): any;
        deleteFileUpload(uploadId: any): any;
        selectPublicFileRow(publicUrlId: any): any;
        insertPublicFileUrl(row: any): any;
        revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): any;
        revokePublicFileUrlsForFile(fileId: any, revokedAt: any): any;
        markFileDeleted(fileId: any, deletedAt: any): any;
        fileRowForOwner(fileId: any, ownerId: any): any;
        findAuthUserByProviderEmail(provider: any, email: any): any;
        insertAuthUser(row: any): any;
        updateAuthUserProfile(row: any): any;
        linkAuthUser(row: any): any;
        insertAuthSession(row: any): any;
        deleteAuthSession(token: any): any;
        refreshAuthSession(token: any, expiresAt: any): any;
        rotateAuthSession(previousToken: any, row: any): any;
        readAuthSessionWithUser(token: any): any;
        insertOAuthState(row: any): any;
        consumeOAuthState(state: any): any;
        emailCredentialExists(email: any): boolean;
        insertEmailCredential(row: any): any;
        findEmailCredentialWithUser(email: any): any;
        referenceExists(field: any, value: any): boolean;
        insertAppRow(table: any, row: any): any;
        selectAppRowById(table: any, id: any): any;
        updateAppRow(table: any, id: any, values: any, options?: {}): any;
        deleteAppRow(table: any, id: any): any;
        selectAppRows(table: any, query?: {}): any;
    };
    sqlite: {
        engine: string;
        exec(sql: any): void;
        prepare(sql: any): {
            all(...params: any[]): Record<string, import("node:sqlite").SQLOutputValue>[];
            get(...params: any[]): Record<string, import("node:sqlite").SQLOutputValue>;
            run(...params: any[]): import("node:sqlite").StatementResultingChanges;
            columns(): import("node:sqlite").StatementColumnMetadata[];
        };
        ensureSystemTable(): any;
        readSystemMetadata(key: any): any;
        writeSystemMetadata(key: any, value: any): any;
        readSchemaMetadata(): any;
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
        findFileBucket(ownerId: any, name: any): any;
        createFileBucket(row: any): any;
        insertFileRow(row: any): any;
        updatePendingFileRow(row: any): any;
        insertFileUpload(row: any): any;
        selectFileById(fileId: any): any;
        selectLiveFileByPath(ownerId: any, path: any): any;
        selectActiveFileByPath(ownerId: any, path: any): any;
        selectPendingFileUploadByPath(ownerId: any, path: any): any;
        selectFileUpload(uploadId: any): any;
        completeFileUpload(upload: any, size: any, updatedAt: any): any;
        deleteFileUploadsForPath(ownerId: any, path: any): any;
        deleteFileUploadsForFile(ownerId: any, fileId: any): any;
        deleteFileUpload(uploadId: any): any;
        selectPublicFileRow(publicUrlId: any): any;
        insertPublicFileUrl(row: any): any;
        revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): any;
        revokePublicFileUrlsForFile(fileId: any, revokedAt: any): any;
        markFileDeleted(fileId: any, deletedAt: any): any;
        fileRowForOwner(fileId: any, ownerId: any): any;
        ensureAuthStorage(authConfig?: any): void;
        findAuthUserByProviderEmail(provider: any, email: any): any;
        insertAuthUser(row: any): any;
        updateAuthUserProfile(row: any): any;
        linkAuthUser(row: any): any;
        insertAuthSession(row: any): any;
        deleteAuthSession(token: any): any;
        refreshAuthSession(token: any, expiresAt: any): any;
        rotateAuthSession(previousToken: any, row: any): any;
        readAuthSessionWithUser(token: any): any;
        insertOAuthState(row: any): any;
        consumeOAuthState(state: any): any;
        emailCredentialExists(email: any): boolean;
        insertEmailCredential(row: any): any;
        findEmailCredentialWithUser(email: any): any;
        migrateAppSchema(schema: any): any;
        createAppTable(table: any, tableName?: any): any;
        migrateExistingAppTable(existingTable: any, nextTable: any): any;
        referenceExists(field: any, value: any): boolean;
        withTransaction(fn: any): Promise<any>;
        insertAppRow(table: any, row: any): any;
        selectAppRowById(table: any, id: any): any;
        updateAppRow(table: any, id: any, values: any, options?: {}): any;
        deleteAppRow(table: any, id: any): any;
        selectAppRows(table: any, query?: {}): any;
        listInspectableTables(): any;
        dumpInspectableDatabase(): any;
        runReadOnlyInspectionQuery(sql: any): {
            ok: boolean;
            data: {
                columns: any;
                rows: any;
            };
            error: any;
        } | {
            ok: boolean;
            data: any;
            error: {
                message: any;
                hint: string;
            };
        };
        checkHealth(): {
            ok: boolean;
        };
        close(): void;
    } | {
        engine: string;
        writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: {
            schemaVersion: any;
            schemaHash: any;
            schemaJson: any;
        }): Promise<void>;
        ensureLogStorage(): Promise<void>;
        insertLogIndexEvent(event: any): Promise<void>;
        pruneLogIndex(limit: any): Promise<void>;
        readRecentLogEvents(limit?: number): Promise<any>;
        ensureFileStorage(): Promise<void>;
        ensureAuthStorage(authConfig?: any): Promise<void>;
        consumeOAuthState(state: any): Promise<any>;
        migrateAppSchema(schema: any): Promise<void>;
        migrateExistingAppTable(existingTable: any, nextTable: any): Promise<void>;
        listInspectableTables(): Promise<any>;
        dumpInspectableDatabase(): Promise<any[]>;
        runReadOnlyInspectionQuery(sql: any): Promise<{
            ok: boolean;
            data: {
                columns: any;
                rows: any;
            };
            error: any;
        } | {
            ok: boolean;
            data: any;
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
        exec(sql: any): Promise<any>;
        prepare(sql: any): {
            all(...params: any[]): Promise<any>;
            get(...params: any[]): any;
            run(...params: any[]): Promise<{
                changes: number;
                lastInsertRowid: bigint;
            }>;
            columns(): Promise<any>;
        };
        ensureSystemTable(): any;
        readSystemMetadata(key: any): any;
        writeSystemMetadata(key: any, value: any): any;
        readSchemaMetadata(): any;
        findFileBucket(ownerId: any, name: any): any;
        createFileBucket(row: any): any;
        insertFileRow(row: any): any;
        updatePendingFileRow(row: any): any;
        insertFileUpload(row: any): any;
        selectFileById(fileId: any): any;
        selectLiveFileByPath(ownerId: any, path: any): any;
        selectActiveFileByPath(ownerId: any, path: any): any;
        selectPendingFileUploadByPath(ownerId: any, path: any): any;
        selectFileUpload(uploadId: any): any;
        completeFileUpload(upload: any, size: any, updatedAt: any): any;
        deleteFileUploadsForPath(ownerId: any, path: any): any;
        deleteFileUploadsForFile(ownerId: any, fileId: any): any;
        deleteFileUpload(uploadId: any): any;
        selectPublicFileRow(publicUrlId: any): any;
        insertPublicFileUrl(row: any): any;
        revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): any;
        revokePublicFileUrlsForFile(fileId: any, revokedAt: any): any;
        markFileDeleted(fileId: any, deletedAt: any): any;
        fileRowForOwner(fileId: any, ownerId: any): any;
        findAuthUserByProviderEmail(provider: any, email: any): any;
        insertAuthUser(row: any): any;
        updateAuthUserProfile(row: any): any;
        linkAuthUser(row: any): any;
        insertAuthSession(row: any): any;
        deleteAuthSession(token: any): any;
        refreshAuthSession(token: any, expiresAt: any): any;
        rotateAuthSession(previousToken: any, row: any): any;
        readAuthSessionWithUser(token: any): any;
        insertOAuthState(row: any): any;
        emailCredentialExists(email: any): boolean;
        insertEmailCredential(row: any): any;
        findEmailCredentialWithUser(email: any): any;
        createAppTable(table: any, tableName?: any): any;
        referenceExists(field: any, value: any): boolean;
        insertAppRow(table: any, row: any): any;
        selectAppRowById(table: any, id: any): any;
        updateAppRow(table: any, id: any, values: any, options?: {}): any;
        deleteAppRow(table: any, id: any): any;
        selectAppRows(table: any, query?: {}): any;
    } | {
        engine: string;
        exec(sql: any): Promise<any>;
        prepare(sql: any): {
            all(...params: any[]): Promise<any>;
            get(...params: any[]): any;
            run(...params: any[]): Promise<{
                changes: number;
                lastInsertRowid: any;
            }>;
            columns(): Promise<{
                name: any;
            }[]>;
        };
        writeSystemMetadata(keyOrMetadata: any, maybeValue: any): Promise<any>;
        writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: {
            schemaVersion: any;
            schemaHash: any;
            schemaJson: any;
        }): Promise<void>;
        ensureAuthStorage(authConfig?: any): Promise<void>;
        ensureLogStorage(): Promise<void>;
        ensureFileStorage(): Promise<void>;
        insertLogIndexEvent(event: any): Promise<void>;
        pruneLogIndex(limit: any): Promise<void>;
        readRecentLogEvents(limit?: number): Promise<any>;
        migrateAppSchema(schema: any): Promise<void>;
        createAppTable(table: any, tableName?: any): Promise<void>;
        migrateExistingAppTable(existingTable: any, nextTable: any): Promise<void>;
        listInspectableTables(): Promise<any>;
        dumpInspectableDatabase(): Promise<any[]>;
        runReadOnlyInspectionQuery(sql: any): Promise<{
            ok: boolean;
            data: {
                columns: any[];
                rows: any;
            };
            error: any;
        } | {
            ok: boolean;
            data: any;
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
        ensureSystemTable(): any;
        readSystemMetadata(key: any): any;
        readSchemaMetadata(): any;
        findFileBucket(ownerId: any, name: any): any;
        createFileBucket(row: any): any;
        insertFileRow(row: any): any;
        updatePendingFileRow(row: any): any;
        insertFileUpload(row: any): any;
        selectFileById(fileId: any): any;
        selectLiveFileByPath(ownerId: any, path: any): any;
        selectActiveFileByPath(ownerId: any, path: any): any;
        selectPendingFileUploadByPath(ownerId: any, path: any): any;
        selectFileUpload(uploadId: any): any;
        completeFileUpload(upload: any, size: any, updatedAt: any): any;
        deleteFileUploadsForPath(ownerId: any, path: any): any;
        deleteFileUploadsForFile(ownerId: any, fileId: any): any;
        deleteFileUpload(uploadId: any): any;
        selectPublicFileRow(publicUrlId: any): any;
        insertPublicFileUrl(row: any): any;
        revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): any;
        revokePublicFileUrlsForFile(fileId: any, revokedAt: any): any;
        markFileDeleted(fileId: any, deletedAt: any): any;
        fileRowForOwner(fileId: any, ownerId: any): any;
        findAuthUserByProviderEmail(provider: any, email: any): any;
        insertAuthUser(row: any): any;
        updateAuthUserProfile(row: any): any;
        linkAuthUser(row: any): any;
        insertAuthSession(row: any): any;
        deleteAuthSession(token: any): any;
        refreshAuthSession(token: any, expiresAt: any): any;
        rotateAuthSession(previousToken: any, row: any): any;
        readAuthSessionWithUser(token: any): any;
        insertOAuthState(row: any): any;
        consumeOAuthState(state: any): any;
        emailCredentialExists(email: any): boolean;
        insertEmailCredential(row: any): any;
        findEmailCredentialWithUser(email: any): any;
        referenceExists(field: any, value: any): boolean;
        insertAppRow(table: any, row: any): any;
        selectAppRowById(table: any, id: any): any;
        updateAppRow(table: any, id: any, values: any, options?: {}): any;
        deleteAppRow(table: any, id: any): any;
        selectAppRows(table: any, query?: {}): any;
    };
    schema: {
        tables: any[];
    };
    endpoints: any[];
    queries: any[];
    mutations: any[];
    messages: any[];
    contextMiddleware: any[];
    mutationHooks: {
        beforeMutation: any[];
        afterMutation: any[];
    };
    rowCache: Map<any, any>;
    serverEnv: {};
    authConfig: {
        mode: any;
        providers: {
            anonymous: {
                enabled: boolean;
            };
            google: {
                enabled: boolean;
                configured: boolean;
                clientIdEnv: any;
                clientSecretEnv: any;
            };
        };
        google: {
            configured: boolean;
            clientIdEnv: any;
            clientSecretEnv: any;
        };
    };
    securityPolicy: {
        cors: {
            sameOrigin: boolean;
            publicDev: boolean;
            allowedOrigins: any;
            allowedOriginPatterns: string[];
            requireExplicitCrossOrigin: boolean;
        };
        csp: {
            mode: string;
            header: string;
            directives: any;
        };
    };
    fileStorage: {
        engine: string;
        storagePath: string;
        writeFileVersion({ fileId, version, bytes }: {
            fileId: any;
            version: any;
            bytes: any;
        }): Promise<void>;
        readFileVersion({ fileId, version }: {
            fileId: any;
            version: any;
        }): Promise<NonSharedBuffer>;
        deleteFileVersion({ fileId, version }: {
            fileId: any;
            version: any;
        }): Promise<void>;
        checkHealth(): Promise<{
            ok: boolean;
        }>;
        close(): void;
    };
    fileMaxSizeBytes: any;
    close: () => void | Promise<void>;
}>;
declare function createRuntimeDatabaseAdapter(databasePath: any, serverEnv?: {}, config?: {}): Promise<{
    engine: string;
    exec(sql: any): void;
    prepare(sql: any): {
        all(...params: any[]): Record<string, import("node:sqlite").SQLOutputValue>[];
        get(...params: any[]): Record<string, import("node:sqlite").SQLOutputValue>;
        run(...params: any[]): import("node:sqlite").StatementResultingChanges;
        columns(): import("node:sqlite").StatementColumnMetadata[];
    };
    ensureSystemTable(): any;
    readSystemMetadata(key: any): any;
    writeSystemMetadata(key: any, value: any): any;
    readSchemaMetadata(): any;
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
    findFileBucket(ownerId: any, name: any): any;
    createFileBucket(row: any): any;
    insertFileRow(row: any): any;
    updatePendingFileRow(row: any): any;
    insertFileUpload(row: any): any;
    selectFileById(fileId: any): any;
    selectLiveFileByPath(ownerId: any, path: any): any;
    selectActiveFileByPath(ownerId: any, path: any): any;
    selectPendingFileUploadByPath(ownerId: any, path: any): any;
    selectFileUpload(uploadId: any): any;
    completeFileUpload(upload: any, size: any, updatedAt: any): any;
    deleteFileUploadsForPath(ownerId: any, path: any): any;
    deleteFileUploadsForFile(ownerId: any, fileId: any): any;
    deleteFileUpload(uploadId: any): any;
    selectPublicFileRow(publicUrlId: any): any;
    insertPublicFileUrl(row: any): any;
    revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): any;
    revokePublicFileUrlsForFile(fileId: any, revokedAt: any): any;
    markFileDeleted(fileId: any, deletedAt: any): any;
    fileRowForOwner(fileId: any, ownerId: any): any;
    ensureAuthStorage(authConfig?: any): void;
    findAuthUserByProviderEmail(provider: any, email: any): any;
    insertAuthUser(row: any): any;
    updateAuthUserProfile(row: any): any;
    linkAuthUser(row: any): any;
    insertAuthSession(row: any): any;
    deleteAuthSession(token: any): any;
    refreshAuthSession(token: any, expiresAt: any): any;
    rotateAuthSession(previousToken: any, row: any): any;
    readAuthSessionWithUser(token: any): any;
    insertOAuthState(row: any): any;
    consumeOAuthState(state: any): any;
    emailCredentialExists(email: any): boolean;
    insertEmailCredential(row: any): any;
    findEmailCredentialWithUser(email: any): any;
    migrateAppSchema(schema: any): any;
    createAppTable(table: any, tableName?: any): any;
    migrateExistingAppTable(existingTable: any, nextTable: any): any;
    referenceExists(field: any, value: any): boolean;
    withTransaction(fn: any): Promise<any>;
    insertAppRow(table: any, row: any): any;
    selectAppRowById(table: any, id: any): any;
    updateAppRow(table: any, id: any, values: any, options?: {}): any;
    deleteAppRow(table: any, id: any): any;
    selectAppRows(table: any, query?: {}): any;
    listInspectableTables(): any;
    dumpInspectableDatabase(): any;
    runReadOnlyInspectionQuery(sql: any): {
        ok: boolean;
        data: {
            columns: any;
            rows: any;
        };
        error: any;
    } | {
        ok: boolean;
        data: any;
        error: {
            message: any;
            hint: string;
        };
    };
    checkHealth(): {
        ok: boolean;
    };
    close(): void;
} | {
    engine: string;
    writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: {
        schemaVersion: any;
        schemaHash: any;
        schemaJson: any;
    }): Promise<void>;
    ensureLogStorage(): Promise<void>;
    insertLogIndexEvent(event: any): Promise<void>;
    pruneLogIndex(limit: any): Promise<void>;
    readRecentLogEvents(limit?: number): Promise<any>;
    ensureFileStorage(): Promise<void>;
    ensureAuthStorage(authConfig?: any): Promise<void>;
    consumeOAuthState(state: any): Promise<any>;
    migrateAppSchema(schema: any): Promise<void>;
    migrateExistingAppTable(existingTable: any, nextTable: any): Promise<void>;
    listInspectableTables(): Promise<any>;
    dumpInspectableDatabase(): Promise<any[]>;
    runReadOnlyInspectionQuery(sql: any): Promise<{
        ok: boolean;
        data: {
            columns: any;
            rows: any;
        };
        error: any;
    } | {
        ok: boolean;
        data: any;
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
    exec(sql: any): Promise<any>;
    prepare(sql: any): {
        all(...params: any[]): Promise<any>;
        get(...params: any[]): any;
        run(...params: any[]): Promise<{
            changes: number;
            lastInsertRowid: bigint;
        }>;
        columns(): Promise<any>;
    };
    ensureSystemTable(): any;
    readSystemMetadata(key: any): any;
    writeSystemMetadata(key: any, value: any): any;
    readSchemaMetadata(): any;
    findFileBucket(ownerId: any, name: any): any;
    createFileBucket(row: any): any;
    insertFileRow(row: any): any;
    updatePendingFileRow(row: any): any;
    insertFileUpload(row: any): any;
    selectFileById(fileId: any): any;
    selectLiveFileByPath(ownerId: any, path: any): any;
    selectActiveFileByPath(ownerId: any, path: any): any;
    selectPendingFileUploadByPath(ownerId: any, path: any): any;
    selectFileUpload(uploadId: any): any;
    completeFileUpload(upload: any, size: any, updatedAt: any): any;
    deleteFileUploadsForPath(ownerId: any, path: any): any;
    deleteFileUploadsForFile(ownerId: any, fileId: any): any;
    deleteFileUpload(uploadId: any): any;
    selectPublicFileRow(publicUrlId: any): any;
    insertPublicFileUrl(row: any): any;
    revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): any;
    revokePublicFileUrlsForFile(fileId: any, revokedAt: any): any;
    markFileDeleted(fileId: any, deletedAt: any): any;
    fileRowForOwner(fileId: any, ownerId: any): any;
    findAuthUserByProviderEmail(provider: any, email: any): any;
    insertAuthUser(row: any): any;
    updateAuthUserProfile(row: any): any;
    linkAuthUser(row: any): any;
    insertAuthSession(row: any): any;
    deleteAuthSession(token: any): any;
    refreshAuthSession(token: any, expiresAt: any): any;
    rotateAuthSession(previousToken: any, row: any): any;
    readAuthSessionWithUser(token: any): any;
    insertOAuthState(row: any): any;
    emailCredentialExists(email: any): boolean;
    insertEmailCredential(row: any): any;
    findEmailCredentialWithUser(email: any): any;
    createAppTable(table: any, tableName?: any): any;
    referenceExists(field: any, value: any): boolean;
    insertAppRow(table: any, row: any): any;
    selectAppRowById(table: any, id: any): any;
    updateAppRow(table: any, id: any, values: any, options?: {}): any;
    deleteAppRow(table: any, id: any): any;
    selectAppRows(table: any, query?: {}): any;
} | {
    engine: string;
    exec(sql: any): Promise<any>;
    prepare(sql: any): {
        all(...params: any[]): Promise<any>;
        get(...params: any[]): any;
        run(...params: any[]): Promise<{
            changes: number;
            lastInsertRowid: any;
        }>;
        columns(): Promise<{
            name: any;
        }[]>;
    };
    writeSystemMetadata(keyOrMetadata: any, maybeValue: any): Promise<any>;
    writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: {
        schemaVersion: any;
        schemaHash: any;
        schemaJson: any;
    }): Promise<void>;
    ensureAuthStorage(authConfig?: any): Promise<void>;
    ensureLogStorage(): Promise<void>;
    ensureFileStorage(): Promise<void>;
    insertLogIndexEvent(event: any): Promise<void>;
    pruneLogIndex(limit: any): Promise<void>;
    readRecentLogEvents(limit?: number): Promise<any>;
    migrateAppSchema(schema: any): Promise<void>;
    createAppTable(table: any, tableName?: any): Promise<void>;
    migrateExistingAppTable(existingTable: any, nextTable: any): Promise<void>;
    listInspectableTables(): Promise<any>;
    dumpInspectableDatabase(): Promise<any[]>;
    runReadOnlyInspectionQuery(sql: any): Promise<{
        ok: boolean;
        data: {
            columns: any[];
            rows: any;
        };
        error: any;
    } | {
        ok: boolean;
        data: any;
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
    ensureSystemTable(): any;
    readSystemMetadata(key: any): any;
    readSchemaMetadata(): any;
    findFileBucket(ownerId: any, name: any): any;
    createFileBucket(row: any): any;
    insertFileRow(row: any): any;
    updatePendingFileRow(row: any): any;
    insertFileUpload(row: any): any;
    selectFileById(fileId: any): any;
    selectLiveFileByPath(ownerId: any, path: any): any;
    selectActiveFileByPath(ownerId: any, path: any): any;
    selectPendingFileUploadByPath(ownerId: any, path: any): any;
    selectFileUpload(uploadId: any): any;
    completeFileUpload(upload: any, size: any, updatedAt: any): any;
    deleteFileUploadsForPath(ownerId: any, path: any): any;
    deleteFileUploadsForFile(ownerId: any, fileId: any): any;
    deleteFileUpload(uploadId: any): any;
    selectPublicFileRow(publicUrlId: any): any;
    insertPublicFileUrl(row: any): any;
    revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): any;
    revokePublicFileUrlsForFile(fileId: any, revokedAt: any): any;
    markFileDeleted(fileId: any, deletedAt: any): any;
    fileRowForOwner(fileId: any, ownerId: any): any;
    findAuthUserByProviderEmail(provider: any, email: any): any;
    insertAuthUser(row: any): any;
    updateAuthUserProfile(row: any): any;
    linkAuthUser(row: any): any;
    insertAuthSession(row: any): any;
    deleteAuthSession(token: any): any;
    refreshAuthSession(token: any, expiresAt: any): any;
    rotateAuthSession(previousToken: any, row: any): any;
    readAuthSessionWithUser(token: any): any;
    insertOAuthState(row: any): any;
    consumeOAuthState(state: any): any;
    emailCredentialExists(email: any): boolean;
    insertEmailCredential(row: any): any;
    findEmailCredentialWithUser(email: any): any;
    referenceExists(field: any, value: any): boolean;
    insertAppRow(table: any, row: any): any;
    selectAppRowById(table: any, id: any): any;
    updateAppRow(table: any, id: any, values: any, options?: {}): any;
    deleteAppRow(table: any, id: any): any;
    selectAppRows(table: any, query?: {}): any;
}>;
export declare function createRuntimeFileStorageAdapter({ config, databasePath }: {
    config?: {};
    databasePath: any;
}): Promise<{
    engine: string;
    storagePath: string;
    writeFileVersion({ fileId, version, bytes }: {
        fileId: any;
        version: any;
        bytes: any;
    }): Promise<void>;
    readFileVersion({ fileId, version }: {
        fileId: any;
        version: any;
    }): Promise<NonSharedBuffer>;
    deleteFileVersion({ fileId, version }: {
        fileId: any;
        version: any;
    }): Promise<void>;
    checkHealth(): Promise<{
        ok: boolean;
    }>;
    close(): void;
}>;
export declare function createLocalFileStorageAdapter({ storagePath }: {
    storagePath: any;
}): {
    engine: string;
    storagePath: string;
    writeFileVersion({ fileId, version, bytes }: {
        fileId: any;
        version: any;
        bytes: any;
    }): Promise<void>;
    readFileVersion({ fileId, version }: {
        fileId: any;
        version: any;
    }): Promise<NonSharedBuffer>;
    deleteFileVersion({ fileId, version }: {
        fileId: any;
        version: any;
    }): Promise<void>;
    checkHealth(): Promise<{
        ok: boolean;
    }>;
    close(): void;
};
export declare function createSqliteDatabaseAdapter(databasePath: any, options?: {}): Promise<{
    engine: string;
    exec(sql: any): void;
    prepare(sql: any): {
        all(...params: any[]): Record<string, import("node:sqlite").SQLOutputValue>[];
        get(...params: any[]): Record<string, import("node:sqlite").SQLOutputValue>;
        run(...params: any[]): import("node:sqlite").StatementResultingChanges;
        columns(): import("node:sqlite").StatementColumnMetadata[];
    };
    ensureSystemTable(): any;
    readSystemMetadata(key: any): any;
    writeSystemMetadata(key: any, value: any): any;
    readSchemaMetadata(): any;
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
    findFileBucket(ownerId: any, name: any): any;
    createFileBucket(row: any): any;
    insertFileRow(row: any): any;
    updatePendingFileRow(row: any): any;
    insertFileUpload(row: any): any;
    selectFileById(fileId: any): any;
    selectLiveFileByPath(ownerId: any, path: any): any;
    selectActiveFileByPath(ownerId: any, path: any): any;
    selectPendingFileUploadByPath(ownerId: any, path: any): any;
    selectFileUpload(uploadId: any): any;
    completeFileUpload(upload: any, size: any, updatedAt: any): any;
    deleteFileUploadsForPath(ownerId: any, path: any): any;
    deleteFileUploadsForFile(ownerId: any, fileId: any): any;
    deleteFileUpload(uploadId: any): any;
    selectPublicFileRow(publicUrlId: any): any;
    insertPublicFileUrl(row: any): any;
    revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): any;
    revokePublicFileUrlsForFile(fileId: any, revokedAt: any): any;
    markFileDeleted(fileId: any, deletedAt: any): any;
    fileRowForOwner(fileId: any, ownerId: any): any;
    ensureAuthStorage(authConfig?: any): void;
    findAuthUserByProviderEmail(provider: any, email: any): any;
    insertAuthUser(row: any): any;
    updateAuthUserProfile(row: any): any;
    linkAuthUser(row: any): any;
    insertAuthSession(row: any): any;
    deleteAuthSession(token: any): any;
    refreshAuthSession(token: any, expiresAt: any): any;
    rotateAuthSession(previousToken: any, row: any): any;
    readAuthSessionWithUser(token: any): any;
    insertOAuthState(row: any): any;
    consumeOAuthState(state: any): any;
    emailCredentialExists(email: any): boolean;
    insertEmailCredential(row: any): any;
    findEmailCredentialWithUser(email: any): any;
    migrateAppSchema(schema: any): any;
    createAppTable(table: any, tableName?: any): any;
    migrateExistingAppTable(existingTable: any, nextTable: any): any;
    referenceExists(field: any, value: any): boolean;
    withTransaction(fn: any): Promise<any>;
    insertAppRow(table: any, row: any): any;
    selectAppRowById(table: any, id: any): any;
    updateAppRow(table: any, id: any, values: any, options?: {}): any;
    deleteAppRow(table: any, id: any): any;
    selectAppRows(table: any, query?: {}): any;
    listInspectableTables(): any;
    dumpInspectableDatabase(): any;
    runReadOnlyInspectionQuery(sql: any): {
        ok: boolean;
        data: {
            columns: any;
            rows: any;
        };
        error: any;
    } | {
        ok: boolean;
        data: any;
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
export declare function createPostgresDatabaseAdapter(options: any): Promise<{
    engine: string;
    exec(sql: any): Promise<any>;
    prepare(sql: any): {
        all(...params: any[]): Promise<any>;
        get(...params: any[]): any;
        run(...params: any[]): Promise<{
            changes: number;
            lastInsertRowid: any;
        }>;
        columns(): Promise<{
            name: any;
        }[]>;
    };
    writeSystemMetadata(keyOrMetadata: any, maybeValue: any): Promise<any>;
    writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: {
        schemaVersion: any;
        schemaHash: any;
        schemaJson: any;
    }): Promise<void>;
    ensureAuthStorage(authConfig?: any): Promise<void>;
    ensureLogStorage(): Promise<void>;
    ensureFileStorage(): Promise<void>;
    insertLogIndexEvent(event: any): Promise<void>;
    pruneLogIndex(limit: any): Promise<void>;
    readRecentLogEvents(limit?: number): Promise<any>;
    migrateAppSchema(schema: any): Promise<void>;
    createAppTable(table: any, tableName?: any): Promise<void>;
    migrateExistingAppTable(existingTable: any, nextTable: any): Promise<void>;
    listInspectableTables(): Promise<any>;
    dumpInspectableDatabase(): Promise<any[]>;
    runReadOnlyInspectionQuery(sql: any): Promise<{
        ok: boolean;
        data: {
            columns: any[];
            rows: any;
        };
        error: any;
    } | {
        ok: boolean;
        data: any;
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
    ensureSystemTable(): any;
    readSystemMetadata(key: any): any;
    readSchemaMetadata(): any;
    findFileBucket(ownerId: any, name: any): any;
    createFileBucket(row: any): any;
    insertFileRow(row: any): any;
    updatePendingFileRow(row: any): any;
    insertFileUpload(row: any): any;
    selectFileById(fileId: any): any;
    selectLiveFileByPath(ownerId: any, path: any): any;
    selectActiveFileByPath(ownerId: any, path: any): any;
    selectPendingFileUploadByPath(ownerId: any, path: any): any;
    selectFileUpload(uploadId: any): any;
    completeFileUpload(upload: any, size: any, updatedAt: any): any;
    deleteFileUploadsForPath(ownerId: any, path: any): any;
    deleteFileUploadsForFile(ownerId: any, fileId: any): any;
    deleteFileUpload(uploadId: any): any;
    selectPublicFileRow(publicUrlId: any): any;
    insertPublicFileUrl(row: any): any;
    revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): any;
    revokePublicFileUrlsForFile(fileId: any, revokedAt: any): any;
    markFileDeleted(fileId: any, deletedAt: any): any;
    fileRowForOwner(fileId: any, ownerId: any): any;
    findAuthUserByProviderEmail(provider: any, email: any): any;
    insertAuthUser(row: any): any;
    updateAuthUserProfile(row: any): any;
    linkAuthUser(row: any): any;
    insertAuthSession(row: any): any;
    deleteAuthSession(token: any): any;
    refreshAuthSession(token: any, expiresAt: any): any;
    rotateAuthSession(previousToken: any, row: any): any;
    readAuthSessionWithUser(token: any): any;
    insertOAuthState(row: any): any;
    consumeOAuthState(state: any): any;
    emailCredentialExists(email: any): boolean;
    insertEmailCredential(row: any): any;
    findEmailCredentialWithUser(email: any): any;
    referenceExists(field: any, value: any): boolean;
    insertAppRow(table: any, row: any): any;
    selectAppRowById(table: any, id: any): any;
    updateAppRow(table: any, id: any, values: any, options?: {}): any;
    deleteAppRow(table: any, id: any): any;
    selectAppRows(table: any, query?: {}): any;
}>;
export declare function createPostgresConnection(url: any): Promise<{
    readonly backendKeyData: any;
    query(sql: any): Promise<{
        fields: any[];
        rows: any[];
        rowCount: number;
    }>;
    close(): Promise<void>;
}>;
declare function postgresInterpolate(sql: any, params?: any[]): string;
export declare function createLibsqlDatabaseAdapter(options: any): Promise<{
    engine: string;
    writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: {
        schemaVersion: any;
        schemaHash: any;
        schemaJson: any;
    }): Promise<void>;
    ensureLogStorage(): Promise<void>;
    insertLogIndexEvent(event: any): Promise<void>;
    pruneLogIndex(limit: any): Promise<void>;
    readRecentLogEvents(limit?: number): Promise<any>;
    ensureFileStorage(): Promise<void>;
    ensureAuthStorage(authConfig?: any): Promise<void>;
    consumeOAuthState(state: any): Promise<any>;
    migrateAppSchema(schema: any): Promise<void>;
    migrateExistingAppTable(existingTable: any, nextTable: any): Promise<void>;
    listInspectableTables(): Promise<any>;
    dumpInspectableDatabase(): Promise<any[]>;
    runReadOnlyInspectionQuery(sql: any): Promise<{
        ok: boolean;
        data: {
            columns: any;
            rows: any;
        };
        error: any;
    } | {
        ok: boolean;
        data: any;
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
    exec(sql: any): Promise<any>;
    prepare(sql: any): {
        all(...params: any[]): Promise<any>;
        get(...params: any[]): any;
        run(...params: any[]): Promise<{
            changes: number;
            lastInsertRowid: bigint;
        }>;
        columns(): Promise<any>;
    };
    ensureSystemTable(): any;
    readSystemMetadata(key: any): any;
    writeSystemMetadata(key: any, value: any): any;
    readSchemaMetadata(): any;
    findFileBucket(ownerId: any, name: any): any;
    createFileBucket(row: any): any;
    insertFileRow(row: any): any;
    updatePendingFileRow(row: any): any;
    insertFileUpload(row: any): any;
    selectFileById(fileId: any): any;
    selectLiveFileByPath(ownerId: any, path: any): any;
    selectActiveFileByPath(ownerId: any, path: any): any;
    selectPendingFileUploadByPath(ownerId: any, path: any): any;
    selectFileUpload(uploadId: any): any;
    completeFileUpload(upload: any, size: any, updatedAt: any): any;
    deleteFileUploadsForPath(ownerId: any, path: any): any;
    deleteFileUploadsForFile(ownerId: any, fileId: any): any;
    deleteFileUpload(uploadId: any): any;
    selectPublicFileRow(publicUrlId: any): any;
    insertPublicFileUrl(row: any): any;
    revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): any;
    revokePublicFileUrlsForFile(fileId: any, revokedAt: any): any;
    markFileDeleted(fileId: any, deletedAt: any): any;
    fileRowForOwner(fileId: any, ownerId: any): any;
    findAuthUserByProviderEmail(provider: any, email: any): any;
    insertAuthUser(row: any): any;
    updateAuthUserProfile(row: any): any;
    linkAuthUser(row: any): any;
    insertAuthSession(row: any): any;
    deleteAuthSession(token: any): any;
    refreshAuthSession(token: any, expiresAt: any): any;
    rotateAuthSession(previousToken: any, row: any): any;
    readAuthSessionWithUser(token: any): any;
    insertOAuthState(row: any): any;
    emailCredentialExists(email: any): boolean;
    insertEmailCredential(row: any): any;
    findEmailCredentialWithUser(email: any): any;
    createAppTable(table: any, tableName?: any): any;
    referenceExists(field: any, value: any): boolean;
    insertAppRow(table: any, row: any): any;
    selectAppRowById(table: any, id: any): any;
    updateAppRow(table: any, id: any, values: any, options?: {}): any;
    deleteAppRow(table: any, id: any): any;
    selectAppRows(table: any, query?: {}): any;
}>;
declare function logPayloadMaxBytes(config?: {}): number;
declare function readRecentLogEvents(sqlite: any, limit?: number): any;
declare function createAppTable(sqlite: any, table: any, tableName?: any): any;
export declare function routeEndpoint(database: any, request: any, response: any): Promise<boolean>;
export declare function handleFileHttpRoute(database: any, request: any, response: any, websocketHub?: any): Promise<boolean>;
export declare function routeRuntimeHealth(database: any, request: any, response: any): Promise<boolean>;
export declare function checkRuntimeSqlite(database: any): Promise<any>;
export declare function checkRuntimeFileStorage(database: any): Promise<any>;
export declare function createPendingFileUpload(database: any, auth: any, message: any): Promise<{
    ok: boolean;
    error: {
        message: any;
        hint: any;
    };
} | {
    ok: boolean;
    row: any;
} | {
    ok: boolean;
    data: {
        uploadUrl: string;
        method: string;
        headers: {};
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
}>;
export declare function completePendingFileUpload(database: any, uploadId: any, request: any, websocketHub?: any): Promise<{
    ok: boolean;
    data: any;
    error: {
        message: any;
        hint: any;
    };
} | {
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
}>;
export declare function getPrivateFileUrl(database: any, auth: any, fileReference: any): Promise<{
    ok: boolean;
    error: {
        message: any;
        hint: any;
    };
} | {
    ok: boolean;
    row: any;
} | {
    ok: boolean;
    data: {
        url: string;
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
}>;
export declare function createPublicFileUrl(database: any, auth: any, fileReference: any, options?: {}): Promise<{
    ok: boolean;
    error: {
        message: any;
        hint: any;
    };
} | {
    ok: boolean;
    row: any;
} | {
    ok: boolean;
    expiresAt: string;
    error?: undefined;
} | {
    ok: boolean;
    data: {
        publicUrl: {
            id: `${string}-${string}-${string}-${string}-${string}`;
            fileId: any;
            url: string;
            expiresAt: string;
            revokedAt: any;
        };
    };
    error: any;
}>;
export declare function deletePrivateFile(database: any, auth: any, fileReference: any): Promise<{
    ok: boolean;
    error: {
        message: any;
        hint: any;
    };
} | {
    ok: boolean;
    row: any;
} | {
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
}>;
declare function createEndpointTableApi(database: any, table: any, query?: {}, contextGetter?: any): {
    insert(values: any): any;
    update(id: any, values: any): any;
    delete(id: any): any;
    where(fieldName: any, value: any): /*elided*/ any;
    orderBy(fieldName: any, direction?: string): /*elided*/ any;
    limit(count: any): /*elided*/ any;
    get(): any;
    all(): any;
};
declare function runTableWriteWithAcl(database: any, table: any, operation: any, previous: any, next: any, contextGetter: any, write: any): any;
declare function createAclDeniedError(logData?: any): Error;
export declare function listDatabaseTables(database: any): Promise<any>;
export declare function dumpDatabase(database: any): Promise<any>;
export declare function runReadOnlyQuery(database: any, sql: any): Promise<any>;
declare function isInternalLogIndexMetadataRow(row: any, sql?: string): boolean;
export declare function simulateLocalIdentitySession(database: any, options?: {}): Promise<{
    ok: boolean;
    data: any;
    error: {
        message: string;
        hint: string;
    };
} | {
    ok: boolean;
    data: {
        localStorage: {
            key: string;
            value: string;
        };
        auth: {
            userId: any;
            displayName: string;
            email: string;
            picture: string;
            isAuthenticated: boolean;
            isGuest: boolean;
            provider: string;
        };
    };
    error: any;
}>;
export declare function createWebSocketHub(getDatabase: any): {
    accept(request: any, socket: any): Promise<void>;
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
            isAuthenticated: any;
            isGuest: any;
            provider: any;
        };
    }[];
    notifyFileEvent(userId: any, event: any): void;
    deliverAuthSession(target: any, sessionData: any): {
        target: any;
        delivered: boolean;
        clients: number;
    };
};
export declare function routeSporadesAuth(database: any, request: any, response: any): Promise<boolean>;
export declare function signUpWithEmail(database: any, session: any, provider: any, credentials: any): Promise<{
    ok: boolean;
    email: string;
    password: string;
    name: string;
    error?: undefined;
} | {
    ok: boolean;
    error: {
        message: string;
        hint: string;
    };
    sessionToken?: undefined;
    auth?: undefined;
} | {
    ok: boolean;
    sessionToken: string;
    auth: {
        userId: any;
        displayName: string;
        email: string;
        picture: any;
        isAuthenticated: boolean;
        isGuest: boolean;
        provider: string;
    };
    error?: undefined;
}>;
declare function sessionExpiresAt(from?: string): string;
export declare function resolveAnonymousSession(database: any, sessionToken: any): Promise<{
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
export declare function runQuery(database: any, auth: any, queryName: any): Promise<{
    data: any;
    error: any;
} | {
    rows: any;
    error: {
        message: any;
        hint: any;
    };
} | {
    rows: any;
    error: any;
}>;
export declare function runMutation(database: any, auth: any, mutationName: any, args: any): Promise<any>;
declare function runAppMessage(database: any, auth: any, messageName: any, data: any, options?: {}): Promise<{
    data: any;
    error: {
        message: any;
        hint: any;
    };
} | {
    data: any;
    error: any;
}>;
export {};
//# sourceMappingURL=server-runtime-source.d.ts.map