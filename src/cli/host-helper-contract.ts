export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = {
  [key: string]: unknown;
};

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
  | "capsule.health"
  | "capsule.list"
  | "host.stats"
  | "host.logs"
  | "host.bootstrap";

export type HostTlsMode = "automatic" | "cloudflare-origin";

export type HostHelperHost = JsonObject & {
  alias: string;
  server?: string;
  domain: string;
  scheme: string;
  remoteRoot: string;
  tls?: HostTlsConfig;
};

export type HostTlsConfig = JsonObject & {
  mode: HostTlsMode | string;
  certificateFile?: string | null;
  keyFile?: string | null;
};

export type HostHelperCapsuleTarget = JsonObject & {
  subname: string;
};

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
  restart?: boolean;
  serverEnvIncluded?: boolean;
  sealedServerEnvIncluded?: boolean;
  sealedServerEnv?: HostHelperSealedServerEnv | null;
};

export type HostedCapsuleBaseImage = JsonObject & {
  image?: string;
  name?: string;
  version?: string;
  updatePolicy?: unknown;
};

export type HostHelperSealedServerEnv = JsonObject & {
  publicKey?: string;
  publicKeyFingerprint?: string;
  publicKeyPath?: string;
  privateKey?: string;
  privateKeyPath?: string;
  currentKeyFingerprint?: string;
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
};

export type HostRegistrationOptions = JsonObject & {
  subname?: string;
  domain?: string;
  remoteCapsuleId?: string;
  route?: { log?: { file?: string }; [key: string]: unknown };
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
  | HostHealthRequest
  | HostLogsRequest
  | HostCapsuleListRequest;

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

export type HostedCapsuleStatus = "registered" | "started" | "stopped" | "failed" | "unregistered";
export type HostedCapsuleReleaseState =
  | "uploaded"
  | "starting"
  | "started"
  | "verified"
  | "failed"
  | "verification-failed";

export type HostedCapsuleReleaseEntry = JsonObject & {
  id: string;
  state: HostedCapsuleReleaseState | string;
  createdAt?: string;
  updatedAt?: string;
  current?: boolean;
};

export type HostedCapsuleRegistryRecord = JsonObject & {
  subname: string;
  domain: string;
  hostedUrl: string;
  remoteCapsuleId: string;
  status?: HostedCapsuleStatus | string;
  currentRelease?: { id: string } | null;
  releases?: HostedCapsuleReleaseEntry[];
  sealedServerEnv?: HostHelperSealedServerEnv | null;
};

export type HostedCapsuleRoute = JsonObject & {
  url?: string;
  routeFile: string;
  previousRouteFile?: string;
  port?: number;
  containerName?: string;
  upstream?: string;
  accessLog?: string;
  log?: { file?: string } | null;
  runtimeProbe?: RuntimeProbeCredential;
};

export type RuntimeProbeCredential = JsonObject & {
  header: string;
  token: string;
};

export type HostedCapsuleContainer = JsonObject & {
  name: string;
  image: string;
  network: string;
  user?: string;
  labels?: Record<string, string>;
  baseImage?: HostedCapsuleBaseImage;
};

export type HostedCapsuleLifecycle = JsonObject & {
  capsule?: HostHelperCapsuleTarget;
  host?: HostHelperHost;
  subname?: string;
  domain?: string;
  hostedUrl?: string;
  remoteCapsuleId?: string;
  currentLink?: string;
  remoteRoot: string;
  directories?: {
    capsule?: string;
    releases?: string;
    data?: string;
    logs?: string;
  };
  mounts: {
    files: HostedCapsuleMount[];
    data: HostedCapsuleMount;
    [key: string]: unknown;
  };
  container: HostedCapsuleContainer;
  routes: {
    running: HostedCapsuleRoute;
    unavailable: HostedCapsuleRoute;
  };
};

export type HostLifecycleOptions = JsonObject & Partial<Omit<HostedCapsuleLifecycle, "container" | "routes" | "mounts">> & {
  container?: Partial<HostedCapsuleContainer>;
  routes?: {
    running?: Partial<HostedCapsuleRoute>;
    unavailable?: Partial<HostedCapsuleRoute>;
    accessLog?: string;
  };
  mounts?: {
    files?: HostedCapsuleMount[];
    data?: HostedCapsuleMount;
    [key: string]: unknown;
  };
};

export type HostedCapsuleMount = JsonObject & {
  host: string;
  container: string;
  mode: string;
  optional?: boolean;
  fingerprint?: string | null;
  source?: string;
  target?: string;
  readonly?: boolean;
};

export type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
};

export type DockerCommandResult = CommandResult;

export type DockerPsContainerRaw = JsonObject & {
  ID?: string;
  Names?: string;
  Image?: string;
  State?: string;
  Status?: string;
  Labels?: string;
};

export type DockerStatsRaw = JsonObject & {
  Name?: string;
  CPUPerc?: string;
  MemUsage?: string;
  MemPerc?: string;
  NetIO?: string;
  BlockIO?: string;
  PIDs?: string;
};
