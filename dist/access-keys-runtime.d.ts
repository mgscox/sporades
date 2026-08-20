type LooseRecord = Record<string, any>;
export declare const ACCESS_KEY_CURRENT_LIMIT = 100;
export declare const ACCESS_KEY_RETAINED_LIMIT = 1000;
export declare const ACCESS_KEY_GRANT_LIMIT = 128;
export declare const ACCESS_KEY_GRANT_BYTE_LIMIT = 256;
export declare const ACCESS_KEY_GRANTS_JSON_BYTE_LIMIT: number;
export declare function createAccessKeyTables(adapter: LooseRecord): any;
export declare function createCurrentUserAccessKeysApi(database: LooseRecord, contextGetter: () => LooseRecord): {
    issue(input: unknown): Promise<{
        accessKey: {
            id: any;
            name: any;
            grants: any[];
            effectiveScopes: string[];
            status: string;
            createdAt: any;
            expiresAt: any;
            rotatedAt: any;
            revokedAt: any;
            revocationCause: any;
            lastUsedAt: any;
            lifecycleRevision: number;
        };
        token: string;
    }>;
    list(options?: unknown): Promise<{
        accessKeys: {
            id: any;
            name: any;
            grants: any[];
            effectiveScopes: string[];
            status: string;
            createdAt: any;
            expiresAt: any;
            rotatedAt: any;
            revokedAt: any;
            revocationCause: any;
            lastUsedAt: any;
            lifecycleRevision: number;
        }[];
        declaredScopes: string[];
        nextCursor: string | null;
        totalCount: number;
    }>;
    revoke(id: unknown): Promise<{
        accessKey: {
            id: any;
            name: any;
            grants: any[];
            effectiveScopes: string[];
            status: string;
            createdAt: any;
            expiresAt: any;
            rotatedAt: any;
            revokedAt: any;
            revocationCause: any;
            lastUsedAt: any;
            lifecycleRevision: number;
        };
    }>;
};
export declare function readAccessKeyAuthorization(request: LooseRecord): {
    token: string;
    selector: string;
    verifier: string;
} | null;
export declare function resolveAccessKeyCredential(database: LooseRecord, request: LooseRecord, sessionToken: unknown): Promise<{
    auth: Readonly<{
        [x: string]: any;
    }>;
    credential: Readonly<{
        [x: string]: any;
    }>;
    grants: any;
    record: any;
    admittedAt: any;
} | null>;
export declare function accessKeyAuthenticationError(reason: string, limited?: boolean): LooseRecord;
export declare function emitAccessKeyAdmittedAudit(database: LooseRecord, context: LooseRecord, record: LooseRecord): void;
export declare function accessKeyCredentialLogAttribution(context: LooseRecord | null | undefined): {
    credential?: undefined;
} | {
    credential: {
        kind: string;
        id: any;
        name: any;
    };
};
export declare function recordAccessKeyUsage(database: LooseRecord, admission: LooseRecord): Promise<void>;
export declare function createAccessKeySecret(): {
    selector: string;
    verifier: string;
    token: string;
};
export declare function accessKeyVerifierDigest(selector: string, verifier: string): string;
export declare function flushAccessKeyLifecycleAuditEvents(database: LooseRecord, context: LooseRecord | undefined): Promise<void>;
export declare function dropAccessKeyLifecycleAuditEvents(context: LooseRecord | undefined): void;
export {};
//# sourceMappingURL=access-keys-runtime.d.ts.map