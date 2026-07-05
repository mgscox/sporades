export type BaseRestartPolciy = {
  mode: string;
  maxAttempts: number;
  backoffMs: number;
  dockerRestart?: string;
  restartFatalEvents: string[];
  exitFatalEvents: string[];
}
export type DockerRestartPolcy = BaseRestartPolciy & {
  dockerRestart: string;
}
export type CloudDockerRestartPolcy = BaseRestartPolciy & {
  exhaustedRouteTarget: string;
  verificationFallbackOnly: boolean;
}
export type RestartPolicy = CloudDockerRestartPolcy | DockerRestartPolcy | BaseRestartPolciy;
export const FATAL_RUNTIME_RESTART_POLICY: Record<string, RestartPolicy> = {
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

export function restartPolicyForMode(mode: string): RestartPolicy {
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

export function restartPolicyStatus(mode: string, overrides = {}) {
  const policy = restartPolicyForMode(mode);
  return {
    mode: policy.mode,
    maxAttempts: policy.maxAttempts,
    backoffMs: policy.backoffMs,
    dockerRestart: (policy as DockerRestartPolcy).dockerRestart ?? null,
    restartFatalEvents: policy.restartFatalEvents,
    exitFatalEvents: policy.exitFatalEvents,
    ...((policy as CloudDockerRestartPolcy).exhaustedRouteTarget ? { exhaustedRouteTarget: (policy as CloudDockerRestartPolcy).exhaustedRouteTarget } : {}),
    ...((policy as CloudDockerRestartPolcy).verificationFallbackOnly ? { verificationFallbackOnly: true } : {}),
    ...overrides,
  };
}
