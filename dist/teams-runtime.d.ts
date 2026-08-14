type LooseRecord = Record<string, any>;
export declare const TEAM_MEMBERSHIP_MAX = 25;
export declare function createTeamTables(adapter: LooseRecord): any;
export declare function createCurrentUserTeamsApi(database: LooseRecord, auth: LooseRecord): {
    list(): Promise<{
        teams: any;
    }>;
    create(name: any): Promise<{
        team: any;
    }>;
    rename(teamId: any, name: any): Promise<{
        team: any;
    }>;
};
export declare function listCurrentUserTeams(database: LooseRecord, auth: LooseRecord): Promise<{
    teams: any;
}>;
export declare function createAdditionalTeam(database: LooseRecord, auth: LooseRecord, name: any): Promise<{
    team: any;
}>;
export declare function renameCurrentUserTeam(database: LooseRecord, auth: LooseRecord, teamId: any, name: any): Promise<{
    team: any;
}>;
export declare function bootstrapInitialTeamForLinkedUser(tx: LooseRecord, userId: any): Promise<string>;
export {};
//# sourceMappingURL=teams-runtime.d.ts.map