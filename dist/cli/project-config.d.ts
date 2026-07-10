import { type LooseRecord } from "./cli-support.js";
export declare const SECURITY_SESSIONS: Set<string>;
export declare function readProjectConfig(projectDir: string): Promise<any>;
export declare function validateSchedulingConfig(scheduling: LooseRecord): void;
export declare function readOptionalProjectSecurity(projectDir: string, session: string): Promise<{
    cors: {
        sameOrigin: boolean;
        publicDev: boolean;
        allowedOrigins: any[];
        allowedOriginPatterns: string[];
        requireExplicitCrossOrigin: boolean;
    };
    headers: {
        contentTypeOptions: string;
        referrerPolicy: string;
        frameOptions: string;
        permissionsPolicy: string;
        crossOriginOpenerPolicy: string;
        suppressTechnologyHeaders: boolean;
    };
    csp: {
        mode: any;
        header: string;
        directives: any;
    };
} | null>;
export declare function validateProjectConfigShape(config: unknown): void;
export declare function validateSecurityConfig(security: LooseRecord): void;
export declare function resolveEffectiveSecurityPolicy(config: LooseRecord, session: string): {
    cors: {
        sameOrigin: boolean;
        publicDev: boolean;
        allowedOrigins: any[];
        allowedOriginPatterns: string[];
        requireExplicitCrossOrigin: boolean;
    };
    headers: {
        contentTypeOptions: string;
        referrerPolicy: string;
        frameOptions: string;
        permissionsPolicy: string;
        crossOriginOpenerPolicy: string;
        suppressTechnologyHeaders: boolean;
    };
    csp: {
        mode: any;
        header: string;
        directives: any;
    };
};
export declare function resolveLocalContainerSshAccess(config: LooseRecord, projectDir: string): Promise<{
    enabled: boolean;
    authorizedKeysPath: null;
    keyCount: number;
    fingerprints?: undefined;
} | {
    enabled: boolean;
    authorizedKeysPath: string;
    keyCount: number;
    fingerprints: string[];
}>;
export declare function resolveAuthorizedKeyLines(ssh: LooseRecord, projectDir: string): Promise<string[]>;
export declare function authorizedKeyFingerprint(line: string): string;
export declare function withRuntimeSecuritySession(config: LooseRecord, session: string): {
    __sporadesSession: string;
};
export declare function readBaseImageUpdatePolicy(config: LooseRecord): string;
//# sourceMappingURL=project-config.d.ts.map