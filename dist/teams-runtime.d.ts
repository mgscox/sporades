type LooseRecord = Record<string, any>;
export declare const TEAM_MEMBER_LIST_MAX = 100;
export declare const TEAM_MEMBERSHIP_MAX = 25;
export declare const TEAM_JOIN_LINK_DEFAULT_TTL_SECONDS: number;
export declare const TEAM_JOIN_LINK_MIN_TTL_SECONDS: number;
export declare const TEAM_JOIN_LINK_MAX_TTL_SECONDS: number;
export declare const TEAM_JOIN_LINK_MAX_OUTSTANDING = 20;
export declare const TEAM_JOIN_LINK_CREATION_MAX_PER_HOUR = 10;
export declare function createTeamTables(adapter: LooseRecord): any;
export declare function createCurrentUserTeamsApi(database: LooseRecord, auth: LooseRecord, contextGetter?: () => LooseRecord): {
    list(): Promise<{
        teams: any;
    }>;
    create(name: any): Promise<{
        team: any;
    }>;
    rename(teamId: any, name: any): Promise<{
        team: any;
    }>;
    listMembers(teamId: any): Promise<any>;
    createJoinLink(teamId: any, email: any, options?: LooseRecord): Promise<{
        id: any;
        link: string;
        createdAt: any;
        expiresAt: any;
    }>;
    listJoinLinks(teamId: any): Promise<any>;
    revokeJoinLink(teamId: any, joinLinkId: any): Promise<{
        revoked: boolean;
    }>;
    inspectJoinLink(code: any): Promise<{
        team: null;
        expiresAt: null;
        usable: boolean;
    } | {
        team: {
            id: string;
            name: string;
        };
        expiresAt: string;
        usable: boolean;
    }>;
};
export declare function resolveTeamJoinLinkConfig(config: LooseRecord): {
    path: string;
    origin: string;
};
export declare function normalizeTeamJoinPath(value: any): string | null;
export declare function createTeamJoinLink(database: LooseRecord, auth: LooseRecord, teamId: any, email: any, options?: LooseRecord, eventContext?: LooseRecord): Promise<{
    id: any;
    link: string;
    createdAt: any;
    expiresAt: any;
}>;
export declare function listTeamJoinLinks(database: LooseRecord, auth: LooseRecord, teamId: any): Promise<any>;
export declare function revokeTeamJoinLink(database: LooseRecord, auth: LooseRecord, teamId: any, joinLinkId: any, eventContext?: LooseRecord): Promise<{
    revoked: boolean;
}>;
export declare function inspectTeamJoinLink(database: LooseRecord, code: any): Promise<{
    team: null;
    expiresAt: null;
    usable: boolean;
} | {
    team: {
        id: string;
        name: string;
    };
    expiresAt: string;
    usable: boolean;
}>;
export declare function listCurrentUserTeams(database: LooseRecord, auth: LooseRecord): Promise<{
    teams: any;
}>;
export declare function createAdditionalTeam(database: LooseRecord, auth: LooseRecord, name: any, eventContext?: LooseRecord): Promise<{
    team: any;
}>;
export declare function renameCurrentUserTeam(database: LooseRecord, auth: LooseRecord, teamId: any, name: any, eventContext?: LooseRecord): Promise<{
    team: any;
}>;
export declare function listTeamMembers(database: LooseRecord, auth: LooseRecord, teamId: any): Promise<any>;
export declare function bootstrapInitialTeamForLinkedUser(tx: LooseRecord, userId: any): Promise<string>;
export declare function flushTeamSecurityEvents(database: LooseRecord, context: LooseRecord | undefined, options?: LooseRecord): void;
export {};
//# sourceMappingURL=teams-runtime.d.ts.map