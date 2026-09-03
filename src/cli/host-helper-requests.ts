import type { JsonObject, JsonValue } from "./host-helper-json.js";
import type {
  HostHelperCapsuleTarget,
  HostHelperHost,
  HostHelperSealedServerEnv,
  HostLifecycleOptions,
  HostedCapsuleBaseImage,
  HostTlsMode,
} from "./hosted-capsule-contract.js";

export type HostHelperAction =
  | "capsule.register"
  | "capsule.sealed-env.rotate-key"
  | "capsule.unregister"
  | "capsule.delete"
  | "capsule.release.install"
  | "capsule.release.list"
  | "capsule.release.rollback"
  | "capsule.start"
  | "capsule.stop"
  | "capsule.restart"
  | "capsule.stats"
  | "capsule.ssh"
  | "capsule.health"
  | "jobs.inspect"
  | "schedules.inspect"
  | "access-keys.list"
  | "access-keys.inspect"
  | "access-keys.revoke"
  | "access-keys.revoke-all"
  | "access-keys.delete"
  | "capsule.list"
  | "host.stats"
  | "host.logs"
  | "host.version"
  | "host.bootstrap";

export type HostHelperVerification = JsonObject & {
  enabled?: boolean;
  fallbackToPreviousRelease?: boolean;
  healthTimeoutMs?: number;
};

export type HostHelperRelease = JsonObject & {
  id: string;
  remoteArchive: string;
  files: string[];
  hostedUrl?: string;
  currentLink?: string;
  directories?: {
    releases?: string;
    release?: string;
    data?: string;
    logs?: string;
    [key: string]: unknown;
  };
  baseImage?: HostedCapsuleBaseImage | null;
  inspection?: { requiredInspectors?: string[] } | null;
  restart?: boolean;
  serverEnvIncluded?: boolean;
  sealedServerEnvIncluded?: boolean;
  sealedServerEnv?: HostHelperSealedServerEnv | null;
  ssh?: {
    enabled?: boolean;
    authorizedKeysPath?: string | null;
    keyCount?: number;
    fingerprints?: string[];
  } | null;
};

export type HostHelperRequestBase = JsonObject & {
  action: HostHelperAction;
  host: HostHelperHost;
  capsule?: HostHelperCapsuleTarget | null;
  release?: HostHelperRelease;
  rollback?: { releaseId: string };
  lifecycle?: HostLifecycleOptions;
  registration?: HostRegistrationOptions;
  unregister?: HostRegistrationOptions;
  delete?: HostRegistrationOptions;
  logs?: HostLogsOptions;
  bootstrap?: HostBootstrapOptions;
  source?: "http" | "stdout" | "stderr";
  lines?: number;
  verification?: HostHelperVerification;
  accessKeys?: JsonObject;
};

export type HostRegistrationOptions = JsonObject & {
  subname?: string;
  domain?: string;
  remoteCapsuleId?: string;
  route?: { log?: { file?: string };[key: string]: unknown };
  baseImage?: HostedCapsuleBaseImage;
  bootstrap?: HostBootstrapOptions;
};

export type HostLogsOptions = JsonObject & {
  source?: "http" | "caddy-combined" | "stdout" | "stderr";
  lines?: number;
  file?: string;
  path?: string;
  accessLog?: { file?: string };
  container?: { name?: string };
};

export type HostBootstrapOptions = JsonObject & {
  domainDirectory?: string;
  network?: string;
  tls?: {
    mode?: HostTlsMode | string;
    directory?: string;
    certificate?: string;
    key?: string;
  };
  directories?: Record<string, string>;
  substrate?: {
    packages?: string[];
    services?: string[];
  };
  caddy?: {
    managedInclude?: string;
    domainInclude?: string;
    accessLog?: string;
  };
};

export type HostBootstrapRequest = HostHelperRequestBase & { action: "host.bootstrap" };
export type HostRegistrationRequest = HostHelperRequestBase & {
  action: "capsule.register";
  capsule: HostHelperCapsuleTarget;
};
export type HostSealedEnvRotationRequest = HostHelperRequestBase & {
  action: "capsule.sealed-env.rotate-key";
  capsule: HostHelperCapsuleTarget;
};
export type HostUnregisterRequest = HostHelperRequestBase & {
  action: "capsule.unregister";
  capsule: HostHelperCapsuleTarget;
};
export type HostDeleteRequest = HostHelperRequestBase & {
  action: "capsule.delete";
  capsule: HostHelperCapsuleTarget;
};
export type HostReleaseInstallRequest = HostHelperRequestBase & {
  action: "capsule.release.install";
  capsule: HostHelperCapsuleTarget;
  release: HostHelperRelease;
};
export type HostReleaseListRequest = HostHelperRequestBase & {
  action: "capsule.release.list";
  capsule: HostHelperCapsuleTarget;
};
export type HostReleaseRollbackRequest = HostHelperRequestBase & {
  action: "capsule.release.rollback";
  capsule: HostHelperCapsuleTarget;
  rollback: { releaseId: string };
};
export type HostLifecycleRequest = HostHelperRequestBase & {
  action: "capsule.start" | "capsule.stop" | "capsule.restart";
  capsule: HostHelperCapsuleTarget;
};
export type HostStatsRequest =
  | (HostHelperRequestBase & { action: "host.stats" })
  | (HostHelperRequestBase & { action: "capsule.stats"; capsule: HostHelperCapsuleTarget });
export type HostSshRequest = HostHelperRequestBase & {
  action: "capsule.ssh";
  capsule: HostHelperCapsuleTarget;
};
export type HostHealthRequest = HostHelperRequestBase & {
  action: "capsule.health";
  capsule: HostHelperCapsuleTarget;
};
export type HostLogsRequest = HostHelperRequestBase & {
  action: "host.logs";
  source: "http" | "stdout" | "stderr";
  lines: number;
};
export type HostCapsuleListRequest = HostHelperRequestBase & { action: "capsule.list" };
export type HostVersionRequest = HostHelperRequestBase & { action: "host.version" };
export type HostJobsInspectRequest = HostHelperRequestBase & { action: "jobs.inspect"; capsule: HostHelperCapsuleTarget };
export type HostSchedulesInspectRequest = HostHelperRequestBase & { action: "schedules.inspect"; capsule: HostHelperCapsuleTarget };
export type HostAccessKeyRequest = HostHelperRequestBase & {
  action: "access-keys.list" | "access-keys.inspect" | "access-keys.revoke" | "access-keys.revoke-all" | "access-keys.delete";
  capsule: HostHelperCapsuleTarget;
  accessKeys: JsonObject;
};

export type HostHelperRequest =
  | HostBootstrapRequest
  | HostRegistrationRequest
  | HostSealedEnvRotationRequest
  | HostUnregisterRequest
  | HostDeleteRequest
  | HostReleaseInstallRequest
  | HostReleaseListRequest
  | HostReleaseRollbackRequest
  | HostLifecycleRequest
  | HostStatsRequest
  | HostSshRequest
  | HostHealthRequest
  | HostLogsRequest
  | HostCapsuleListRequest
  | HostVersionRequest
  | HostJobsInspectRequest
  | HostSchedulesInspectRequest
  | HostAccessKeyRequest;

export type HostHelperErrorBody = JsonObject & {
  message: string;
  hint: string;
  diagnostics?: JsonValue;
};

export type HostHelperEnvelope<Data = JsonValue> =
  | {
    ok: true;
    data: Data;
    error: null;
  }
  | {
    ok: false;
    data: Data | null;
    error: HostHelperErrorBody;
  };
