type LooseRecord = Record<string, any>;
export declare function createServiceUsersApi(database: LooseRecord, contextGetter: () => LooseRecord, sessionToken: string | null, options?: {
    mutationSurface?: boolean;
}): {
    create(input: unknown): Promise<any>;
    issueAccessKey(userId: unknown, input: unknown): Promise<any>;
    listAccessKeys(userId: unknown, options?: unknown): Promise<any>;
    rotateAccessKey(userId: unknown, id: unknown, options: unknown): Promise<any>;
    revokeAccessKey(userId: unknown, id: unknown): Promise<any>;
    disable(userId: unknown): Promise<any>;
};
export {};
//# sourceMappingURL=service-users-runtime.d.ts.map