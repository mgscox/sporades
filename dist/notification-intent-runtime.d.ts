type RecordValue = Record<string, any>;
export declare const NOTIFICATION_RESERVATION_MS = 30000;
export declare const NOTIFICATION_RECOVERY_SCAN_MS = 30000;
export declare const NOTIFICATION_MAX_BACKOFF_MS = 3600000;
export declare const notificationIntentSchemas: readonly [{
    readonly table: "sporades_notification_intents";
    readonly columns: readonly ["resourceTable", "resourceId", "operationId", "intentId", "payloadDigest", "payloadJson", "messageId", "acceptedAt"];
    readonly primaryKey: readonly ["resourceTable", "resourceId", "operationId", "intentId"];
    readonly definition: "[resourceTable] TEXT NOT NULL, [resourceId] TEXT NOT NULL, [operationId] TEXT NOT NULL, [intentId] TEXT NOT NULL, [payloadDigest] TEXT NOT NULL, [payloadJson] TEXT NOT NULL, [messageId] TEXT NOT NULL, [acceptedAt] TEXT NOT NULL, PRIMARY KEY ([resourceTable], [resourceId], [operationId], [intentId])";
}, {
    readonly table: "sporades_notification_recipients";
    readonly columns: readonly ["resourceTable", "resourceId", "operationId", "intentId", "recipient", "state", "attemptCount", "currentAttemptToken", "currentAttemptDeadline", "nextAttemptAt", "lastOutcomeCategory", "updatedAt"];
    readonly primaryKey: readonly ["resourceTable", "resourceId", "operationId", "intentId", "recipient"];
    readonly definition: "[resourceTable] TEXT NOT NULL, [resourceId] TEXT NOT NULL, [operationId] TEXT NOT NULL, [intentId] TEXT NOT NULL, [recipient] TEXT NOT NULL, [state] TEXT NOT NULL, [attemptCount] TEXT NOT NULL, [currentAttemptToken] TEXT NOT NULL, [currentAttemptDeadline] TEXT NOT NULL, [nextAttemptAt] TEXT NOT NULL, [lastOutcomeCategory] TEXT NOT NULL, [updatedAt] TEXT NOT NULL, PRIMARY KEY ([resourceTable], [resourceId], [operationId], [intentId], [recipient])";
}, {
    readonly table: "sporades_notification_attempts";
    readonly columns: readonly ["resourceTable", "resourceId", "operationId", "intentId", "recipient", "attemptToken", "sequence", "reservedAt", "deadline", "completedAt", "outcomeCategory"];
    readonly primaryKey: readonly ["resourceTable", "resourceId", "operationId", "intentId", "recipient", "attemptToken"];
    readonly definition: "[resourceTable] TEXT NOT NULL, [resourceId] TEXT NOT NULL, [operationId] TEXT NOT NULL, [intentId] TEXT NOT NULL, [recipient] TEXT NOT NULL, [attemptToken] TEXT NOT NULL, [sequence] TEXT NOT NULL, [reservedAt] TEXT NOT NULL, [deadline] TEXT NOT NULL, [completedAt] TEXT NOT NULL, [outcomeCategory] TEXT NOT NULL, PRIMARY KEY ([resourceTable], [resourceId], [operationId], [intentId], [recipient], [attemptToken])";
}, {
    readonly table: "sporades_notification_attempt_keys";
    readonly columns: readonly ["resourceTable", "resourceId", "operationId", "intentId", "attemptKey"];
    readonly primaryKey: readonly ["resourceTable", "resourceId", "operationId", "intentId"];
    readonly definition: "[resourceTable] TEXT NOT NULL, [resourceId] TEXT NOT NULL, [operationId] TEXT NOT NULL, [intentId] TEXT NOT NULL, [attemptKey] TEXT NOT NULL, PRIMARY KEY ([resourceTable], [resourceId], [operationId], [intentId])";
}];
export declare function ensureNotificationIntentStorage(adapter: RecordValue): Promise<void>;
export declare function notificationIntentStorageExists(adapter: RecordValue): Promise<boolean>;
export declare function stageNotificationIntent(adapter: RecordValue, database: RecordValue, identity: RecordValue, input: any, canonicalJson: (value: unknown) => string): Promise<{
    id: any;
    state: "staged";
}>;
export declare function readNotificationIntentStatuses(adapter: RecordValue, identity: RecordValue, intentIds: string[]): Promise<{
    id: string;
    state: string;
    recipients: any;
}[]>;
export declare function notificationRetryDelay(attemptNumber: number): number;
export declare function runNotificationIntentDeliveryPass(database: RecordValue): Promise<boolean>;
export declare function startNotificationIntentWorker(database: RecordValue): Promise<void>;
export declare function stopNotificationIntentWorker(database: RecordValue): any;
export {};
//# sourceMappingURL=notification-intent-runtime.d.ts.map