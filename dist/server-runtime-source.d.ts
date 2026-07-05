export declare const SERVER_RUNTIME_SOURCE_FUNCTIONS: (typeof openDevDatabase | typeof createRuntimeDatabaseAdapter | typeof postgresInterpolate | typeof libsqlExecute | typeof libsqlPipeline | typeof resolveRuntimeSecurityPolicy | typeof createRuntimeFileStorageAdapter | typeof createS3CompatibleFileStorageAdapter | typeof createLocalFileStorageAdapter | typeof handleFileHttpRoute | typeof s3Request | typeof logPayloadMaxBytes | typeof completePendingFileUpload | typeof commandError | typeof runAppMessage | typeof createPublicFileUrl | typeof readRecentLogEvents | typeof isInternalLogIndexMetadataRow | typeof createAppTable | typeof createEndpointTableApi | typeof runTableWriteWithAcl | typeof createAclDenialLogData | typeof createAclDeniedError | typeof s3Signature | typeof createAnonymousAuthTables | typeof sessionExpiresAt)[];
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
export declare function openDevDatabase(databasePath: any, serverSource: any, serverEnv?: {}, config?: {}, capsuleDefinition?: null, options?: {}): Promise<{
    adapter: {
        engine: string;
        exec(sql: any): void;
        prepare(sql: any): {
            all(...params: any[]): Record<string, import("node:sqlite").SQLOutputValue>[];
            get(...params: any[]): Record<string, import("node:sqlite").SQLOutputValue> | undefined;
            run(...params: any[]): import("node:sqlite").StatementResultingChanges;
            columns(): import("node:sqlite").StatementColumnMetadata[];
        };
        ensureSystemTable(): void;
        readSystemMetadata(key: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        writeSystemMetadata(key: any, value: any): import("node:sqlite").StatementResultingChanges;
        readSchemaMetadata(): Record<string, import("node:sqlite").SQLOutputValue> | null;
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
        findFileBucket(ownerId: any, name: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        createFileBucket(row: any): import("node:sqlite").StatementResultingChanges;
        insertFileRow(row: any): import("node:sqlite").StatementResultingChanges;
        updatePendingFileRow(row: any): import("node:sqlite").StatementResultingChanges;
        insertFileUpload(row: any): import("node:sqlite").StatementResultingChanges;
        selectFileById(fileId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        selectLiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
        selectActiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
        selectPendingFileUploadByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        selectFileUpload(uploadId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        completeFileUpload(upload: any, size: any, updatedAt: any): import("node:sqlite").StatementResultingChanges | {
            changes: number;
        };
        deleteFileUploadsForPath(path: any): import("node:sqlite").StatementResultingChanges;
        deleteFileUploadsForFile(ownerId: any, fileId: any): import("node:sqlite").StatementResultingChanges;
        deleteFileUpload(uploadId: any): import("node:sqlite").StatementResultingChanges;
        selectPublicFileRow(publicUrlId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertPublicFileUrl(row: any): import("node:sqlite").StatementResultingChanges;
        revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
        revokePublicFileUrlsForFile(fileId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
        markFileDeleted(fileId: any, deletedAt: any): import("node:sqlite").StatementResultingChanges;
        fileRowForOwner(fileId: any, ownerId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        ensureAuthStorage(authConfig?: null): void;
        findAuthUserByProviderEmail(provider: any, email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
        updateAuthUserProfile(row: any): import("node:sqlite").StatementResultingChanges;
        linkAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
        insertAuthSession(row: any): import("node:sqlite").StatementResultingChanges;
        deleteAuthSession(token: any): import("node:sqlite").StatementResultingChanges;
        refreshAuthSession(token: any, expiresAt: any): import("node:sqlite").StatementResultingChanges;
        rotateAuthSession(previousToken: any, row: any): import("node:sqlite").StatementResultingChanges;
        readAuthSessionWithUser(token: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertOAuthState(row: any): import("node:sqlite").StatementResultingChanges;
        consumeOAuthState(state: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        emailCredentialExists(email: any): boolean;
        insertEmailCredential(row: any): import("node:sqlite").StatementResultingChanges;
        findEmailCredentialWithUser(email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        migrateAppSchema(schema: any): any;
        createAppTable(table: any, tableName?: any): any;
        migrateExistingAppTable(existingTable: any, nextTable: any): any;
        referenceExists(field: any, value: any): boolean;
        withTransaction(fn: any): Promise<any>;
        insertAppRow(table: any, row: any): import("node:sqlite").StatementResultingChanges;
        selectAppRowById(table: any, id: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        updateAppRow(table: any, id: any, values: any, options?: {}): import("node:sqlite").StatementResultingChanges | {
            changes: number;
        };
        deleteAppRow(table: any, id: any): import("node:sqlite").StatementResultingChanges;
        selectAppRows(table: any, query?: {}): Record<string, import("node:sqlite").SQLOutputValue>[];
        listInspectableTables(): import("node:sqlite").SQLOutputValue[];
        dumpInspectableDatabase(): {
            name: import("node:sqlite").SQLOutputValue;
            columns: import("node:sqlite").SQLOutputValue[];
            rows: Record<string, import("node:sqlite").SQLOutputValue>[];
        }[];
        runReadOnlyInspectionQuery(sql: any): {
            ok: boolean;
            data: {
                columns: string[];
                rows: Record<string, import("node:sqlite").SQLOutputValue>[];
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
        ensureAuthStorage(authConfig?: null): Promise<void>;
        consumeOAuthState(state: any): Promise<any>;
        migrateAppSchema(schema: any): Promise<void>;
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
                columns: any;
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
        exec(sql: any): Promise<undefined>;
        prepare(sql: any): {
            all(...params: any[]): Promise<any>;
            get(...params: any[]): Promise<any>;
            run(...params: any[]): Promise<{
                changes: number;
                lastInsertRowid: bigint | undefined;
            }>;
            columns(): Promise<any>;
        };
        ensureSystemTable(): void;
        readSystemMetadata(key: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        writeSystemMetadata(key: any, value: any): import("node:sqlite").StatementResultingChanges;
        readSchemaMetadata(): Record<string, import("node:sqlite").SQLOutputValue> | null;
        findFileBucket(ownerId: any, name: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        createFileBucket(row: any): import("node:sqlite").StatementResultingChanges;
        insertFileRow(row: any): import("node:sqlite").StatementResultingChanges;
        updatePendingFileRow(row: any): import("node:sqlite").StatementResultingChanges;
        insertFileUpload(row: any): import("node:sqlite").StatementResultingChanges;
        selectFileById(fileId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        selectLiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
        selectActiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
        selectPendingFileUploadByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        selectFileUpload(uploadId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        completeFileUpload(upload: any, size: any, updatedAt: any): import("node:sqlite").StatementResultingChanges | {
            changes: number;
        };
        deleteFileUploadsForPath(path: any): import("node:sqlite").StatementResultingChanges;
        deleteFileUploadsForFile(ownerId: any, fileId: any): import("node:sqlite").StatementResultingChanges;
        deleteFileUpload(uploadId: any): import("node:sqlite").StatementResultingChanges;
        selectPublicFileRow(publicUrlId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertPublicFileUrl(row: any): import("node:sqlite").StatementResultingChanges;
        revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
        revokePublicFileUrlsForFile(fileId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
        markFileDeleted(fileId: any, deletedAt: any): import("node:sqlite").StatementResultingChanges;
        fileRowForOwner(fileId: any, ownerId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        findAuthUserByProviderEmail(provider: any, email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
        updateAuthUserProfile(row: any): import("node:sqlite").StatementResultingChanges;
        linkAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
        insertAuthSession(row: any): import("node:sqlite").StatementResultingChanges;
        deleteAuthSession(token: any): import("node:sqlite").StatementResultingChanges;
        refreshAuthSession(token: any, expiresAt: any): import("node:sqlite").StatementResultingChanges;
        rotateAuthSession(previousToken: any, row: any): import("node:sqlite").StatementResultingChanges;
        readAuthSessionWithUser(token: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertOAuthState(row: any): import("node:sqlite").StatementResultingChanges;
        emailCredentialExists(email: any): boolean;
        insertEmailCredential(row: any): import("node:sqlite").StatementResultingChanges;
        findEmailCredentialWithUser(email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        createAppTable(table: any, tableName?: any): any;
        referenceExists(field: any, value: any): boolean;
        insertAppRow(table: any, row: any): import("node:sqlite").StatementResultingChanges;
        selectAppRowById(table: any, id: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        updateAppRow(table: any, id: any, values: any, options?: {}): import("node:sqlite").StatementResultingChanges | {
            changes: number;
        };
        deleteAppRow(table: any, id: any): import("node:sqlite").StatementResultingChanges;
        selectAppRows(table: any, query?: {}): Record<string, import("node:sqlite").SQLOutputValue>[];
    } | {
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
        readSystemMetadata(key: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        readSchemaMetadata(): Record<string, import("node:sqlite").SQLOutputValue> | null;
        findFileBucket(ownerId: any, name: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        createFileBucket(row: any): import("node:sqlite").StatementResultingChanges;
        insertFileRow(row: any): import("node:sqlite").StatementResultingChanges;
        updatePendingFileRow(row: any): import("node:sqlite").StatementResultingChanges;
        insertFileUpload(row: any): import("node:sqlite").StatementResultingChanges;
        selectFileById(fileId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        selectLiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
        selectActiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
        selectPendingFileUploadByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        selectFileUpload(uploadId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        completeFileUpload(upload: any, size: any, updatedAt: any): import("node:sqlite").StatementResultingChanges | {
            changes: number;
        };
        deleteFileUploadsForPath(path: any): import("node:sqlite").StatementResultingChanges;
        deleteFileUploadsForFile(ownerId: any, fileId: any): import("node:sqlite").StatementResultingChanges;
        deleteFileUpload(uploadId: any): import("node:sqlite").StatementResultingChanges;
        selectPublicFileRow(publicUrlId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertPublicFileUrl(row: any): import("node:sqlite").StatementResultingChanges;
        revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
        revokePublicFileUrlsForFile(fileId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
        markFileDeleted(fileId: any, deletedAt: any): import("node:sqlite").StatementResultingChanges;
        fileRowForOwner(fileId: any, ownerId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        findAuthUserByProviderEmail(provider: any, email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
        updateAuthUserProfile(row: any): import("node:sqlite").StatementResultingChanges;
        linkAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
        insertAuthSession(row: any): import("node:sqlite").StatementResultingChanges;
        deleteAuthSession(token: any): import("node:sqlite").StatementResultingChanges;
        refreshAuthSession(token: any, expiresAt: any): import("node:sqlite").StatementResultingChanges;
        rotateAuthSession(previousToken: any, row: any): import("node:sqlite").StatementResultingChanges;
        readAuthSessionWithUser(token: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertOAuthState(row: any): import("node:sqlite").StatementResultingChanges;
        consumeOAuthState(state: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        emailCredentialExists(email: any): boolean;
        insertEmailCredential(row: any): import("node:sqlite").StatementResultingChanges;
        findEmailCredentialWithUser(email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        referenceExists(field: any, value: any): boolean;
        insertAppRow(table: any, row: any): import("node:sqlite").StatementResultingChanges;
        selectAppRowById(table: any, id: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        updateAppRow(table: any, id: any, values: any, options?: {}): import("node:sqlite").StatementResultingChanges | {
            changes: number;
        };
        deleteAppRow(table: any, id: any): import("node:sqlite").StatementResultingChanges;
        selectAppRows(table: any, query?: {}): Record<string, import("node:sqlite").SQLOutputValue>[];
    };
    sqlite: {
        engine: string;
        exec(sql: any): void;
        prepare(sql: any): {
            all(...params: any[]): Record<string, import("node:sqlite").SQLOutputValue>[];
            get(...params: any[]): Record<string, import("node:sqlite").SQLOutputValue> | undefined;
            run(...params: any[]): import("node:sqlite").StatementResultingChanges;
            columns(): import("node:sqlite").StatementColumnMetadata[];
        };
        ensureSystemTable(): void;
        readSystemMetadata(key: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        writeSystemMetadata(key: any, value: any): import("node:sqlite").StatementResultingChanges;
        readSchemaMetadata(): Record<string, import("node:sqlite").SQLOutputValue> | null;
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
        findFileBucket(ownerId: any, name: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        createFileBucket(row: any): import("node:sqlite").StatementResultingChanges;
        insertFileRow(row: any): import("node:sqlite").StatementResultingChanges;
        updatePendingFileRow(row: any): import("node:sqlite").StatementResultingChanges;
        insertFileUpload(row: any): import("node:sqlite").StatementResultingChanges;
        selectFileById(fileId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        selectLiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
        selectActiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
        selectPendingFileUploadByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        selectFileUpload(uploadId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        completeFileUpload(upload: any, size: any, updatedAt: any): import("node:sqlite").StatementResultingChanges | {
            changes: number;
        };
        deleteFileUploadsForPath(path: any): import("node:sqlite").StatementResultingChanges;
        deleteFileUploadsForFile(ownerId: any, fileId: any): import("node:sqlite").StatementResultingChanges;
        deleteFileUpload(uploadId: any): import("node:sqlite").StatementResultingChanges;
        selectPublicFileRow(publicUrlId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertPublicFileUrl(row: any): import("node:sqlite").StatementResultingChanges;
        revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
        revokePublicFileUrlsForFile(fileId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
        markFileDeleted(fileId: any, deletedAt: any): import("node:sqlite").StatementResultingChanges;
        fileRowForOwner(fileId: any, ownerId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        ensureAuthStorage(authConfig?: null): void;
        findAuthUserByProviderEmail(provider: any, email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
        updateAuthUserProfile(row: any): import("node:sqlite").StatementResultingChanges;
        linkAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
        insertAuthSession(row: any): import("node:sqlite").StatementResultingChanges;
        deleteAuthSession(token: any): import("node:sqlite").StatementResultingChanges;
        refreshAuthSession(token: any, expiresAt: any): import("node:sqlite").StatementResultingChanges;
        rotateAuthSession(previousToken: any, row: any): import("node:sqlite").StatementResultingChanges;
        readAuthSessionWithUser(token: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertOAuthState(row: any): import("node:sqlite").StatementResultingChanges;
        consumeOAuthState(state: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        emailCredentialExists(email: any): boolean;
        insertEmailCredential(row: any): import("node:sqlite").StatementResultingChanges;
        findEmailCredentialWithUser(email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        migrateAppSchema(schema: any): any;
        createAppTable(table: any, tableName?: any): any;
        migrateExistingAppTable(existingTable: any, nextTable: any): any;
        referenceExists(field: any, value: any): boolean;
        withTransaction(fn: any): Promise<any>;
        insertAppRow(table: any, row: any): import("node:sqlite").StatementResultingChanges;
        selectAppRowById(table: any, id: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        updateAppRow(table: any, id: any, values: any, options?: {}): import("node:sqlite").StatementResultingChanges | {
            changes: number;
        };
        deleteAppRow(table: any, id: any): import("node:sqlite").StatementResultingChanges;
        selectAppRows(table: any, query?: {}): Record<string, import("node:sqlite").SQLOutputValue>[];
        listInspectableTables(): import("node:sqlite").SQLOutputValue[];
        dumpInspectableDatabase(): {
            name: import("node:sqlite").SQLOutputValue;
            columns: import("node:sqlite").SQLOutputValue[];
            rows: Record<string, import("node:sqlite").SQLOutputValue>[];
        }[];
        runReadOnlyInspectionQuery(sql: any): {
            ok: boolean;
            data: {
                columns: string[];
                rows: Record<string, import("node:sqlite").SQLOutputValue>[];
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
        ensureAuthStorage(authConfig?: null): Promise<void>;
        consumeOAuthState(state: any): Promise<any>;
        migrateAppSchema(schema: any): Promise<void>;
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
                columns: any;
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
        exec(sql: any): Promise<undefined>;
        prepare(sql: any): {
            all(...params: any[]): Promise<any>;
            get(...params: any[]): Promise<any>;
            run(...params: any[]): Promise<{
                changes: number;
                lastInsertRowid: bigint | undefined;
            }>;
            columns(): Promise<any>;
        };
        ensureSystemTable(): void;
        readSystemMetadata(key: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        writeSystemMetadata(key: any, value: any): import("node:sqlite").StatementResultingChanges;
        readSchemaMetadata(): Record<string, import("node:sqlite").SQLOutputValue> | null;
        findFileBucket(ownerId: any, name: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        createFileBucket(row: any): import("node:sqlite").StatementResultingChanges;
        insertFileRow(row: any): import("node:sqlite").StatementResultingChanges;
        updatePendingFileRow(row: any): import("node:sqlite").StatementResultingChanges;
        insertFileUpload(row: any): import("node:sqlite").StatementResultingChanges;
        selectFileById(fileId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        selectLiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
        selectActiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
        selectPendingFileUploadByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        selectFileUpload(uploadId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        completeFileUpload(upload: any, size: any, updatedAt: any): import("node:sqlite").StatementResultingChanges | {
            changes: number;
        };
        deleteFileUploadsForPath(path: any): import("node:sqlite").StatementResultingChanges;
        deleteFileUploadsForFile(ownerId: any, fileId: any): import("node:sqlite").StatementResultingChanges;
        deleteFileUpload(uploadId: any): import("node:sqlite").StatementResultingChanges;
        selectPublicFileRow(publicUrlId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertPublicFileUrl(row: any): import("node:sqlite").StatementResultingChanges;
        revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
        revokePublicFileUrlsForFile(fileId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
        markFileDeleted(fileId: any, deletedAt: any): import("node:sqlite").StatementResultingChanges;
        fileRowForOwner(fileId: any, ownerId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        findAuthUserByProviderEmail(provider: any, email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
        updateAuthUserProfile(row: any): import("node:sqlite").StatementResultingChanges;
        linkAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
        insertAuthSession(row: any): import("node:sqlite").StatementResultingChanges;
        deleteAuthSession(token: any): import("node:sqlite").StatementResultingChanges;
        refreshAuthSession(token: any, expiresAt: any): import("node:sqlite").StatementResultingChanges;
        rotateAuthSession(previousToken: any, row: any): import("node:sqlite").StatementResultingChanges;
        readAuthSessionWithUser(token: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertOAuthState(row: any): import("node:sqlite").StatementResultingChanges;
        emailCredentialExists(email: any): boolean;
        insertEmailCredential(row: any): import("node:sqlite").StatementResultingChanges;
        findEmailCredentialWithUser(email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        createAppTable(table: any, tableName?: any): any;
        referenceExists(field: any, value: any): boolean;
        insertAppRow(table: any, row: any): import("node:sqlite").StatementResultingChanges;
        selectAppRowById(table: any, id: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        updateAppRow(table: any, id: any, values: any, options?: {}): import("node:sqlite").StatementResultingChanges | {
            changes: number;
        };
        deleteAppRow(table: any, id: any): import("node:sqlite").StatementResultingChanges;
        selectAppRows(table: any, query?: {}): Record<string, import("node:sqlite").SQLOutputValue>[];
    } | {
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
        readSystemMetadata(key: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        readSchemaMetadata(): Record<string, import("node:sqlite").SQLOutputValue> | null;
        findFileBucket(ownerId: any, name: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        createFileBucket(row: any): import("node:sqlite").StatementResultingChanges;
        insertFileRow(row: any): import("node:sqlite").StatementResultingChanges;
        updatePendingFileRow(row: any): import("node:sqlite").StatementResultingChanges;
        insertFileUpload(row: any): import("node:sqlite").StatementResultingChanges;
        selectFileById(fileId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        selectLiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
        selectActiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
        selectPendingFileUploadByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        selectFileUpload(uploadId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        completeFileUpload(upload: any, size: any, updatedAt: any): import("node:sqlite").StatementResultingChanges | {
            changes: number;
        };
        deleteFileUploadsForPath(path: any): import("node:sqlite").StatementResultingChanges;
        deleteFileUploadsForFile(ownerId: any, fileId: any): import("node:sqlite").StatementResultingChanges;
        deleteFileUpload(uploadId: any): import("node:sqlite").StatementResultingChanges;
        selectPublicFileRow(publicUrlId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertPublicFileUrl(row: any): import("node:sqlite").StatementResultingChanges;
        revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
        revokePublicFileUrlsForFile(fileId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
        markFileDeleted(fileId: any, deletedAt: any): import("node:sqlite").StatementResultingChanges;
        fileRowForOwner(fileId: any, ownerId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        findAuthUserByProviderEmail(provider: any, email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
        updateAuthUserProfile(row: any): import("node:sqlite").StatementResultingChanges;
        linkAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
        insertAuthSession(row: any): import("node:sqlite").StatementResultingChanges;
        deleteAuthSession(token: any): import("node:sqlite").StatementResultingChanges;
        refreshAuthSession(token: any, expiresAt: any): import("node:sqlite").StatementResultingChanges;
        rotateAuthSession(previousToken: any, row: any): import("node:sqlite").StatementResultingChanges;
        readAuthSessionWithUser(token: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        insertOAuthState(row: any): import("node:sqlite").StatementResultingChanges;
        consumeOAuthState(state: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        emailCredentialExists(email: any): boolean;
        insertEmailCredential(row: any): import("node:sqlite").StatementResultingChanges;
        findEmailCredentialWithUser(email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        referenceExists(field: any, value: any): boolean;
        insertAppRow(table: any, row: any): import("node:sqlite").StatementResultingChanges;
        selectAppRowById(table: any, id: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
        updateAppRow(table: any, id: any, values: any, options?: {}): import("node:sqlite").StatementResultingChanges | {
            changes: number;
        };
        deleteAppRow(table: any, id: any): import("node:sqlite").StatementResultingChanges;
        selectAppRows(table: any, query?: {}): Record<string, import("node:sqlite").SQLOutputValue>[];
    };
    schema: {
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
    };
    endpoints: {
        name: string;
        method: any;
        path: any;
        handlerSource: any;
    }[];
    queries: {
        name: string;
        handler: any;
    }[] | {
        name: any;
        handlerSource: any;
    }[];
    mutations: {
        name: string;
        handler: any;
    }[] | {
        name: any;
        handlerSource: any;
    }[];
    messages: {
        name: any;
        handlerSource: any;
    }[];
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
        endpoint: string;
        bucket: string;
        region: string;
        namespace: string;
        objectKeyPrefix: string;
        writeFileVersion({ fileId, version, bytes }: {
            fileId: any;
            version: any;
            bytes: any;
        }): Promise<void>;
        readFileVersion({ fileId, version }: {
            fileId: any;
            version: any;
        }): Promise<any>;
        deleteFileVersion({ fileId, version }: {
            fileId: any;
            version: any;
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
        get(...params: any[]): Record<string, import("node:sqlite").SQLOutputValue> | undefined;
        run(...params: any[]): import("node:sqlite").StatementResultingChanges;
        columns(): import("node:sqlite").StatementColumnMetadata[];
    };
    ensureSystemTable(): void;
    readSystemMetadata(key: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    writeSystemMetadata(key: any, value: any): import("node:sqlite").StatementResultingChanges;
    readSchemaMetadata(): Record<string, import("node:sqlite").SQLOutputValue> | null;
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
    findFileBucket(ownerId: any, name: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    createFileBucket(row: any): import("node:sqlite").StatementResultingChanges;
    insertFileRow(row: any): import("node:sqlite").StatementResultingChanges;
    updatePendingFileRow(row: any): import("node:sqlite").StatementResultingChanges;
    insertFileUpload(row: any): import("node:sqlite").StatementResultingChanges;
    selectFileById(fileId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    selectLiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
    selectActiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
    selectPendingFileUploadByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    selectFileUpload(uploadId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    completeFileUpload(upload: any, size: any, updatedAt: any): import("node:sqlite").StatementResultingChanges | {
        changes: number;
    };
    deleteFileUploadsForPath(path: any): import("node:sqlite").StatementResultingChanges;
    deleteFileUploadsForFile(ownerId: any, fileId: any): import("node:sqlite").StatementResultingChanges;
    deleteFileUpload(uploadId: any): import("node:sqlite").StatementResultingChanges;
    selectPublicFileRow(publicUrlId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertPublicFileUrl(row: any): import("node:sqlite").StatementResultingChanges;
    revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
    revokePublicFileUrlsForFile(fileId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
    markFileDeleted(fileId: any, deletedAt: any): import("node:sqlite").StatementResultingChanges;
    fileRowForOwner(fileId: any, ownerId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    ensureAuthStorage(authConfig?: null): void;
    findAuthUserByProviderEmail(provider: any, email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
    updateAuthUserProfile(row: any): import("node:sqlite").StatementResultingChanges;
    linkAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
    insertAuthSession(row: any): import("node:sqlite").StatementResultingChanges;
    deleteAuthSession(token: any): import("node:sqlite").StatementResultingChanges;
    refreshAuthSession(token: any, expiresAt: any): import("node:sqlite").StatementResultingChanges;
    rotateAuthSession(previousToken: any, row: any): import("node:sqlite").StatementResultingChanges;
    readAuthSessionWithUser(token: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertOAuthState(row: any): import("node:sqlite").StatementResultingChanges;
    consumeOAuthState(state: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    emailCredentialExists(email: any): boolean;
    insertEmailCredential(row: any): import("node:sqlite").StatementResultingChanges;
    findEmailCredentialWithUser(email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    migrateAppSchema(schema: any): any;
    createAppTable(table: any, tableName?: any): any;
    migrateExistingAppTable(existingTable: any, nextTable: any): any;
    referenceExists(field: any, value: any): boolean;
    withTransaction(fn: any): Promise<any>;
    insertAppRow(table: any, row: any): import("node:sqlite").StatementResultingChanges;
    selectAppRowById(table: any, id: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    updateAppRow(table: any, id: any, values: any, options?: {}): import("node:sqlite").StatementResultingChanges | {
        changes: number;
    };
    deleteAppRow(table: any, id: any): import("node:sqlite").StatementResultingChanges;
    selectAppRows(table: any, query?: {}): Record<string, import("node:sqlite").SQLOutputValue>[];
    listInspectableTables(): import("node:sqlite").SQLOutputValue[];
    dumpInspectableDatabase(): {
        name: import("node:sqlite").SQLOutputValue;
        columns: import("node:sqlite").SQLOutputValue[];
        rows: Record<string, import("node:sqlite").SQLOutputValue>[];
    }[];
    runReadOnlyInspectionQuery(sql: any): {
        ok: boolean;
        data: {
            columns: string[];
            rows: Record<string, import("node:sqlite").SQLOutputValue>[];
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
    ensureAuthStorage(authConfig?: null): Promise<void>;
    consumeOAuthState(state: any): Promise<any>;
    migrateAppSchema(schema: any): Promise<void>;
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
            columns: any;
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
    exec(sql: any): Promise<undefined>;
    prepare(sql: any): {
        all(...params: any[]): Promise<any>;
        get(...params: any[]): Promise<any>;
        run(...params: any[]): Promise<{
            changes: number;
            lastInsertRowid: bigint | undefined;
        }>;
        columns(): Promise<any>;
    };
    ensureSystemTable(): void;
    readSystemMetadata(key: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    writeSystemMetadata(key: any, value: any): import("node:sqlite").StatementResultingChanges;
    readSchemaMetadata(): Record<string, import("node:sqlite").SQLOutputValue> | null;
    findFileBucket(ownerId: any, name: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    createFileBucket(row: any): import("node:sqlite").StatementResultingChanges;
    insertFileRow(row: any): import("node:sqlite").StatementResultingChanges;
    updatePendingFileRow(row: any): import("node:sqlite").StatementResultingChanges;
    insertFileUpload(row: any): import("node:sqlite").StatementResultingChanges;
    selectFileById(fileId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    selectLiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
    selectActiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
    selectPendingFileUploadByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    selectFileUpload(uploadId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    completeFileUpload(upload: any, size: any, updatedAt: any): import("node:sqlite").StatementResultingChanges | {
        changes: number;
    };
    deleteFileUploadsForPath(path: any): import("node:sqlite").StatementResultingChanges;
    deleteFileUploadsForFile(ownerId: any, fileId: any): import("node:sqlite").StatementResultingChanges;
    deleteFileUpload(uploadId: any): import("node:sqlite").StatementResultingChanges;
    selectPublicFileRow(publicUrlId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertPublicFileUrl(row: any): import("node:sqlite").StatementResultingChanges;
    revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
    revokePublicFileUrlsForFile(fileId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
    markFileDeleted(fileId: any, deletedAt: any): import("node:sqlite").StatementResultingChanges;
    fileRowForOwner(fileId: any, ownerId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    findAuthUserByProviderEmail(provider: any, email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
    updateAuthUserProfile(row: any): import("node:sqlite").StatementResultingChanges;
    linkAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
    insertAuthSession(row: any): import("node:sqlite").StatementResultingChanges;
    deleteAuthSession(token: any): import("node:sqlite").StatementResultingChanges;
    refreshAuthSession(token: any, expiresAt: any): import("node:sqlite").StatementResultingChanges;
    rotateAuthSession(previousToken: any, row: any): import("node:sqlite").StatementResultingChanges;
    readAuthSessionWithUser(token: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertOAuthState(row: any): import("node:sqlite").StatementResultingChanges;
    emailCredentialExists(email: any): boolean;
    insertEmailCredential(row: any): import("node:sqlite").StatementResultingChanges;
    findEmailCredentialWithUser(email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    createAppTable(table: any, tableName?: any): any;
    referenceExists(field: any, value: any): boolean;
    insertAppRow(table: any, row: any): import("node:sqlite").StatementResultingChanges;
    selectAppRowById(table: any, id: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    updateAppRow(table: any, id: any, values: any, options?: {}): import("node:sqlite").StatementResultingChanges | {
        changes: number;
    };
    deleteAppRow(table: any, id: any): import("node:sqlite").StatementResultingChanges;
    selectAppRows(table: any, query?: {}): Record<string, import("node:sqlite").SQLOutputValue>[];
} | {
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
    readSystemMetadata(key: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    readSchemaMetadata(): Record<string, import("node:sqlite").SQLOutputValue> | null;
    findFileBucket(ownerId: any, name: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    createFileBucket(row: any): import("node:sqlite").StatementResultingChanges;
    insertFileRow(row: any): import("node:sqlite").StatementResultingChanges;
    updatePendingFileRow(row: any): import("node:sqlite").StatementResultingChanges;
    insertFileUpload(row: any): import("node:sqlite").StatementResultingChanges;
    selectFileById(fileId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    selectLiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
    selectActiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
    selectPendingFileUploadByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    selectFileUpload(uploadId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    completeFileUpload(upload: any, size: any, updatedAt: any): import("node:sqlite").StatementResultingChanges | {
        changes: number;
    };
    deleteFileUploadsForPath(path: any): import("node:sqlite").StatementResultingChanges;
    deleteFileUploadsForFile(ownerId: any, fileId: any): import("node:sqlite").StatementResultingChanges;
    deleteFileUpload(uploadId: any): import("node:sqlite").StatementResultingChanges;
    selectPublicFileRow(publicUrlId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertPublicFileUrl(row: any): import("node:sqlite").StatementResultingChanges;
    revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
    revokePublicFileUrlsForFile(fileId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
    markFileDeleted(fileId: any, deletedAt: any): import("node:sqlite").StatementResultingChanges;
    fileRowForOwner(fileId: any, ownerId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    findAuthUserByProviderEmail(provider: any, email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
    updateAuthUserProfile(row: any): import("node:sqlite").StatementResultingChanges;
    linkAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
    insertAuthSession(row: any): import("node:sqlite").StatementResultingChanges;
    deleteAuthSession(token: any): import("node:sqlite").StatementResultingChanges;
    refreshAuthSession(token: any, expiresAt: any): import("node:sqlite").StatementResultingChanges;
    rotateAuthSession(previousToken: any, row: any): import("node:sqlite").StatementResultingChanges;
    readAuthSessionWithUser(token: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertOAuthState(row: any): import("node:sqlite").StatementResultingChanges;
    consumeOAuthState(state: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    emailCredentialExists(email: any): boolean;
    insertEmailCredential(row: any): import("node:sqlite").StatementResultingChanges;
    findEmailCredentialWithUser(email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    referenceExists(field: any, value: any): boolean;
    insertAppRow(table: any, row: any): import("node:sqlite").StatementResultingChanges;
    selectAppRowById(table: any, id: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    updateAppRow(table: any, id: any, values: any, options?: {}): import("node:sqlite").StatementResultingChanges | {
        changes: number;
    };
    deleteAppRow(table: any, id: any): import("node:sqlite").StatementResultingChanges;
    selectAppRows(table: any, query?: {}): Record<string, import("node:sqlite").SQLOutputValue>[];
}>;
export declare function createRuntimeFileStorageAdapter({ config, databasePath, serviceEnv }: {
    config?: {} | undefined;
    databasePath: any;
    serviceEnv?: {} | undefined;
}): Promise<{
    engine: string;
    endpoint: string;
    bucket: string;
    region: string;
    namespace: string;
    objectKeyPrefix: string;
    writeFileVersion({ fileId, version, bytes }: {
        fileId: any;
        version: any;
        bytes: any;
    }): Promise<void>;
    readFileVersion({ fileId, version }: {
        fileId: any;
        version: any;
    }): Promise<any>;
    deleteFileVersion({ fileId, version }: {
        fileId: any;
        version: any;
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
export declare function createS3CompatibleFileStorageAdapter({ endpoint, bucket, region, accessKey, secretKey, namespace }: {
    endpoint: any;
    bucket: any;
    region: any;
    accessKey: any;
    secretKey: any;
    namespace: any;
}): {
    engine: string;
    endpoint: string;
    bucket: string;
    region: string;
    namespace: string;
    objectKeyPrefix: string;
    writeFileVersion({ fileId, version, bytes }: {
        fileId: any;
        version: any;
        bytes: any;
    }): Promise<void>;
    readFileVersion({ fileId, version }: {
        fileId: any;
        version: any;
    }): Promise<any>;
    deleteFileVersion({ fileId, version }: {
        fileId: any;
        version: any;
    }): Promise<void>;
    checkHealth(): Promise<{
        ok: boolean;
        adapter: string;
    }>;
    close(): void;
};
declare function s3Request(config: any, { method, key, body }: {
    method: any;
    key?: null | undefined;
    body?: null | undefined;
}): Promise<unknown>;
declare function s3Signature({ method, pathname, query, headers, payloadHash, accessKey, secretKey, region, date, amzDate }: {
    method: any;
    pathname: any;
    query: any;
    headers: any;
    payloadHash: any;
    accessKey: any;
    secretKey: any;
    region: any;
    date: any;
    amzDate: any;
}): string;
export declare function createSqliteDatabaseAdapter(databasePath: any, options?: {}): Promise<{
    engine: string;
    exec(sql: any): void;
    prepare(sql: any): {
        all(...params: any[]): Record<string, import("node:sqlite").SQLOutputValue>[];
        get(...params: any[]): Record<string, import("node:sqlite").SQLOutputValue> | undefined;
        run(...params: any[]): import("node:sqlite").StatementResultingChanges;
        columns(): import("node:sqlite").StatementColumnMetadata[];
    };
    ensureSystemTable(): void;
    readSystemMetadata(key: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    writeSystemMetadata(key: any, value: any): import("node:sqlite").StatementResultingChanges;
    readSchemaMetadata(): Record<string, import("node:sqlite").SQLOutputValue> | null;
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
    findFileBucket(ownerId: any, name: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    createFileBucket(row: any): import("node:sqlite").StatementResultingChanges;
    insertFileRow(row: any): import("node:sqlite").StatementResultingChanges;
    updatePendingFileRow(row: any): import("node:sqlite").StatementResultingChanges;
    insertFileUpload(row: any): import("node:sqlite").StatementResultingChanges;
    selectFileById(fileId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    selectLiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
    selectActiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
    selectPendingFileUploadByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    selectFileUpload(uploadId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    completeFileUpload(upload: any, size: any, updatedAt: any): import("node:sqlite").StatementResultingChanges | {
        changes: number;
    };
    deleteFileUploadsForPath(path: any): import("node:sqlite").StatementResultingChanges;
    deleteFileUploadsForFile(ownerId: any, fileId: any): import("node:sqlite").StatementResultingChanges;
    deleteFileUpload(uploadId: any): import("node:sqlite").StatementResultingChanges;
    selectPublicFileRow(publicUrlId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertPublicFileUrl(row: any): import("node:sqlite").StatementResultingChanges;
    revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
    revokePublicFileUrlsForFile(fileId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
    markFileDeleted(fileId: any, deletedAt: any): import("node:sqlite").StatementResultingChanges;
    fileRowForOwner(fileId: any, ownerId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    ensureAuthStorage(authConfig?: null): void;
    findAuthUserByProviderEmail(provider: any, email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
    updateAuthUserProfile(row: any): import("node:sqlite").StatementResultingChanges;
    linkAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
    insertAuthSession(row: any): import("node:sqlite").StatementResultingChanges;
    deleteAuthSession(token: any): import("node:sqlite").StatementResultingChanges;
    refreshAuthSession(token: any, expiresAt: any): import("node:sqlite").StatementResultingChanges;
    rotateAuthSession(previousToken: any, row: any): import("node:sqlite").StatementResultingChanges;
    readAuthSessionWithUser(token: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertOAuthState(row: any): import("node:sqlite").StatementResultingChanges;
    consumeOAuthState(state: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    emailCredentialExists(email: any): boolean;
    insertEmailCredential(row: any): import("node:sqlite").StatementResultingChanges;
    findEmailCredentialWithUser(email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    migrateAppSchema(schema: any): any;
    createAppTable(table: any, tableName?: any): any;
    migrateExistingAppTable(existingTable: any, nextTable: any): any;
    referenceExists(field: any, value: any): boolean;
    withTransaction(fn: any): Promise<any>;
    insertAppRow(table: any, row: any): import("node:sqlite").StatementResultingChanges;
    selectAppRowById(table: any, id: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    updateAppRow(table: any, id: any, values: any, options?: {}): import("node:sqlite").StatementResultingChanges | {
        changes: number;
    };
    deleteAppRow(table: any, id: any): import("node:sqlite").StatementResultingChanges;
    selectAppRows(table: any, query?: {}): Record<string, import("node:sqlite").SQLOutputValue>[];
    listInspectableTables(): import("node:sqlite").SQLOutputValue[];
    dumpInspectableDatabase(): {
        name: import("node:sqlite").SQLOutputValue;
        columns: import("node:sqlite").SQLOutputValue[];
        rows: Record<string, import("node:sqlite").SQLOutputValue>[];
    }[];
    runReadOnlyInspectionQuery(sql: any): {
        ok: boolean;
        data: {
            columns: string[];
            rows: Record<string, import("node:sqlite").SQLOutputValue>[];
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
}>;
export declare function createPostgresDatabaseAdapter(options: any): Promise<{
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
    readSystemMetadata(key: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    readSchemaMetadata(): Record<string, import("node:sqlite").SQLOutputValue> | null;
    findFileBucket(ownerId: any, name: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    createFileBucket(row: any): import("node:sqlite").StatementResultingChanges;
    insertFileRow(row: any): import("node:sqlite").StatementResultingChanges;
    updatePendingFileRow(row: any): import("node:sqlite").StatementResultingChanges;
    insertFileUpload(row: any): import("node:sqlite").StatementResultingChanges;
    selectFileById(fileId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    selectLiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
    selectActiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
    selectPendingFileUploadByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    selectFileUpload(uploadId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    completeFileUpload(upload: any, size: any, updatedAt: any): import("node:sqlite").StatementResultingChanges | {
        changes: number;
    };
    deleteFileUploadsForPath(path: any): import("node:sqlite").StatementResultingChanges;
    deleteFileUploadsForFile(ownerId: any, fileId: any): import("node:sqlite").StatementResultingChanges;
    deleteFileUpload(uploadId: any): import("node:sqlite").StatementResultingChanges;
    selectPublicFileRow(publicUrlId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertPublicFileUrl(row: any): import("node:sqlite").StatementResultingChanges;
    revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
    revokePublicFileUrlsForFile(fileId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
    markFileDeleted(fileId: any, deletedAt: any): import("node:sqlite").StatementResultingChanges;
    fileRowForOwner(fileId: any, ownerId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    findAuthUserByProviderEmail(provider: any, email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
    updateAuthUserProfile(row: any): import("node:sqlite").StatementResultingChanges;
    linkAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
    insertAuthSession(row: any): import("node:sqlite").StatementResultingChanges;
    deleteAuthSession(token: any): import("node:sqlite").StatementResultingChanges;
    refreshAuthSession(token: any, expiresAt: any): import("node:sqlite").StatementResultingChanges;
    rotateAuthSession(previousToken: any, row: any): import("node:sqlite").StatementResultingChanges;
    readAuthSessionWithUser(token: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertOAuthState(row: any): import("node:sqlite").StatementResultingChanges;
    consumeOAuthState(state: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    emailCredentialExists(email: any): boolean;
    insertEmailCredential(row: any): import("node:sqlite").StatementResultingChanges;
    findEmailCredentialWithUser(email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    referenceExists(field: any, value: any): boolean;
    insertAppRow(table: any, row: any): import("node:sqlite").StatementResultingChanges;
    selectAppRowById(table: any, id: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    updateAppRow(table: any, id: any, values: any, options?: {}): import("node:sqlite").StatementResultingChanges | {
        changes: number;
    };
    deleteAppRow(table: any, id: any): import("node:sqlite").StatementResultingChanges;
    selectAppRows(table: any, query?: {}): Record<string, import("node:sqlite").SQLOutputValue>[];
}>;
export declare function createPostgresConnection(url: any): Promise<{
    readonly backendKeyData: Buffer<ArrayBuffer> | null;
    query(sql: any): Promise<{
        fields: any[];
        rows: {}[];
        rowCount: number;
    }>;
    close(): Promise<void>;
}>;
declare function postgresInterpolate(sql: any, params?: never[]): string;
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
    ensureAuthStorage(authConfig?: null): Promise<void>;
    consumeOAuthState(state: any): Promise<any>;
    migrateAppSchema(schema: any): Promise<void>;
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
            columns: any;
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
    exec(sql: any): Promise<undefined>;
    prepare(sql: any): {
        all(...params: any[]): Promise<any>;
        get(...params: any[]): Promise<any>;
        run(...params: any[]): Promise<{
            changes: number;
            lastInsertRowid: bigint | undefined;
        }>;
        columns(): Promise<any>;
    };
    ensureSystemTable(): void;
    readSystemMetadata(key: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    writeSystemMetadata(key: any, value: any): import("node:sqlite").StatementResultingChanges;
    readSchemaMetadata(): Record<string, import("node:sqlite").SQLOutputValue> | null;
    findFileBucket(ownerId: any, name: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    createFileBucket(row: any): import("node:sqlite").StatementResultingChanges;
    insertFileRow(row: any): import("node:sqlite").StatementResultingChanges;
    updatePendingFileRow(row: any): import("node:sqlite").StatementResultingChanges;
    insertFileUpload(row: any): import("node:sqlite").StatementResultingChanges;
    selectFileById(fileId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    selectLiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
    selectActiveFileByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue>[];
    selectPendingFileUploadByPath(path: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    selectFileUpload(uploadId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    completeFileUpload(upload: any, size: any, updatedAt: any): import("node:sqlite").StatementResultingChanges | {
        changes: number;
    };
    deleteFileUploadsForPath(path: any): import("node:sqlite").StatementResultingChanges;
    deleteFileUploadsForFile(ownerId: any, fileId: any): import("node:sqlite").StatementResultingChanges;
    deleteFileUpload(uploadId: any): import("node:sqlite").StatementResultingChanges;
    selectPublicFileRow(publicUrlId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertPublicFileUrl(row: any): import("node:sqlite").StatementResultingChanges;
    revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
    revokePublicFileUrlsForFile(fileId: any, revokedAt: any): import("node:sqlite").StatementResultingChanges;
    markFileDeleted(fileId: any, deletedAt: any): import("node:sqlite").StatementResultingChanges;
    fileRowForOwner(fileId: any, ownerId: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    findAuthUserByProviderEmail(provider: any, email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
    updateAuthUserProfile(row: any): import("node:sqlite").StatementResultingChanges;
    linkAuthUser(row: any): import("node:sqlite").StatementResultingChanges;
    insertAuthSession(row: any): import("node:sqlite").StatementResultingChanges;
    deleteAuthSession(token: any): import("node:sqlite").StatementResultingChanges;
    refreshAuthSession(token: any, expiresAt: any): import("node:sqlite").StatementResultingChanges;
    rotateAuthSession(previousToken: any, row: any): import("node:sqlite").StatementResultingChanges;
    readAuthSessionWithUser(token: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    insertOAuthState(row: any): import("node:sqlite").StatementResultingChanges;
    emailCredentialExists(email: any): boolean;
    insertEmailCredential(row: any): import("node:sqlite").StatementResultingChanges;
    findEmailCredentialWithUser(email: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    createAppTable(table: any, tableName?: any): any;
    referenceExists(field: any, value: any): boolean;
    insertAppRow(table: any, row: any): import("node:sqlite").StatementResultingChanges;
    selectAppRowById(table: any, id: any): Record<string, import("node:sqlite").SQLOutputValue> | null;
    updateAppRow(table: any, id: any, values: any, options?: {}): import("node:sqlite").StatementResultingChanges | {
        changes: number;
    };
    deleteAppRow(table: any, id: any): import("node:sqlite").StatementResultingChanges;
    selectAppRows(table: any, query?: {}): Record<string, import("node:sqlite").SQLOutputValue>[];
}>;
declare function libsqlExecute({ endpoint, authToken, transaction, sql, params, close }: {
    endpoint: any;
    authToken: any;
    transaction: any;
    sql: any;
    params?: never[] | undefined;
    close: any;
}): Promise<any>;
declare function libsqlPipeline({ endpoint, authToken, transaction, requests, close }: {
    endpoint: any;
    authToken: any;
    transaction?: null | undefined;
    requests: any;
    close?: boolean | undefined;
}): Promise<any>;
declare function logPayloadMaxBytes(config?: {}): number;
declare function readRecentLogEvents(sqlite: any, limit?: number): any;
declare function createAppTable(sqlite: any, table: any, tableName?: any): any;
declare function commandError(message: any, hint: any, code?: null): Error;
export declare function routeEndpoint(database: any, request: any, response: any): Promise<boolean>;
export declare function handleFileHttpRoute(database: any, request: any, response: any, websocketHub?: null): Promise<boolean>;
export declare function routeRuntimeHealth(database: any, request: any, response: any): Promise<boolean>;
export declare function checkRuntimeSqlite(database: any): Promise<any>;
export declare function checkRuntimeFileStorage(database: any): Promise<any>;
export declare function createPendingFileUpload(database: any, auth: any, message: any): Promise<any>;
export declare function completePendingFileUpload(database: any, uploadId: any, request: any, websocketHub?: null): Promise<{
    ok: boolean;
    data: null;
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
    error: null;
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
    error: null;
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
    expiresAt: null;
    error?: undefined;
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
            expiresAt: string | null | undefined;
            revokedAt: null;
        };
    };
    error: null;
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
    error: null;
}>;
declare function createEndpointTableApi(database: any, table: any, query?: {}, contextGetter?: null): {
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
declare function createAclDenialLogData({ context, table, operation, row, previous, next }: {
    context: any;
    table: any;
    operation: any;
    row?: null | undefined;
    previous?: null | undefined;
    next?: null | undefined;
}): {
    resource: {
        kind: string;
        name: any;
    };
    operation: any;
    rule: {
        category: string;
        declaredOperation: any;
    };
    actor: {
        userId: any;
        provider: any;
        isAuthenticated: any;
        isGuest: any;
    };
    row: {
        previousId: any;
        nextId: any;
        previousFields: string[];
        nextFields: string[];
        changedFields: string[];
        previousPresent: boolean;
        nextPresent: boolean;
        id?: undefined;
        fields?: undefined;
    } | {
        id: any;
        fields: string[];
        previousId?: undefined;
        nextId?: undefined;
        previousFields?: undefined;
        nextFields?: undefined;
        changedFields?: undefined;
        previousPresent?: undefined;
        nextPresent?: undefined;
    };
};
declare function createAclDeniedError(logData?: null): Error;
export declare function listDatabaseTables(database: any): Promise<any>;
export declare function dumpDatabase(database: any): Promise<any>;
export declare function runReadOnlyQuery(database: any, sql: any): Promise<any>;
declare function isInternalLogIndexMetadataRow(row: any, sql?: string): boolean;
export declare function simulateLocalIdentitySession(database: any, options?: {}): Promise<{
    ok: boolean;
    data: null;
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
            picture: string | null;
            isAuthenticated: boolean;
            isGuest: boolean;
            provider: string;
        };
    };
    error: null;
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
        displayName: string | undefined;
        email: string | undefined;
        picture: null;
        isAuthenticated: boolean;
        isGuest: boolean;
        provider: string;
    };
    error?: undefined;
}>;
declare function createAnonymousAuthTables(sqlite: any, authConfig?: null): void;
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
    data: null;
    error: {
        message: any;
        hint: any;
    };
} | {
    rows: null;
    error: {
        message: any;
        hint: any;
    };
    data?: undefined;
} | {
    data: any;
    error: null;
    rows?: undefined;
} | {
    rows: any;
    error: null;
    data?: undefined;
}>;
export declare function runMutation(database: any, auth: any, mutationName: any, args: any): Promise<any>;
declare function runAppMessage(database: any, auth: any, messageName: any, data: any, options?: {}): Promise<{
    data: null;
    error: {
        message: any;
        hint: any;
    };
} | {
    data: any;
    error: null;
}>;
export {};
//# sourceMappingURL=server-runtime-source.d.ts.map