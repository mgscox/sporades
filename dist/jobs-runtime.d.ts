type LooseRecord = Record<string, any>;
type RuntimeConfig = LooseRecord;
export declare const RESERVED_JOB_NAME_PREFIX = "_sporades";
export declare const STRIPE_EVENT_JOB = "_sporades.stripe-event";
export declare const STRIPE_EVENT_PAYLOAD_RETENTION_MS: number;
export declare const STRIPE_EVENT_PAYLOAD_CLEANUP_BATCH_SIZE = 100;
export declare function stripeEventPayloadRetentionDeadline(settledAt: string): string | null;
export declare function stripeEventPayloadRetentionStorageValue(settledAt: string): string;
/** Internal privacy maintenance for the reserved Stripe Event Job only. */
export declare function cleanupExpiredStripeEventPayloads(database: LooseRecord, options?: LooseRecord): Promise<Readonly<{
    assignedCount: number;
    classifiedCount: number;
    redactedCount: number;
    nextCleanupAt: any;
}>>;
export declare function scheduleStripeEventPayloadCleanup(database: LooseRecord, dueAt: number | null): void;
export declare function startStripeEventPayloadCleanup(database: LooseRecord): any;
export declare function stopStripeEventPayloadCleanup(database: LooseRecord): Promise<undefined> | undefined;
export declare function scheduleDefinitionsFromCapsule(capsuleDefinition: any, jobs: any[]): any[];
export declare function resolveSchedulePayloadFactoryTimeoutMs(config?: RuntimeConfig): number;
export declare function parseScheduleExpression(value: any): any;
export declare function nextScheduleOccurrence(fields: Set<number>[], after: Date, timezone: string): Date;
export declare function ensureScheduleStorage(sqlite: LooseRecord, scheduleStorageFault?: (boundary: string, details: LooseRecord) => any): Promise<void>;
export declare function finishFailedScheduledOccurrence(database: LooseRecord, definition: any, occurrence: Date, error: any, claimToken: string): Promise<{
    finished: boolean;
    nextOccurrence: null;
    superseded: boolean;
} | {
    finished: boolean;
    nextOccurrence: null;
    superseded?: undefined;
} | {
    nextOccurrence: string;
    exhausted: boolean;
    finished: boolean;
    superseded?: undefined;
} | {
    nextOccurrence: null;
    exhausted: boolean;
    finished: boolean;
    superseded?: undefined;
}>;
export declare function nextScheduleCursor(definition: any, occurrence: Date): {
    nextOccurrence: string;
    exhausted: boolean;
} | {
    nextOccurrence: null;
    exhausted: boolean;
};
export declare function scheduledOccurrenceIdentity(database: LooseRecord, scheduleName: string, scheduledFor: string): string;
export declare function resolveSchedulePayload(database: LooseRecord, definition: any, scheduledFor: string, context: LooseRecord): Promise<{
    ok: boolean;
    value: any;
} | {
    ok: boolean;
    value?: undefined;
}>;
export declare function abortSchedulePayloadFactories(database: LooseRecord): void;
export declare function createRuntimeClock(clock: LooseRecord | undefined): LooseRecord;
/** Internal full-runtime test support; not exported from sporades/server or sporades/client. */
export declare function createControllableRuntimeClock(initialInstant: string | number | Date): {
    now: () => Date;
    setInstant(instant: string | number | Date): void;
    advanceBy(delayMs: number): void;
    setTimer(callback: () => any, delayMs: number): number;
    clearTimer(id: number): void;
    runDueTimers(): Promise<void>;
};
export declare function runtimeOwnedJobHandlers(runtime: {
    prepareEmailPasswordResetDelivery: (context: LooseRecord, payload: LooseRecord) => Promise<LooseRecord | null>;
    dispatchStripeEvent: (context: LooseRecord, event: LooseRecord) => Promise<LooseRecord>;
    performTeamBillingCheckout: (context: LooseRecord, payload: LooseRecord) => Promise<LooseRecord | null>;
    expireTeamBillingCheckout: (context: LooseRecord, payload: LooseRecord) => Promise<null>;
    performTeamBillingPortal: (context: LooseRecord, payload: LooseRecord) => Promise<LooseRecord | null>;
    expireTeamBillingPortal: (context: LooseRecord, payload: LooseRecord) => Promise<null>;
}): {
    name: string;
    handler: (ctx: LooseRecord, payload: LooseRecord) => Promise<any>;
}[];
export declare function jobHandlersFromCapsuleDefinition(capsuleDefinition: any): any[];
export declare function ensureJobStorage(sqlite: LooseRecord): Promise<void>;
export declare function scheduleSummary(sqlite: LooseRecord, row: any): Promise<{
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
}>;
export declare function scheduleCursorStateIsConsistent(enabled: any, exhausted: any, nextOccurrence: any): boolean;
export declare function assertJobScheduleProvenance(row: any, expected: any): void;
export declare function jobError(code: string, message: string, hint: string): any;
export declare function boundedJobJson(value: any, limit: number, code: string, label: string): string;
/** Canonical bounded AuthContext persisted at the successful enqueue boundary. */
export declare function canonicalJobAuthSnapshot(auth: LooseRecord): {
    userId: string | null;
    displayName: string | null;
    email: string | null;
    picture: string | null;
    isAuthenticated: any;
    isGuest: any;
    provider: string | null;
};
/**
 * Bounds profile metadata at the enqueue/migration boundary without rejecting Auth profiles that
 * were valid before durable Job provenance introduced narrower storage limits. Authority-bearing
 * identity fields remain strict; only display metadata is shortened or omitted.
 */
export declare function captureJobAuthSnapshot(auth: LooseRecord): {
    userId: string | null;
    displayName: string | null;
    email: string | null;
    picture: string | null;
    isAuthenticated: any;
    isGuest: any;
    provider: string | null;
};
/** Canonical Credential provenance; secret material and granted scopes have no accepted field. */
export declare function canonicalJobCredentialProvenance(credential: LooseRecord): {
    kind: string;
    id?: undefined;
    name?: undefined;
} | {
    kind: string;
    id: string | null;
    name: string | null;
};
export declare function legacyJobAuthFallback(userId: unknown, provider: unknown): {
    userId: string | null;
    displayName: string;
    email: null;
    picture: null;
    isAuthenticated: boolean;
    isGuest: boolean;
    provider: string;
};
export declare function readJobAuthSnapshot(row: LooseRecord): {
    userId: string | null;
    displayName: string | null;
    email: string | null;
    picture: string | null;
    isAuthenticated: any;
    isGuest: any;
    provider: string | null;
};
export declare function readJobCredentialProvenance(row: LooseRecord): {
    kind: string;
    id?: undefined;
    name?: undefined;
} | {
    kind: string;
    id: string | null;
    name: string | null;
};
export declare function jobState(row: any, includeDetail: boolean): any;
export declare function jobActorProvider(auth: LooseRecord): string;
/** Read the bounded operator view of every Job in one adapter snapshot. */
export declare function inspectRuntimeJobs(adapter: LooseRecord): Promise<any>;
/** Read the bounded operator view of every Schedule in one adapter snapshot. */
export declare function inspectRuntimeSchedules(adapter: LooseRecord): Promise<any>;
export declare const MAX_JOB_TIMESTAMP_MS: number;
export declare const MIN_JOB_TIMESTAMP_MS: number;
export declare function normalizeJobAvailableAt(value: any): string;
export declare function isCanonicalJobTimestamp(value: any): boolean;
export declare function normalizeJobRetry(value: any): {
    maxAttempts: any;
    delayMs: any;
};
export declare function parsePersistedJobRetry(value: any): {
    maxAttempts: any;
    delayMs: any;
} | null;
export declare function jobTimestampAfter(instant: Date, delayMs: number): string | null;
export declare function invalidJobRetryPolicyFailure(): {
    code: string;
    message: string;
};
export declare function cancelJob(database: LooseRecord, context: any, id: any): Promise<any>;
export declare function commitPendingJobCancellationAborts(context: LooseRecord | undefined): void;
export declare function dropPendingJobCancellationAborts(context: LooseRecord | undefined): void;
export declare function jobSummary(row: any): {
    id: any;
    handler: any;
    status: any;
    attempts: number;
};
export declare function encodeJobCursor(row: any): string;
export declare function decodeJobCursor(value: any): any;
export declare function safeJobFailure(error: any): {
    code: any;
    message: any;
};
export {};
//# sourceMappingURL=jobs-runtime.d.ts.map