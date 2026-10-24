import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import { randomBytes } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { composeSpecSchema } from "./compose-spec-schema.js";
import { readKeyPair, readSealedServerEnv, sealedServerEnvPaths, unsealServerEnv } from "./sealed-server-env.js";

type RecordValue = Record<string, any>;
export type ContainerServiceDeclaration = {
  kind: "container"; image: string; command: string[]; port: number;
  health: { http?: string; tcp?: true; startPeriodSeconds?: number; await?: boolean };
  state?: { path: string }; user?: string;
  hardening?: { readOnlyRootFilesystem?: boolean };
  network?: { egress?: boolean };
  env?: Record<string, string | { sealed: string } | { generated: string }>;
  compose?: RecordValue; elevated?: string[];
};
export type ContainerSecretResolution = {
  environment: Record<string, string>;
  services: Record<string, { secrets: Record<string, string> }>;
};
const ordinary = new Set(["restart", "depends_on", "mem_limit", "mem_reservation", "mem_swappiness", "memswap_limit", "cpus", "cpu_count", "cpu_percent", "cpu_period", "cpu_quota", "cpu_rt_period", "cpu_rt_runtime", "cpu_shares", "cpuset", "ulimits", "shm_size", "stop_signal", "stop_grace_period", "init", "entrypoint", "working_dir", "tmpfs", "logging", "platform", "pull_policy", "hostname", "domainname", "dns", "dns_opt", "dns_search", "stdin_open", "tty", "oom_score_adj", "scale", "pids_limit", "attach", "labels"]);
const owned: Record<string, string> = { image: "image", command: "command", environment: "env", env_file: "env", healthcheck: "health", container_name: "name", networks: "network", ports: "port", expose: "port", secrets: "env", configs: "env", user: "user", read_only: "hardening", cap_drop: "hardening", security_opt: "hardening" };
const forbidden = new Set(["extends", "include", "build", "<<"]);
const names = /^[a-z][a-z0-9-]{0,30}$/;
const envName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const secretName = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const record = (v: any): v is RecordValue => !!v && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
function fail(name: string, field: string, hint: string): never {
  const error = new Error(`Invalid services.${name}.${field}.`) as Error & { hint: string };
  error.hint = hint;
  throw error;
}
export function containerDeclarations(config: RecordValue): Array<[string, ContainerServiceDeclaration]> {
  return Object.entries(config.services ?? {}).filter(([, value]: [string, any]) => value?.kind === "container") as Array<[string, ContainerServiceDeclaration]>;
}
/** Safe addressing metadata for lifecycle inspection; no connection URLs or credentials. */
export function capsuleServiceNetwork(model: RecordValue, service: RecordValue): string {
  if (service.kind === "container") {
    const mode = service.declaration.compose?.network_mode;
    if (mode === "host" || mode === "none") return mode;
    if (service.declaration.network?.egress === false) return model.networks.internal;
  }
  return model.networks.services;
}
export function classifyContainerCompose(key: string): "ordinary" | "owned" | "elevated" | "forbidden" {
  if (forbidden.has(key) || /^[&*]/.test(key)) return "forbidden";
  if (Object.hasOwn(owned, key) || key.startsWith("com.sporades.")) return "owned";
  if (ordinary.has(key) || key.startsWith("x-")) return "ordinary";
  return "elevated";
}
let schemaValidator: ReturnType<Ajv["compile"]> | undefined;
function validateSchema(name: string, compose: RecordValue) {
  if (!schemaValidator) {
    const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
    schemaValidator = ajv.compile(composeSpecSchema);
  }
  // Unknown keys require elevation and bounded literal JSON. The pinned schema
  // validates all known keys; future Compose versions own unknown-key syntax.
  const properties = { ...composeSpecSchema.$defs.container_spec.properties, ...composeSpecSchema.$defs.workload_spec.properties, ...composeSpecSchema.$defs.service.properties };
  const known = Object.fromEntries(Object.entries(compose).filter(([key]) => Object.hasOwn(properties, key) || key.startsWith("x-")));
  if (!schemaValidator({ services: { service: { image: "example:v1", ...known } } })) {
    const error = schemaValidator.errors?.[0];
    fail(name, `compose${error?.instancePath?.replace(/^\/services\/service/, "").replaceAll("/", ".") ?? ""}`, "Use values matching the pinned Compose specification (compose-spec@3a4a6995).");
  }
}
function literalTree(name: string, value: any, field: string, depth = 0) {
  if (depth > 24) fail(name, field, "Use bounded literal JSON.");
  if (typeof value === "string") {
    if (/\$\{|\x00/.test(value)) fail(name, field, "Compose passthrough and command values are literals; use env references for secrets.");
  } else if (Array.isArray(value)) value.forEach((v, i) => literalTree(name, v, `${field}.${i}`, depth + 1));
  else if (record(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (forbidden.has(key) || /^[&*]/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) fail(name, `${field}.${key}`, "Imports, YAML merge keys, anchors and aliases are forbidden even when elevated.");
      literalTree(name, v, `${field}.${key}`, depth + 1);
    }
  } else if (value !== null && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) fail(name, field, "Use literal JSON values.");
}
function acknowledge(name: string, service: ContainerServiceDeclaration, key: string) {
  if (!service.elevated?.includes(key)) fail(name, `compose.${key}`, `Explicitly acknowledge this authority in services.${name}.elevated with ${JSON.stringify(key)}.`);
}
function canonicalPath(source: string): string {
  const absolute = path.resolve(source);
  try { return realpathSync(absolute); } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(canonicalPath(parent), path.basename(absolute));
  }
}
function overlaps(a: string, b: string) {
  const inside = (parent: string, child: string) => { const relative = path.relative(parent, child); return !relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)); };
  return inside(a, b) || inside(b, a);
}
export function containerMount(name: string, mount: any, projectDir: string): RecordValue {
  let result: RecordValue;
  if (typeof mount === "string") {
    const parts = mount.split(":");
    if (parts.length < 2 || parts.length > 3) fail(name, "compose.volumes", "Use a named volume or an explicit source:target mount.");
    const [source, target, mode] = parts;
    if (mode && !["ro", "rw"].includes(mode)) fail(name, "compose.volumes", "Use long syntax for mount options.");
    result = { type: source.startsWith(".") || path.isAbsolute(source) || source.startsWith("~") ? "bind" : "volume", source, target, ...(mode === "ro" ? { read_only: true } : {}) };
  } else if (record(mount)) result = { ...mount };
  else fail(name, "compose.volumes", "Use Compose mount syntax.");
  if (!["bind", "volume"].includes(result.type) || typeof result.source !== "string" || typeof result.target !== "string" || !result.target.startsWith("/") || result.target === "/" || /(?:docker\.sock|\.sporades|sealed-server-env)/i.test(result.target)) fail(name, "compose.volumes", "Use an explicit bind or named volume, with a non-sensitive absolute target.");
  if (result.type === "bind") {
    if (result.source.startsWith("~")) fail(name, "compose.volumes.bind", "Use an explicit absolute path; tilde expansion is not supported.");
    const source = canonicalPath(path.resolve(projectDir, result.source));
    const sensitive = [path.join(projectDir, ".sporades"), process.env.SPORADES_CONFIG_DIR, path.join(process.env.HOME ?? "/", ".config", "sporades"), "/var/run/docker.sock", "/run/docker.sock"];
    if (/(?:docker\.sock|\.sporades|sealed-server-env)/i.test(source) || sensitive.some(p => p && overlaps(source, canonicalPath(p)))) fail(name, "compose.volumes.bind", "Docker sockets, Runtime state, Sealed key stores and their parent paths can never be mounted.");
    result.source = source;
  } else if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(result.source)) fail(name, "compose.volumes", "Use a simple named volume.");
  return result;
}
export function validateContainerDeclaration(name: string, value: unknown, all: RecordValue, projectDir = process.cwd()): asserts value is ContainerServiceDeclaration {
  if (!names.test(name) || ["database", "storage", "constructor"].includes(name)) fail(name, "name", "Use ^[a-z][a-z0-9-]{0,30}$; database and storage are reserved.");
  if (!record(value) || value.kind !== "container") fail(name, "kind", "Set kind to container.");
  const service = value as ContainerServiceDeclaration;
  const fields = new Set(["kind", "image", "command", "port", "health", "state", "user", "hardening", "network", "env", "compose", "elevated"]);
  for (const key of Object.keys(value)) if (!fields.has(key)) fail(name, key, "Use a first-class field or compose passthrough.");
  if (typeof service.image !== "string" || /[\s$\x00]/.test(service.image) || service.image.length > 512) fail(name, "image", "Use an explicit image tag or sha256 digest; latest is rejected.");
  const [reference, digest, ...rest] = service.image.split("@");
  const colon = reference.lastIndexOf(":");
  const hasTag = colon > reference.lastIndexOf("/");
  const tag = hasTag ? reference.slice(colon + 1) : undefined;
  const repository = hasTag ? reference.slice(0, colon) : reference;
  const components = repository.split("/");
  const registry = components.length > 1 && /[.:]|^localhost$/.test(components[0]) ? components.shift() : undefined;
  const repositoryValid = components.length > 0 && components.every(component => /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(component));
  const registryValid = !registry || /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?$/.test(registry);
  if (rest.length || tag === "latest" || (!digest && !tag) || !repositoryValid || !registryValid
    || (digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(digest))
    || (tag !== undefined && !/^[\w][\w.-]{0,127}$/.test(tag))) {
    fail(name, "image", "Pin image to an explicit non-latest tag or sha256 digest.");
  }
  if (!Array.isArray(service.command) || service.command.length > 128 || service.command.some(v => typeof v !== "string" || v.length > 8192)) fail(name, "command", "Use an array of literal arguments (at most 128).");
  literalTree(name, service.command, "command");
  if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) fail(name, "port", "Use one internal TCP port, 1–65535.");
  const h = service.health;
  if (!record(h) || Object.keys(h).some(k => !["http", "tcp", "startPeriodSeconds", "await"].includes(k)) || ((typeof h.http === "string") === (h.tcp === true)) || (h.http !== undefined && (!/^\/(?!\/)[^\s\x00-\x1f$]*$/.test(h.http) || h.http.length > 1024)) || (h.tcp !== undefined && h.tcp !== true) || (h.startPeriodSeconds !== undefined && (!Number.isInteger(h.startPeriodSeconds) || h.startPeriodSeconds < 0 || h.startPeriodSeconds > 3600)) || (h.await !== undefined && typeof h.await !== "boolean")) fail(name, "health", "Declare http: /path or tcp: true; startPeriodSeconds is 0–3600 and await is boolean (default true).");
  if (service.state !== undefined && (!record(service.state) || Object.keys(service.state).some(k => k !== "path") || typeof service.state.path !== "string" || !/^\/(?!\/)[A-Za-z0-9_./-]+$/.test(service.state.path) || service.state.path.split("/").includes("..") || /^\/(?:proc|sys|dev|run|etc)(?:\/|$)/.test(service.state.path))) fail(name, "state", "Use state.path with one absolute, non-system container directory.");
  if (service.elevated !== undefined && (!Array.isArray(service.elevated) || service.elevated.length > 64 || service.elevated.some(k => typeof k !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(k)))) fail(name, "elevated", "List the acknowledged elevated key names.");
  if (service.user !== undefined) {
    if (typeof service.user !== "string" || !/^(?:root|[0-9]+)(?::(?:root|[0-9]+))?$/.test(service.user)) fail(name, "user", "Use a numeric UID[:GID], or root with elevated root acknowledgement.");
    if (/^(?:root|0+)(?::|$)/.test(service.user)) acknowledge(name, service, "root");
  }
  for (const [field, key] of [["hardening", "readOnlyRootFilesystem"], ["network", "egress"]] as const) {
    const entry = service[field];
    if (entry !== undefined && (!record(entry) || Object.keys(entry).some(k => k !== key) || (entry[key as keyof typeof entry] !== undefined && typeof entry[key as keyof typeof entry] !== "boolean"))) fail(name, field, `Use ${field}.${key} as a boolean.`);
  }
  if (service.hardening?.readOnlyRootFilesystem === false) acknowledge(name, service, "hardening.readOnlyRootFilesystem");
  if (service.env !== undefined) {
    if (!record(service.env) || Object.keys(service.env).length > 64) fail(name, "env", "Declare at most 64 env keys.");
    let bytes = 0;
    for (const [key, v] of Object.entries(service.env)) {
      if (!envName.test(key) || key.startsWith("SPORADES_") || ["__proto__", "constructor", "prototype"].includes(key)) fail(name, "env", "Use env variable names without the reserved SPORADES_ prefix.");
      if (typeof v === "string") { if (v.includes("\0")) fail(name, `env.${key}`, "Env values cannot contain NUL."); bytes += Buffer.byteLength(v); }
      else if (!record(v) || Object.keys(v).length !== 1 || !("sealed" in v ? typeof v.sealed === "string" && envName.test(v.sealed) && !v.sealed.startsWith("SPORADES_") && !["__proto__", "constructor", "prototype"].includes(v.sealed) : "generated" in v && typeof v.generated === "string" && secretName.test(v.generated) && !["__proto__", "constructor", "prototype", "toJSON"].includes(v.generated))) fail(name, `env.${key}`, "Use a literal string, { sealed: KEY } or { generated: name }.");
    }
    if (bytes > 65536) fail(name, "env", "Service env values must fit within 64 KB.");
  }
  const compose = service.compose;
  if (compose !== undefined) {
    if (!record(compose)) fail(name, "compose", "Use a Compose service object.");
    if (service.network?.egress === false && compose.network_mode !== undefined) fail(name, "compose.network_mode", "network_mode cannot override network.egress: false.");
    literalTree(name, compose, "compose");
    if (Buffer.byteLength(JSON.stringify(compose)) > 131072) fail(name, "compose", "Keep Compose configuration within 128 KB.");
    for (const [key, v] of Object.entries(compose)) {
      const classification = classifyContainerCompose(key);
      if (classification === "forbidden") fail(name, `compose.${key}`, "Imports, builds, merge keys, anchors and aliases are forbidden even when elevated.");
      if (classification === "owned") fail(name, `compose.${key}`, `Use services.${name}.${owned[key] ?? "compose.labels"}; Sporades owns this path.`);
      if (key === "volumes") {
        if (!Array.isArray(v)) fail(name, "compose.volumes", "Use a list of mounts.");
        for (const mount of v) if (containerMount(name, mount, projectDir).type === "bind") acknowledge(name, service, "volumes.bind");
      } else if (key === "deploy") {
        walkDeploy(name, service, v);
      } else if (classification === "elevated") acknowledge(name, service, key);
      if (key === "labels") {
        const keys = Array.isArray(v) ? v.map(k => String(k).split("=")[0]) : Object.keys(v ?? {});
        if (keys.some(k => k.startsWith("com.sporades."))) fail(name, "compose.labels", "com.sporades.* labels are runtime-owned.");
      }
      if (key === "use_api_socket") fail(name, "compose.use_api_socket", "Docker socket access is always forbidden, even when elevated.");
      if (key === "volumes_from") {
        if (!Array.isArray(v) || v.length > 16) fail(name, "compose.volumes_from", "Use at most 16 declared service or container:name references.");
        for (const entry of v) {
          const source = inheritedSource(name, entry);
          if (!source.external) validateInheritedService(name, source.name, all, new Set());
        }
      }
    }
    validateSchema(name, compose);
    const depends = compose.depends_on;
    if (depends !== undefined) {
      for (const dep of Array.isArray(depends) ? depends : Object.keys(depends)) if (!Object.hasOwn(all, dep) || dep === name) fail(name, "compose.depends_on", "Reference other declared Capsule service names.");
    }
  }
}
function walkDeploy(name: string, service: ContainerServiceDeclaration, value: any, prefix = "deploy") {
  if (!record(value)) { acknowledge(name, service, prefix); return; }
  for (const [key, v] of Object.entries(value)) {
    const next = `${prefix}.${key}`;
    if (next === "deploy.resources.limits") continue;
    if (next === "deploy.resources.reservations" && record(v)) {
      for (const part of Object.keys(v)) if (part !== "cpus" && part !== "memory") acknowledge(name, service, `${next}.${part}`);
    } else if (["deploy.resources", "deploy"].includes(next)) walkDeploy(name, service, v, next);
    else acknowledge(name, service, next);
  }
}
export function validateContainerDependencies(services: RecordValue) {
  if (containerDeclarations({ services }).length > 8) fail("container", "name", "Declare at most 8 container services.");
  const visiting = new Set<string>(), done = new Set<string>();
  function visit(name: string) {
    if (visiting.has(name)) fail(name, "compose.depends_on", "Remove the service dependency cycle.");
    if (done.has(name)) return;
    visiting.add(name);
    const deps = services[name]?.compose?.depends_on ?? [];
    for (const dep of Array.isArray(deps) ? deps : Object.keys(deps)) visit(dep);
    for (const entry of services[name]?.compose?.volumes_from ?? []) { const source = inheritedSource(name, entry); if (!source.external) visit(source.name); }
    visiting.delete(name); done.add(name);
  }
  for (const name of Object.keys(services)) visit(name);
}
function inheritedSource(name: string, entry: unknown): { external: boolean; name: string; suffix: string } {
  if (typeof entry !== "string") fail(name, "compose.volumes_from", "Use a declared service name or container:name, optionally suffixed :ro or :rw.");
  const external = entry.startsWith("container:");
  const parts = (external ? entry.slice(10) : entry).split(":");
  if (parts.length > 2 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(parts[0]) || (parts[1] !== undefined && !["ro", "rw"].includes(parts[1]))) fail(name, "compose.volumes_from", "Use a declared service name or container:name, optionally suffixed :ro or :rw.");
  return { external, name: parts[0], suffix: parts[1] ? `:${parts[1]}` : "" };
}
function validateInheritedService(name: string, source: string, declarations: RecordValue, seen: Set<string>) {
  if (seen.has(source)) fail(name, "compose.volumes_from", "Remove inherited volume dependency cycles.");
  seen.add(source);
  const service = declarations[source];
  if (service?.kind !== "container" || service.state) fail(name, "compose.volumes_from", "Inherited Runtime-directory mounts, including database/storage and state.path, are always forbidden. Use explicit named volumes.");
  for (const entry of service.compose?.volumes_from ?? []) { const next = inheritedSource(name, entry); if (!next.external) validateInheritedService(name, next.name, declarations, new Set(seen)); }
}
/** Pin external inherited mounts to an inspected immutable container identity. */
export function pinContainerInheritedMounts(model: RecordValue, projectDir: string, inspectContainer: (name: string) => unknown, inspectVolume?: (name: string) => unknown): boolean {
  let changed = false;
  for (const [name, service] of containerDeclarations({ services: model.declarations })) {
    const entries = service.compose?.volumes_from;
    if (!entries) continue;
    const pinned = entries.map((entry: string) => {
      const source = inheritedSource(name, entry);
      if (!source.external) return model.nameMapping[source.name] + source.suffix;
      const inspected = inspectContainer(source.name);
      if (!record(inspected) || typeof inspected.Id !== "string" || !/^[a-f0-9]{64}$/.test(inspected.Id) || !Array.isArray(inspected.Mounts)) fail(name, "compose.volumes_from", "External container mount inspection is unavailable; no service was started.");
      for (const mount of inspected.Mounts) {
        if (!record(mount)) fail(name, "compose.volumes_from", "External container mount inspection is invalid.");
        if (mount.Type === "tmpfs") continue;
        if (mount.Type === "volume") {
          const volume = typeof mount.Name === "string" ? inspectVolume?.(mount.Name) : null;
          // A local-driver volume can itself be a host bind through driver_opts.
          // Attest its backing source rather than trusting the mount's type tag.
          if (!record(volume) || volume.Driver !== "local" || (volume.Options !== null && volume.Options !== undefined && (!record(volume.Options) || Object.keys(volume.Options).length))) fail(name, "compose.volumes_from", "External inherited volumes must use the local driver without driver options; use an explicit reviewed bind for other backing stores.");
        }
        containerMount(name, { type: mount.Type, source: mount.Type === "volume" ? mount.Name : mount.Source, target: mount.Destination }, projectDir);
      }
      changed = true;
      return `container:${inspected.Id}${source.suffix}`;
    });
    model.composeDocument.services[model.nameMapping[name]].volumes_from = pinned;
  }
  return changed;
}
// The name length disambiguates a-b/C from a/B_C without exposing values.
export function serviceInterpolationName(name: string, key: string) { return `SPORADES_SVC_${name.replaceAll("-", "_").toUpperCase()}_${key}_${name.length}`; }

/** Values stay exclusively in memory and the protected credentials file. */
export async function resolveContainerSecrets(projectDir: string, config: RecordValue, sealed?: Record<string, string>): Promise<ContainerSecretResolution> {
  const declarations = containerDeclarations(config);
  const result: ContainerSecretResolution = { environment: {}, services: {} };
  if (!declarations.length) return result;
  for (const [name, service] of declarations) validateContainerDeclaration(name, service, config.services, projectDir);
  if (!sealed) {
    const paths = sealedServerEnvPaths(projectDir);
    const envelope = await readSealedServerEnv(paths);
    const pair = envelope ? await readKeyPair(paths) : null;
    if (envelope && !pair) fail("container", "env", "Restore the Sealed Server env key store before starting services.");
    sealed = envelope && pair ? unsealServerEnv(envelope, pair.privateKey) : {};
  }
  const missing = new Set<string>();
  for (const [, service] of declarations) for (const v of Object.values(service.env ?? {})) if (typeof v !== "string" && "sealed" in v && (!Object.hasOwn(sealed, v.sealed) || !sealed[v.sealed].trim())) missing.add(v.sealed);
  if (missing.size) {
    const error = new Error(`Missing Sealed Server env keys: ${[...missing].sort().join(", ")}`) as Error & { hint: string };
    error.hint = "Set the named keys with sporades env set <name> --stdin before starting services."; throw error;
  }
  return updateServiceCredentials(projectDir, saved => {
    const generated = saved.container ?? {};
    if (!record(generated)) fail("container", "env", "Repair the protected credentials file.");
    // Keep the active generation's keys until the candidate starts successfully.
    // Failed preflight/readiness must not silently rotate a last-known-good key.
    const retained: RecordValue = { ...generated };
    for (const [name, service] of declarations) {
      const secrets: Record<string, string> = Object.create(null);
      let size = 0;
      for (const [key, value] of Object.entries(service.env ?? {})) {
        let resolved: string;
        if (typeof value === "string") resolved = value;
        else if ("sealed" in value) resolved = sealed![value.sealed];
        else {
          const previous = Object.hasOwn(generated, name) && record(generated[name]) && Object.hasOwn(generated[name], value.generated) ? generated[name][value.generated] : undefined;
          if (previous !== undefined && (typeof previous !== "string" || !/^[a-f0-9]{64}$/.test(previous))) fail(name, "env", "Repair the protected credentials file; secrets are never silently rotated.");
          resolved = secrets[value.generated] ?? previous ?? randomBytes(32).toString("hex");
          secrets[value.generated] = resolved;
        }
        if (resolved.includes("\0")) fail(name, `env.${key}`, "Env values cannot contain NUL.");
        size += Buffer.byteLength(resolved);
        if (typeof value !== "string") result.environment[serviceInterpolationName(name, key)] = resolved;
      }
      if (size > 65536) fail(name, "env", "Resolved service env exceeds 64 KB; reduce the declared values.");
      retained[name] = { ...(record(generated[name]) ? generated[name] : {}), ...secrets };
      result.services[name] = { secrets };
    }
    return { value: { ...saved, container: retained }, result };
  });
}

/** Discard removed services/secret names only after successful lifecycle admission. */
export async function finalizeContainerSecrets(projectDir: string, config: RecordValue, expected?: ContainerSecretResolution) {
  await updateServiceCredentials(projectDir, saved => {
    const retained: RecordValue = {};
    for (const [name, service] of containerDeclarations(config)) {
      const names = Object.values(service.env ?? {}).flatMap(value => typeof value !== "string" && "generated" in value ? [value.generated] : []);
      retained[name] = Object.fromEntries(names.map(key => {
        const value = saved.container?.[name]?.[key];
        if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value) || (expected && value !== expected.services[name]?.secrets[key])) fail(name, "env", "Service credentials changed during startup; retry the lifecycle command.");
        return [key, value];
      }));
    }
    const { container, ...existing } = saved;
    return { value: Object.keys(retained).length ? { ...existing, container: retained } : existing, result: null };
  });
}

/** Shared by built-in and container credentials so concurrent writers cannot rotate keys. */
export async function updateServiceCredentials<T>(projectDir: string, update: (saved: RecordValue) => { value: RecordValue; result: T }): Promise<T> {
  const directory = path.join(projectDir, ".sporades", "services");
  for (const dir of [path.join(projectDir, ".sporades"), directory]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("container", "env", "Runtime credentials directories must be real directories, never symlinks.");
  }
  await chmod(directory, 0o700);
  const lock = path.join(directory, ".credentials-lock");
  // No stale-lock reclamation: a crashed writer requires explicit operator
  // repair instead of risking two different API keys for the same service.
  let acquired = false;
  for (let i = 0; i < 100; i++) {
    try { await mkdir(lock); acquired = true; break; }
    catch (e: any) { if (e.code !== "EEXIST") throw e; await new Promise(r => setTimeout(r, 20)); }
  }
  if (!acquired) fail("container", "env", "Service credentials are locked; stop concurrent lifecycle commands before retrying. After a crashed command, remove .credentials-lock.");
  const file = path.join(directory, "credentials.json");
  try {
    let saved: RecordValue = {};
    try {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 256 * 1024) throw new Error(); saved = JSON.parse(await handle.readFile("utf8")); }
      finally { await handle.close(); }
      if (!record(saved)) throw new Error();
    } catch (e: any) { if (e.code !== "ENOENT") fail("container", "env", "Repair the protected credentials file; existing secrets are never silently regenerated."); }
    const { value, result } = update(saved);
    const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    try { await writeCredentials(temp, value); await rename(temp, file); await chmod(file, 0o600); }
    finally { await rm(temp, { force: true }); }
    return result;
  } finally { await rm(lock, { recursive: true }); }
}

async function writeCredentials(file: string, value: RecordValue) {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); } finally { await handle.close(); }
}

const escapeLiteral = (s: string) => s.replaceAll("$", () => "$$");
function escapeTree(v: any): any { return typeof v === "string" ? escapeLiteral(v) : Array.isArray(v) ? v.map(escapeTree) : record(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, escapeTree(x)])) : v; }
export function renderContainerService(name: string, service: ContainerServiceDeclaration, generatedName: string, projectDir: string, model: RecordValue, volumes: RecordValue): RecordValue {
  validateContainerDeclaration(name, service, model.declarations, projectDir);
  if (model.publishPorts && service.network?.egress === false) fail(name, "network.egress", "Egress isolation requires a Container session; Dev needs a loopback published port.");
  const compose = escapeTree(service.compose ?? {});
  const mounts: RecordValue[] = [];
  for (const mount of service.compose?.volumes ?? []) {
    const normalized = containerMount(name, mount, projectDir);
    if (normalized.type === "volume") {
      const key = normalized.source;
      volumes[key] = { name: `${model.composeProjectName}-${key}`, labels: model.labels };
      normalized.source = key;
    }
    mounts.push(normalized);
  }
  if (service.state) mounts.push({ type: "bind", source: path.join(projectDir, ".sporades", "services", name), target: service.state.path });
  const targets = new Set<string>();
  for (const m of mounts) { if (targets.has(m.target)) fail(name, "compose.volumes", "Mount targets must be unique, including state.path."); targets.add(m.target); }
  if (service.compose?.depends_on) compose.depends_on = Object.fromEntries((Array.isArray(service.compose.depends_on) ? service.compose.depends_on.map(dep => [dep, { condition: "service_started" }]) : Object.entries(service.compose.depends_on)).map(([dep, v]) => [model.nameMapping[dep], v]));
  if (service.compose?.volumes_from) compose.volumes_from = service.compose.volumes_from.map((entry: string) => { const source = inheritedSource(name, entry); return source.external ? entry : model.nameMapping[source.name] + source.suffix; });
  const env = Object.fromEntries(Object.entries(service.env ?? {}).map(([key, value]) => [key, typeof value === "string" ? escapeLiteral(value) : `\${${serviceInterpolationName(name, key)}:?}`]));
  const labels = Array.isArray(compose.labels) ? Object.fromEntries(compose.labels.map((entry: string) => { const i = entry.indexOf("="); return i < 0 ? [entry, ""] : [entry.slice(0, i), entry.slice(i + 1)]; })) : compose.labels ?? {};
  const tmpfs = compose.tmpfs === undefined ? [] : Array.isArray(compose.tmpfs) ? compose.tmpfs : [compose.tmpfs];
  if (tmpfs.some((v: string) => { const target = path.posix.normalize(v.split(":")[0]); return target === "/" || target === "/tmp" || target.startsWith("/tmp/"); }) || mounts.some(m => m.target === "/tmp" || m.target.startsWith("/tmp/"))) fail(name, "compose.tmpfs", "Sporades owns the hardened /tmp; use a different mount target.");
  // Images must provide curl for HTTP checks, or a shell with /dev/tcp for TCP.
  // No interpolated command arguments and no Capsule credentials enter probes.
  const healthTest = service.health.http ? ["CMD", "curl", "--fail", "--silent", "--output", "/dev/null", `http://127.0.0.1:${service.port}${service.health.http}`] : ["CMD", "/bin/bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${service.port}`];
  return {
    ...compose, image: service.image, command: service.command.map(escapeLiteral), container_name: generatedName,
    labels: { ...labels, ...model.labels, "com.sporades.capsule-service.kind": "container", "com.sporades.capsule-service.name": name },
    user: service.user ?? "10001:10001", cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"],
    read_only: service.hardening?.readOnlyRootFilesystem !== false,
    tmpfs: ["/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777", ...tmpfs],
    environment: env,
    healthcheck: { test: healthTest, interval: "5s", timeout: "3s", retries: 3, start_period: `${service.health.startPeriodSeconds ?? 60}s`, start_interval: "1s" },
    // Host networking explicitly acknowledged via network_mode cannot also join
    // Compose networks or publish Dev ports.
    ...(compose.network_mode ? {} : { networks: [service.network?.egress === false ? model.networks.internal : model.networks.services] }),
    ...(model.publishPorts && !compose.network_mode ? { ports: [`127.0.0.1::${service.port}`] } : {}),
    ...(mounts.length ? { volumes: mounts } : {}),
  };
}

function interpolate(value: any, env: Record<string, string>): any {
  if (typeof value === "string") return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*):\?\}/g, (whole, key) => env[key] === undefined ? whole : escapeLiteral(env[key]));
  if (Array.isArray(value)) return value.map(v => interpolate(v, env));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env)]));
  return value;
}
function duration(v: any) {
  if (typeof v !== "string") return v;
  const parts = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  return parts ? `${Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0)}s` : v;
}
function entrypointWords(value: string): string[] {
  const words: string[] = [];
  let word = "", quote = "", escape = false, started = false;
  for (const char of value) {
    if (escape) { word += char; escape = false; started = true; }
    else if (char === "\\" && quote !== "'") { escape = true; started = true; }
    else if (quote) { if (char === quote) quote = ""; else word += char; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { words.push(word); word = ""; started = false; } }
    else { word += char; started = true; }
  }
  if (quote || escape) throw new Error("Invalid literal Compose entrypoint.");
  if (started) words.push(word);
  return words;
}
function byteSize(value: any) {
  const match = String(value).toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([bkmg])?b?$/);
  if (!match) return value;
  return String(Number(match[1]) * 1024 ** ({ b: 0, k: 1, m: 2, g: 3 }[match[2] ?? "b"] ?? 0));
}
function normalizeService(v: RecordValue, volumes: RecordValue = {}): RecordValue {
  const result = structuredClone(v);
  // Compose v2 materializes an unset entrypoint as null, and normalizes byte
  // sizes and durations. These exact representation defaults grant no authority.
  if (result.entrypoint === null) delete result.entrypoint;
  if (typeof result.entrypoint === "string") result.entrypoint = entrypointWords(result.entrypoint);
  if (result.ulimits) for (const [name, limit] of Object.entries(result.ulimits)) {
    if (typeof limit === "number" || typeof limit === "string") result.ulimits[name] = { soft: Number(limit), hard: Number(limit) };
  }
  if (result.stop_grace_period !== undefined) result.stop_grace_period = duration(result.stop_grace_period);
  for (const key of ["mem_limit", "mem_reservation", "memswap_limit", "shm_size"]) {
    if (result[key] !== undefined) result[key] = byteSize(result[key]);
  }
  if (result.cpus !== undefined) result.cpus = Number(result.cpus);
  if (result.deploy?.resources) for (const kind of ["limits", "reservations"]) {
    const resources = result.deploy.resources[kind];
    if (resources?.memory !== undefined) resources.memory = byteSize(resources.memory);
    if (resources?.cpus !== undefined) resources.cpus = Number(resources.cpus);
  }
  if (Array.isArray(result.networks)) result.networks = Object.fromEntries(result.networks.map((n: string) => [n, null]));
  if (record(result.networks)) for (const [key, x] of Object.entries(result.networks)) if (record(x) && Object.keys(x).length === 0) result.networks[key] = null;
  if (result.environment && !Object.keys(result.environment).length) delete result.environment;
  if (result.depends_on) for (const [key, x] of Object.entries(result.depends_on)) result.depends_on[key] = { required: true, ...(x as RecordValue) };
  if (Array.isArray(result.ports)) result.ports = result.ports.map((p: any) => {
    if (typeof p === "string") { const [host_ip, published, target] = p.split(":"); return { target: Number(target), host_ip, protocol: "tcp", mode: "ingress", ...(published ? { published } : {}) }; }
    const copy = { ...p }; if (copy.published === "0" || copy.published === "") delete copy.published; return copy;
  });
  if (result.volumes) result.volumes = result.volumes.map((v: RecordValue) => {
    const copy = { ...v };
    if (copy.type === "volume" && volumes[copy.source]?.name) copy.source = volumes[copy.source].name;
    if (copy.read_only === false) delete copy.read_only;
    if (copy.type === "bind") { copy.bind = { create_host_path: true, ...copy.bind }; }
    if (copy.type === "volume" && record(copy.volume) && !Object.keys(copy.volume).length) delete copy.volume;
    return copy;
  });
  if (result.healthcheck) for (const key of ["interval", "timeout", "start_period", "start_interval"]) if (result.healthcheck[key] !== undefined) result.healthcheck[key] = duration(result.healthcheck[key]);
  if (result.ports) result.ports = result.ports.sort((a: any,b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return result;
}
/** Examine the actual resolved service, never log either model (it has secrets). */
export function validateResolvedContainerServices(rendered: RecordValue, resolved: RecordValue, declarations: RecordValue, mapping: Record<string, string>, environment: Record<string, string>) {
  if (!record(resolved)) fail("container", "compose", "Docker Compose must return an object.");
  for (const [name, generatedName] of Object.entries(mapping)) {
    const declaration = declarations[name];
    if (declaration?.kind !== "container") continue;
    const expected = normalizeService(interpolate(rendered.services[generatedName], environment), rendered.volumes);
    const actualRaw = resolved.services?.[generatedName];
    if (!record(actualRaw)) fail(name, "compose", "Resolved Compose service is missing.");
    const actual = normalizeService(actualRaw, rendered.volumes);
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (!Object.hasOwn(expected, key)) fail(name, `compose.${key}`, "Resolved Compose introduced an unaccounted path; upgrade Sporades' pinned classifier before starting.");
      if (classifyContainerCompose(key) === "forbidden") fail(name, `compose.${key}`, "Resolved Compose imports are forbidden.");
      // Even elevated acknowledgements never authorize resolution-time changes
      // to owned paths, mounts, env, network membership or arbitrary nested keys.
      if (!isDeepStrictEqual(actual[key], expected[key])) fail(name, `compose.${key}`, "Resolved Compose differs from the declared value; no service was started. Inspect the named path without exposing env values.");
    }
  }
  // Top-level resources must also be accounted for. Compose may add name, but
  // cannot import extra services, networks or volumes via resolution.
  for (const key of ["services", "networks", "volumes"]) {
    for (const name of Object.keys(resolved[key] ?? {})) if (!Object.hasOwn(rendered[key] ?? {}, name)) fail("container", `compose.${key}`, "Resolved Compose introduced an undeclared resource.");
  }
  for (const kind of ["networks", "volumes"]) {
    for (const [key, expected] of Object.entries(rendered[kind] ?? {})) {
      const actual = { ...resolved[kind]?.[key] };
      if (kind === "networks" && record(actual.ipam) && !Object.keys(actual.ipam).length && !(expected as RecordValue).ipam) delete actual.ipam;
      if (!isDeepStrictEqual(actual, expected)) fail("container", `compose.${kind}.${key}`, "Resolved resource values differ from Sporades-owned labels, addressing or isolation.");
    }
  }
  for (const key of Object.keys(resolved)) if (!["name", "services", "networks", "volumes"].includes(key) && !key.startsWith("x-")) fail("container", `compose.${key}`, "Resolved Compose introduced an undeclared resource.");
}
