export declare const FATAL_RUNTIME_RESTART_POLICY: {
    dev: {
        mode: string;
        maxAttempts: number;
        backoffMs: number;
        restartFatalEvents: string[];
        exitFatalEvents: string[];
    };
    container: {
        mode: string;
        maxAttempts: number;
        backoffMs: number;
        dockerRestart: string;
        restartFatalEvents: string[];
        exitFatalEvents: string[];
    };
    hosted: {
        mode: string;
        maxAttempts: number;
        backoffMs: number;
        dockerRestart: string;
        restartFatalEvents: string[];
        exitFatalEvents: string[];
        exhaustedRouteTarget: string;
        verificationFallbackOnly: boolean;
    };
};
export declare function restartPolicyForMode(mode: any): any;
export declare function restartPolicyStatus(mode: any, overrides?: {}): {
    verificationFallbackOnly?: boolean;
    exhaustedRouteTarget?: any;
    mode: any;
    maxAttempts: any;
    backoffMs: any;
    dockerRestart: any;
    restartFatalEvents: any;
    exitFatalEvents: any;
};
//# sourceMappingURL=runtime-restart-policy.d.ts.map