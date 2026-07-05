export type BaseRestartPolciy = {
    mode: string;
    maxAttempts: number;
    backoffMs: number;
    dockerRestart?: string;
    restartFatalEvents: string[];
    exitFatalEvents: string[];
};
export type DockerRestartPolcy = BaseRestartPolciy & {
    dockerRestart: string;
};
export type CloudDockerRestartPolcy = BaseRestartPolciy & {
    exhaustedRouteTarget: string;
    verificationFallbackOnly: boolean;
};
export type RestartPolicy = CloudDockerRestartPolcy | DockerRestartPolcy | BaseRestartPolciy;
export declare const FATAL_RUNTIME_RESTART_POLICY: Record<string, RestartPolicy>;
export declare function restartPolicyForMode(mode: string): RestartPolicy;
export declare function restartPolicyStatus(mode: string, overrides?: {}): {
    verificationFallbackOnly?: boolean | undefined;
    exhaustedRouteTarget?: string | undefined;
    mode: string;
    maxAttempts: number;
    backoffMs: number;
    dockerRestart: string;
    restartFatalEvents: string[];
    exitFatalEvents: string[];
};
//# sourceMappingURL=runtime-restart-policy.d.ts.map