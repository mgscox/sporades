type LooseRecord = Record<string, any>;
export declare const PRIVILEGED_AUDIT_SCHEMA = "sporades.privileged-audit.v1";
export declare const PRIVILEGED_AUDIT_ACTOR_KINDS: Set<string>;
export declare const PRIVILEGED_AUDIT_OUTCOMES: Set<string>;
export declare function createPrivilegedAuditEmitter(log: {
    emit: (input: LooseRecord) => any;
}): {
    emit(details: LooseRecord): any;
};
export declare function emitPrivilegedAuditEvent(target: LooseRecord, details?: LooseRecord): any;
export declare function emitPrivilegedRunAudit(database: LooseRecord, context: LooseRecord, details: LooseRecord): Promise<any>;
export declare function reindexPrivilegedAuditEventsAfterRollback(database: LooseRecord, context: LooseRecord | undefined): Promise<void>;
export declare function normalizePrivilegedRunSignal(value: any): any;
export declare function createPrivilegedRunAbortError(): import("./runtime-errors.js").HelperError;
export declare function createPrivilegedRunAuditDetails(context: LooseRecord, options: LooseRecord): {
    actorKind: string;
    operation: string;
    surface: string;
    targetResourceKind: string;
    correlation: any;
    request: any;
    source: string;
    metadata: any;
};
export declare function createPrivilegedRunPublicError(cause: any): import("./runtime-errors.js").HelperError;
export declare function createPrivilegedAuditEmissionPublicError(cause: any, context?: LooseRecord | undefined): import("./runtime-errors.js").HelperError;
export declare function isPrivilegedAuditEmissionPublicError(error: any): boolean;
export declare function createPrivilegedScheduleApi(database: LooseRecord, contextGetter: () => LooseRecord): {
    get(name: any): Promise<{
        name: string;
        expression: string;
        timezone: string;
        missedRun: string;
        enabled: boolean;
        nextOccurrence: string | null;
        latestOccurrence: {
            scheduledFor: any;
            outcome: string;
            jobId: any;
            errorCode?: undefined;
        } | {
            scheduledFor: any;
            outcome: string;
            errorCode: any;
            jobId?: undefined;
        } | null;
    } | null>;
    list(): Promise<{
        name: string;
        expression: string;
        timezone: string;
        missedRun: string;
        enabled: boolean;
        nextOccurrence: string | null;
        latestOccurrence: {
            scheduledFor: any;
            outcome: string;
            jobId: any;
            errorCode?: undefined;
        } | {
            scheduledFor: any;
            outcome: string;
            errorCode: any;
            jobId?: undefined;
        } | null;
    }[]>;
};
export declare function createPrivilegedFileApi(database: LooseRecord, contextGetter: () => LooseRecord): Readonly<{
    url(fileReference: any): Promise<any>;
    createPublicUrl(fileReference: any, options?: LooseRecord): Promise<any>;
    delete(fileReference: any): Promise<any>;
    unsupported(): never;
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
export declare function safePrivilegedAuditErrorCode(value: any, outcome?: string): string | null;
export declare function normalizeTableAcl(tableName: any, aclRules: LooseRecord | undefined): LooseRecord;
export declare function normalizeFileAcl(aclRules: LooseRecord | undefined): LooseRecord;
export declare function createTableAclContext(context: any, database: any): any;
export declare function createFileAclContext(auth: LooseRecord, database: LooseRecord): Readonly<{
    auth: Readonly<{
        [x: string]: any;
    }>;
    acl: Readonly<{
        db: Readonly<{
            get(tableName: any, id: any): {
                [x: string]: any;
            } | null;
            exists(tableName: any, id: any): boolean;
        }>;
        storage: Readonly<{
            get(resourceName: any, reference: any): {
                originalName: any;
                owner: any;
                ownerId: any;
                status: any;
                createdAt: any;
                updatedAt: any;
                deletedAt: any;
                id: any;
                bucket: any;
                size: number;
                type: any;
                name: any;
                path: any;
                version: any;
            } | null;
            exists(resourceName: any, reference: any): boolean;
        }>;
        teams: Readonly<{
            isMember(teamId: any): boolean;
            isAdmin(teamId: any): boolean;
            hasRole(teamId: any, role: any): boolean;
            hasAnyRole(teamId: any, roles: any): boolean;
        }>;
    }>;
}>;
export declare function applyFileAcl(database: LooseRecord, operation: string, row: LooseRecord, auth: LooseRecord): boolean | Promise<boolean>;
export declare function grantPrivilegedDbAccess(context: any): any;
export declare function revokePrivilegedDbAccess(context: any): any;
export declare function runTableWriteWithAcl(database: any, table: LooseRecord, operation: string, previous: any, next: any, contextGetter: any, write: () => any): any;
export declare function applyReadAcl(database: any, table: LooseRecord, row: any, context: any): boolean | Promise<boolean>;
export declare function filterRowsByReadAcl(database: any, table: any, rows: any[], context: any): any[] | Promise<any[]>;
export declare const ACL_HELPER_STATE: unique symbol;
export declare function emitAclDeniedLog(database: LooseRecord, details: LooseRecord): void;
export declare function assertActivePrivilegedJobAccess(contextGetter: () => LooseRecord): void;
export declare function drainPendingAclWrites(context: LooseRecord): Promise<void>;
export {};
//# sourceMappingURL=acl-runtime.d.ts.map