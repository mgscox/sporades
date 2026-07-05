export const FATAL_RUNTIME_RESTART_POLICY = {
    dev: {
        mode: "automatic",
        maxAttempts: 10,
        backoffMs: 250,
        restartFatalEvents: ["unhandledRejection", "uncaughtException", "initHookFailed", "shutdownHookFailed"],
        exitFatalEvents: ["sigterm", "sigint"],
    },
    container: {
        mode: "bounded",
        maxAttempts: 3,
        backoffMs: 1000,
        dockerRestart: "on-failure:3",
        restartFatalEvents: ["unhandledRejection", "uncaughtException", "initHookFailed"],
        exitFatalEvents: ["sigterm", "sigint", "shutdownHookFailed"],
    },
    hosted: {
        mode: "bounded",
        maxAttempts: 3,
        backoffMs: 1000,
        dockerRestart: "on-failure:3",
        restartFatalEvents: ["unhandledRejection", "uncaughtException", "initHookFailed"],
        exitFatalEvents: ["sigterm", "sigint", "shutdownHookFailed"],
        exhaustedRouteTarget: "hosted-capsule-unavailable",
        verificationFallbackOnly: true,
    },
};
export function restartPolicyForMode(mode) {
    const policy = FATAL_RUNTIME_RESTART_POLICY[mode];
    if (!policy) {
        throw new Error(`Unknown Sporades restart policy mode: ${mode}`);
    }
    return {
        ...policy,
        restartFatalEvents: [...policy.restartFatalEvents],
        exitFatalEvents: [...policy.exitFatalEvents],
    };
}
export function restartPolicyStatus(mode, overrides = {}) {
    const policy = restartPolicyForMode(mode);
    return {
        mode: policy.mode,
        maxAttempts: policy.maxAttempts,
        backoffMs: policy.backoffMs,
        dockerRestart: policy.dockerRestart ?? null,
        restartFatalEvents: policy.restartFatalEvents,
        exitFatalEvents: policy.exitFatalEvents,
        ...(policy.exhaustedRouteTarget ? { exhaustedRouteTarget: policy.exhaustedRouteTarget } : {}),
        ...(policy.verificationFallbackOnly ? { verificationFallbackOnly: true } : {}),
        ...overrides,
    };
}
//# sourceMappingURL=runtime-restart-policy.js.map