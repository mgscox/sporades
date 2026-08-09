type LooseRecord = Record<string, any>;
export declare function createUserPreferencesTables(sqlite: LooseRecord): any;
export declare function migrateAnonymousPreferences(database: LooseRecord, auth: LooseRecord, targetUserId: any, sqlite?: LooseRecord | null): Promise<void>;
export declare function readCurrentUserPreferences(database: LooseRecord, auth: LooseRecord): Promise<{
    ok: boolean;
    data: {
        preferences: any;
    };
    error: null;
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
export {};
//# sourceMappingURL=user-preferences-runtime.d.ts.map