type LooseRecord = Record<string, any>;
export declare function createTeamTables(adapter: LooseRecord): any;
export declare function createCurrentUserTeamsApi(database: LooseRecord, auth: LooseRecord): {
    list(): Promise<{
        teams: any;
    }>;
};
export declare function listCurrentUserTeams(database: LooseRecord, auth: LooseRecord): Promise<{
    teams: any;
}>;
export declare function bootstrapInitialTeamForLinkedUser(tx: LooseRecord, userId: any): Promise<string>;
export {};
//# sourceMappingURL=teams-runtime.d.ts.map