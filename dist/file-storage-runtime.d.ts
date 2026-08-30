type LooseRecord = Record<string, any>;
type RuntimeConfig = LooseRecord;
type RuntimeEnv = Record<string, string | undefined>;
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
export declare function checkRuntimeFileStorage(database: LooseRecord): Promise<any>;
export declare function createFileStorageTables(sqlite: LooseRecord): any;
export declare function contentTypeForFile(type: any): string;
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
export declare function revokePublicFileUrl(database: LooseRecord, auth: LooseRecord, publicUrlId: any): Promise<{
    ok: boolean;
    error: {
        message: string;
        hint: string;
    };
    data?: undefined;
} | {
    ok: boolean;
    data: {
        publicUrl: {
            id: any;
            revokedAt: string;
        };
    };
    error: any;
}>;
export declare function deletePrivateFile(database: LooseRecord, auth: LooseRecord, fileReference: any): Promise<any>;
export declare function fileRowForOwner(database: LooseRecord, fileId: string, ownerId: any): Promise<any>;
export declare function fileRowForActor(database: LooseRecord, auth: LooseRecord, fileReference: any, credential?: LooseRecord): Promise<any>;
export declare function fileMetadataFromRow(row: LooseRecord): {
    id: any;
    bucket: any;
    size: number;
    type: any;
    name: any;
    path: any;
    version: any;
};
export declare function ensureFileBucket(database: LooseRecord, ownerId: any, name: string, now: any): Promise<any>;
export declare function normalizeAbsoluteFilePath(value: string): string;
export declare function isAbsoluteFilePath(value: string): boolean;
export declare function resolvePrivilegedLiveFileReference(database: LooseRecord, reference: any): Promise<{
    ok: boolean;
    error: {
        message: string;
        hint: string;
    };
} | {
    ok: boolean;
    row: any;
}>;
export declare function createStructuredFileError(message: string, hint: string): {
    message: string;
    hint: string;
};
export {};
//# sourceMappingURL=file-storage-runtime.d.ts.map