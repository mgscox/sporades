type LooseRecord = Record<string, any>;
type TeamJoinLinkInspection = {
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
};
export declare const TEAM_MEMBER_LIST_MAX = 100;
export declare const TEAM_MEMBER_LIST_DEFAULT = 100;
export declare const TEAM_MEMBERSHIP_MAX = 25;
export declare const TEAM_JOIN_LINK_DEFAULT_TTL_SECONDS: number;
export declare const TEAM_JOIN_LINK_MIN_TTL_SECONDS: number;
export declare const TEAM_JOIN_LINK_MAX_TTL_SECONDS: number;
export declare const TEAM_JOIN_LINK_MAX_OUTSTANDING = 20;
export declare const TEAM_JOIN_LINK_CREATION_MAX_PER_HOUR = 10;
export declare const TEAM_APPLICATION_ROLE_MAX = 32;
export declare const TEAM_APPLICATION_ROLE_PATCH_MAX = 16;
export declare function createTeamTables(adapter: LooseRecord): any;
export declare function createCurrentUserTeamsApi(database: LooseRecord, auth: LooseRecord, contextGetter?: () => LooseRecord): {
    list(): Promise<{
        teams: any[];
    }>;
    create(name: any): Promise<{
        team: any;
    }>;
    rename(teamId: any, name: any): Promise<{
        team: any;
    }>;
    listMembers(teamId: any, options?: LooseRecord): Promise<any>;
    countMembers(teamId: any): Promise<any>;
    updateApplicationRoles(teamId: any, userId: any, changes: any): Promise<{
        updated: boolean;
    }>;
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
    inspectJoinLink(code: any): Promise<TeamJoinLinkInspection>;
    validateJoinLink(code: any): Promise<{
        valid: any;
    }>;
    join(code: any): Promise<{
        team: any;
    }>;
    promote(teamId: any, userId: any): Promise<{
        updated: boolean;
    }>;
    demote(teamId: any, userId: any): Promise<{
        updated: boolean;
    }>;
    removeMember(teamId: any, userId: any): Promise<{
        removed: boolean;
    }>;
    leave(teamId: any): Promise<{
        left: boolean;
    }>;
    delete(teamId: any): Promise<{
        deleted: boolean;
    }>;
};
/**
 * The Privileged server role is userless: it can inspect exact Team state, but
 * never acquires current-user membership or administrative authority. Keep
 * this a separate projection rather than reusing the current-user API, whose
 * methods mix inspections with user-scoped and mutating operations.
 */
export declare function createPrivilegedTeamsApi(database: LooseRecord, contextGetter: () => LooseRecord): Readonly<{
    countMembers(teamId: any): Promise<any>;
    listMembers(teamId: any, options?: LooseRecord): Promise<any>;
    listJoinLinks(teamId: any): Promise<any>;
    inspectJoinLink(code: any): Promise<TeamJoinLinkInspection>;
}>;
export declare function resolveTeamJoinLinkConfig(config: LooseRecord): {
    path: string;
    origin: string;
};
export declare function normalizeTeamJoinPath(value: any): string | null;
/**
 * Validate the Capsule-owned vocabulary once at load time. These identifiers
 * are application authority labels, not runtime identities: management roles
 * and the entire Sporades namespace remain unavailable to Capsules.
 */
export declare function normalizeTeamApplicationRoles(value: any): string[];
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
export declare function inspectTeamJoinLink(database: LooseRecord, code: any): Promise<TeamJoinLinkInspection>;
export declare function validateTeamJoinLink(database: LooseRecord, auth: LooseRecord, code: any): Promise<{
    valid: any;
}>;
export declare function joinCurrentUserTeam(database: LooseRecord, auth: LooseRecord, code: any, eventContext?: LooseRecord): Promise<{
    team: any;
}>;
export declare function lockTeamLifecycle(tx: LooseRecord, teamId: string, missingTeamError?: () => Error): Promise<void>;
export declare function listCurrentUserTeams(database: LooseRecord, auth: LooseRecord): Promise<{
    teams: any[];
}>;
export declare function createAdditionalTeam(database: LooseRecord, auth: LooseRecord, name: any, eventContext?: LooseRecord): Promise<{
    team: any;
}>;
export declare function renameCurrentUserTeam(database: LooseRecord, auth: LooseRecord, teamId: any, name: any, eventContext?: LooseRecord): Promise<{
    team: any;
}>;
/** Atomically reconcile one exact membership's Capsule-declared role set. */
export declare function updateTeamMemberApplicationRoles(database: LooseRecord, auth: LooseRecord, teamId: any, userId: any, changes: any, eventContext?: LooseRecord): Promise<{
    updated: boolean;
}>;
/**
 * Team-admin lifecycle mutations deliberately re-read both the actor and
 * target inside one adapter transaction. A browser's old membership list is
 * presentation only; it never authorizes a later role or removal write.
 */
export declare function promoteTeamMember(database: LooseRecord, auth: LooseRecord, teamId: any, userId: any, eventContext?: LooseRecord): Promise<{
    updated: boolean;
}>;
export declare function demoteTeamMember(database: LooseRecord, auth: LooseRecord, teamId: any, userId: any, eventContext?: LooseRecord): Promise<{
    updated: boolean;
}>;
export declare function removeTeamMember(database: LooseRecord, auth: LooseRecord, teamId: any, userId: any, eventContext?: LooseRecord): Promise<{
    removed: boolean;
}>;
export declare function leaveCurrentUserTeam(database: LooseRecord, auth: LooseRecord, teamId: any, eventContext?: LooseRecord): Promise<{
    left: boolean;
}>;
export declare function deleteCurrentUserTeam(database: LooseRecord, auth: LooseRecord, teamId: any, eventContext?: LooseRecord): Promise<{
    deleted: boolean;
}>;
export declare function listTeamMembers(database: LooseRecord, auth: LooseRecord, teamId: any, options?: LooseRecord): Promise<any>;
/** Returns only the exact accepted-membership total for the caller's current Team. */
export declare function countTeamMembers(database: LooseRecord, auth: LooseRecord, teamId: any): Promise<any>;
export declare function bootstrapInitialTeamForLinkedUser(tx: LooseRecord, userId: any): Promise<string>;
export declare function flushTeamSecurityEvents(database: LooseRecord, context: LooseRecord | undefined, options?: LooseRecord): void;
export {};
//# sourceMappingURL=teams-runtime.d.ts.map