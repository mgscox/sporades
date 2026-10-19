import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { helperError } from "./cli-support.js";
import { atomicBackupJson, trustedBackupPath, readHostBackupPolicy, restic, listHostBackups, pruneHostBackups, hostBackupDirectory, publishHostBackupMetric } from "./host-backups.js";
import type { HostHelperHost } from "./hosted-capsule-contract.js";

// Release-owned pins. Changes require the real-provider acceptance test.
export const OBSERVABILITY_IMAGES = Object.freeze({ glitchtip: "glitchtip/glitchtip:v5.2.1", umami: "ghcr.io/umami-software/umami:postgresql-v2.20.2", postgres: "postgres:16.10-alpine", valkey: "valkey/valkey:8.1.3-alpine" });
export const OBSERVABILITY_MINIMUM = Object.freeze({ cpus: 2, memoryBytes: 2 * 1024 ** 3, freeDiskBytes: 20 * 1024 ** 3 });
type State = { version: 1; enabled: boolean; ready: boolean; disclosed: boolean; secrets: { database: string; umamiDatabase: string; django: string; app: string; errorsPassword: string; analyticsPassword: string; token: string }; };
export type ObservabilityTarget = { domain: string; subname: string; publicKey: string; errors: boolean; analytics: boolean };
export const OBSERVABILITY_ROUTE_FILE = "__sporades-observability.caddy";
export function renderObservabilityRoutes(host: HostHelperHost, ports: { errors: number; analytics: number } | null) {
  return (["errors", "analytics"] as const).map(service => `${service}.${host.domain} {\n  ${ports ? `reverse_proxy 127.0.0.1:${ports[service]}` : 'respond "Service disabled" 503'}\n}\n`).join("\n");
}
export function observabilityDirectory(host: HostHelperHost) { return path.join(host.remoteRoot, "hosts", host.domain, "services", "observability"); }
export function observabilityProject(host: HostHelperHost) { return `sporades-observe-${createHash("sha256").update(`${host.remoteRoot}\0${host.domain}`).digest("hex").slice(0, 16)}`; }
function fail(message = "Host observability operation failed."): never { throw helperError(message, "Inspect Docker and protected Host services state, then retry the same command. Provider responses and credentials are omitted."); }
export async function readObservabilityState(host: HostHelperHost): Promise<State | null> {
  const file = path.join(observabilityDirectory(host), "secrets.json");
  try {
    await trustedBackupPath(file, true);
    let value: State;
    try { value = JSON.parse(await readFile(file, "utf8")); } catch { return fail("Invalid protected observability state."); }
    if (value.version !== 1 || typeof value.enabled !== "boolean" || typeof value.ready !== "boolean" || typeof value.disclosed !== "boolean" || !value.secrets || Object.keys(value.secrets).sort().join() !== ["database","umamiDatabase","django","app","errorsPassword","analyticsPassword","token"].sort().join() || Object.values(value.secrets).some(v => typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))) fail("Invalid protected observability state.");
    return value;
  }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
export function assertObservabilityResources(cpus: number, memoryBytes: number, freeDiskBytes: number) {
  if (![cpus, memoryBytes, freeDiskBytes].every(Number.isFinite) || cpus < OBSERVABILITY_MINIMUM.cpus || memoryBytes < OBSERVABILITY_MINIMUM.memoryBytes || freeDiskBytes < OBSERVABILITY_MINIMUM.freeDiskBytes) fail("Observability requires at least 2 CPUs, 2 GiB Docker memory and 20 GiB free disk, plus capacity for Capsules.");
}
function command(args: string[], input?: string | Buffer, maxBuffer = 4 * 1024 * 1024): Buffer {
  const r = spawnSync("docker", args, { input, timeout: 600_000, maxBuffer });
  if (r.error || r.status !== 0) fail();
  return r.stdout;
}
export function observabilityCompose(host: HostHelperHost, state: State) {
  const common = { restart: "unless-stopped", security_opt: ["no-new-privileges:true"], logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } } };
  const pg = (name: string, password: string) => ({ ...common, image: OBSERVABILITY_IMAGES.postgres, environment: { POSTGRES_USER: name, POSTGRES_DB: name, POSTGRES_PASSWORD: password }, volumes: [`${name}-db:/var/lib/postgresql/data`], healthcheck: { test: ["CMD-SHELL", `pg_isready -U ${name}`], interval: "5s", timeout: "5s", retries: 30 } });
  const environment = { DATABASE_URL: `postgresql://glitchtip:${state.secrets.database}@errors-db:5432/glitchtip`, REDIS_URL: "redis://valkey:6379/0", SECRET_KEY: state.secrets.django, GLITCHTIP_DOMAIN: `https://errors.${host.domain}`, CSRF_TRUSTED_ORIGINS: `https://errors.${host.domain}`, ALLOWED_HOSTS: `errors.${host.domain},127.0.0.1`, DEFAULT_FROM_EMAIL: `ops@${host.domain}`, EMAIL_URL: "consolemail://", ENABLE_USER_REGISTRATION: "false", ENABLE_SOCIAL_APPS_USER_REGISTRATION: "false", ENABLE_ORGANIZATION_CREATION: "false", PORT: "8080", UWSGI_WORKERS: "2", CELERY_WORKER_CONCURRENCY: "2", CELERY_WORKER_POOL: "threads" };
  return { name: observabilityProject(host), services: {
    "errors-db": pg("glitchtip", state.secrets.database), "analytics-db": pg("umami", state.secrets.umamiDatabase),
    valkey: { ...common, image: OBSERVABILITY_IMAGES.valkey, command: ["valkey-server", "--save", "", "--appendonly", "no"], cap_drop: ["ALL"], user: "999:999", read_only: true, tmpfs: ["/tmp"] },
    web: { ...common, image: OBSERVABILITY_IMAGES.glitchtip, environment, depends_on: { "errors-db": { condition: "service_healthy" }, valkey: { condition: "service_started" } }, volumes: ["uploads:/code/uploads"], ports: ["127.0.0.1::8080"], cap_drop: ["ALL"] },
    worker: { ...common, image: OBSERVABILITY_IMAGES.glitchtip, environment: { ...environment, SERVER_ROLE: "worker_with_beat" }, depends_on: { "errors-db": { condition: "service_healthy" }, valkey: { condition: "service_started" } }, volumes: ["uploads:/code/uploads"], cap_drop: ["ALL"] },
    umami: { ...common, image: OBSERVABILITY_IMAGES.umami, environment: { DATABASE_URL: `postgresql://umami:${state.secrets.umamiDatabase}@analytics-db:5432/umami`, DATABASE_TYPE: "postgresql", APP_SECRET: state.secrets.app, DISABLE_TELEMETRY: "1" }, depends_on: { "analytics-db": { condition: "service_healthy" } }, ports: ["127.0.0.1::3000"], cap_drop: ["ALL"], init: true },
  }, volumes: { "glitchtip-db": {}, "umami-db": {}, uploads: {} } };
}
function composeArguments(host: HostHelperHost) {
  return ["compose", "--project-name", observabilityProject(host), "--file", path.join(observabilityDirectory(host), "compose.json")];
}
async function databaseDumpFile(host: HostHelperHost, args: string[], file: string, restore = false) {
  const handle = await open(file, restore ? "r" : "wx", 0o600);
  try {
    // File descriptors keep database-size bytes off the helper heap. Provider
    // stderr remains bounded and is never exposed in operator diagnostics.
    const r = spawnSync("docker", [...composeArguments(host), ...args], { stdio: restore ? [handle.fd, "pipe", "pipe"] : ["ignore", handle.fd, "pipe"], timeout: 3600_000, maxBuffer: 4 * 1024 * 1024 });
    if (r.error || r.status !== 0) fail("Observability database dump operation failed.");
  } finally { await handle.close(); }
}
async function fileDigest(file: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
export function observabilityDocker(host: HostHelperHost, args: string[], input?: string | Buffer, maxBuffer?: number) {
  return command([...composeArguments(host), ...args], input, maxBuffer);
}
export function observabilityPort(host: HostHelperHost, service: "web" | "umami") {
  const output = observabilityDocker(host, ["port", service, service === "web" ? "8080" : "3000"]).toString().trim();
  const match = /^127\.0\.0\.1:(\d+)$/.exec(output);
  if (!match || +match[1] < 1024 || +match[1] > 65535) fail("Observability service has no private published port.");
  return +match[1];
}
async function api(host: HostHelperHost, service: "web" | "umami", route: string, token?: string, body?: unknown, optional = false) {
  try {
    const response = await fetch(`http://127.0.0.1:${observabilityPort(host, service)}${route}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (optional && response.status === 404) return null;
    if (!response.ok) fail();
    const text = await response.text();
    if (text.length > 1024 * 1024) fail();
    return text ? JSON.parse(text) : {};
  } catch { return fail(); }
}
async function waitReady(host: HostHelperHost, service: "web" | "umami") {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try { await api(host, service, service === "web" ? "/api/0/" : "/api/heartbeat"); return; } catch { /* bounded startup retry */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  fail("Observability service startup timed out.");
}
async function loginUmami(host: HostHelperHost, state: State) {
  return api(host, "umami", "/api/auth/login", undefined, { username: "admin", password: state.secrets.analyticsPassword });
}
// Call under the Host-wide route lock. The durable intent reserves hostnames even
// if installation crashes. No route is exposed until both admin accounts are safe.
export async function enableObservability(host: HostHelperHost, applyRoutes: (ports: { errors: number; analytics: number }) => Promise<void>) {
  await trustedBackupPath(host.remoteRoot, true);
  const info = JSON.parse(command(["info", "--format", "{{json .}}"]).toString());
  const disk = await statfs(host.remoteRoot);
  assertObservabilityResources(info.NCPU, info.MemTotal, disk.bavail * disk.bsize);
  const directory = observabilityDirectory(host);
  if (await lstat(path.join(directory, "restore.json")).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; })) fail("Finish the interrupted service restore before enabling observability.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await trustedBackupPath(directory, true);
  let state = await readObservabilityState(host);
  if (!state) {
    const secret = () => randomBytes(32).toString("hex");
    state = { version: 1, enabled: true, ready: false, disclosed: false, secrets: { database: secret(), umamiDatabase: secret(), django: secret(), app: secret(), errorsPassword: secret(), analyticsPassword: secret(), token: secret() } };
  }
  state.enabled = true;
  await atomicBackupJson(path.join(directory, "secrets.json"), state);
  await atomicBackupJson(path.join(directory, "compose.json"), observabilityCompose(host, state));
  observabilityDocker(host, ["up", "-d", "--wait", "errors-db", "analytics-db", "valkey"]);
  observabilityDocker(host, ["run", "--rm", "--no-deps", "web", "./manage.py", "migrate", "--noinput"]);
  observabilityDocker(host, ["up", "-d"]);
  await waitReady(host, "web");
  // Only bootstrap the accounts. Projects and websites are always provisioned via APIs.
  const bootstrap = `import json,sys\nfrom django.contrib.auth import get_user_model\nfrom apps.api_tokens.models import APIToken\nv=json.load(sys.stdin)\nu,created=get_user_model().objects.get_or_create(email=v['email'],defaults={'is_superuser':True,'is_staff':True})\nif created:\n u.set_password(v['password']);u.save()\nt,_=APIToken.objects.get_or_create(token=v['token'],defaults={'user':u,'label':'Sporades Host provisioning'})\nt.add_permissions(['org:read','org:write','team:read','team:write','project:read','project:write'])\n`;
  observabilityDocker(host, ["exec", "-T", "web", "./manage.py", "shell", "-c", bootstrap], JSON.stringify({ email: `ops@${host.domain}`, password: state.secrets.errorsPassword, token: state.secrets.token }));
  await waitReady(host, "umami");
  try { await loginUmami(host, state); }
  catch {
    if (state.ready) fail("Umami admin credentials changed; restore the protected Host credential before enabling.");
    const login = await api(host, "umami", "/api/auth/login", undefined, { username: "admin", password: "umami" });
    await api(host, "umami", `/api/users/${encodeURIComponent(login.user.id)}`, login.token, { username: "admin", password: state.secrets.analyticsPassword });
    await loginUmami(host, state);
  }
  // Establish organization/team once. Their exact fixed identities recover API-before-journal crashes.
  if (!await api(host, "web", "/api/0/organizations/sporades/", state.secrets.token, undefined, true)) await api(host, "web", "/api/0/organizations/", state.secrets.token, { name: "Sporades" });
  if (!await api(host, "web", "/api/0/teams/sporades/capsules/", state.secrets.token, undefined, true)) await api(host, "web", "/api/0/organizations/sporades/teams/", state.secrets.token, { slug: "capsules" });
  await applyRoutes({ errors: observabilityPort(host, "web"), analytics: observabilityPort(host, "umami") });
  state.ready = true;
  const credentials = state.disclosed ? undefined : { errors: { username: `ops@${host.domain}`, password: state.secrets.errorsPassword }, analytics: { username: "admin", password: state.secrets.analyticsPassword } };
  await publishObservabilityMetric(host, 1, true);
  if (await readHostBackupPolicy(host)) await publishHostBackupMetric(host, "_observability");
  state.disclosed = true;
  await atomicBackupJson(path.join(directory, "secrets.json"), state);
  return { enabled: true, ready: true, urls: observabilityUrls(host), ...(credentials ? { credentials } : {}) };
}
export function observabilityUrls(host: HostHelperHost) { return { errors: `https://errors.${host.domain}`, analytics: `https://analytics.${host.domain}` }; }
export async function disableObservability(host: HostHelperHost, applyRoutes: () => Promise<void>, uninstall = false) {
  const state = await readObservabilityState(host);
  if (!state) return { enabled: false, installed: false };
  state.enabled = false;
  await atomicBackupJson(path.join(observabilityDirectory(host), "secrets.json"), state);
  await applyRoutes();
  observabilityDocker(host, uninstall ? ["down", "--remove-orphans"] : ["stop"]);
  await publishObservabilityMetric(host, 0);
  return { enabled: false, dataRetained: true, credentialsRetained: true, uninstalled: uninstall };
}
export async function statusObservability(host: HostHelperHost) {
  const state = await readObservabilityState(host);
  if (!state) return { installed: false, enabled: false };
  let healthy = false;
  if (state.enabled) try { await api(host, "web", "/api/0/"); await api(host, "umami", "/api/heartbeat"); healthy = true; } catch { /* status is secret-free */ }
  await publishObservabilityMetric(host, healthy ? 1 : 0, state.enabled);
  if (state.enabled && await readHostBackupPolicy(host)) await publishHostBackupMetric(host, "_observability");
  return { installed: true, enabled: state.enabled, ready: state.ready, healthy, urls: observabilityUrls(host), images: OBSERVABILITY_IMAGES };
}
export async function provisionObservability(host: HostHelperHost, target: ObservabilityTarget) {
  const state = await readObservabilityState(host);
  if (!state?.enabled || !state.ready) return { connected: false, reason: "observability-disabled" };
  if (!target || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(target.subname) || !target.domain?.split(".").every(l => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) || target.domain.length > 253 || typeof target.publicKey !== "string" || target.publicKey.length > 8192) fail("Invalid observability Capsule target.");
  const { sealServerEnv } = await import("../sealed-server-env.js");
  if (typeof target.errors !== "boolean" || typeof target.analytics !== "boolean" || (!target.errors && !target.analytics)) fail("Choose at least one Capsule integration.");
  sealServerEnv({}, target.publicKey); // Validate encryption authority before any provider mutation.
  const identity = `${target.subname}.${target.domain}`;
  const hash = createHash("sha256").update(identity).digest("hex");
  const slug = `capsule-${hash.slice(0, 32)}`;
  const values: Record<string, string> = {};
  if (target.errors) {
    if (!await api(host, "web", `/api/0/projects/sporades/${slug}/`, state.secrets.token, undefined, true)) await api(host, "web", "/api/0/teams/sporades/capsules/projects/", state.secrets.token, { name: slug, slug, platform: "node" });
    let keys = await api(host, "web", `/api/0/projects/sporades/${slug}/keys/`, state.secrets.token);
    if (!Array.isArray(keys)) keys = keys.items ?? keys.results;
    if (!keys?.length) keys = [await api(host, "web", `/api/0/projects/sporades/${slug}/keys/`, state.secrets.token, { name: "Sporades" })];
    const dsn = new URL(keys[0].dsn.public);
    // Never trust a provider-supplied destination. Pin the public endpoint to this Host.
    if (!/\/\d+$/.test(dsn.pathname) || !/^[a-f0-9]{32}$/.test(dsn.username)) fail();
    values.ERROR_DSN = `https://${dsn.username}@errors.${host.domain}${dsn.pathname}`;
  }
  if (target.analytics) {
    const login = await loginUmami(host, state);
    const id = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
    if (!await api(host, "umami", `/api/websites/${id}`, login.token, undefined, true)) await api(host, "umami", "/api/websites", login.token, { id, name: identity.slice(0,100), domain: identity });
    values.ANALYTICS_ENDPOINT = `https://analytics.${host.domain}/api/send`;
    values.ANALYTICS_WEBSITE_ID = id;
  }
  return { connected: true, identity, env: sealServerEnv(values, target.publicKey, { source: "host-services", identity }) };
}
export async function publishObservabilityMetric(host: HostHelperHost, up: number, enabled = false) {
  // Reuse the existing node_exporter textfile mount, without sharing secrets.
  const directory = path.join(host.remoteRoot, "backup-metrics");
  await mkdir(directory, { recursive: true, mode: 0o755 });
  await trustedBackupPath(directory);
  await chmod(directory, 0o755);
  const file = path.join(directory, `observability-${createHash("sha256").update(host.domain).digest("hex")}.prom`);
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temp, `sporades_observability_up{capsule_domain=${JSON.stringify(host.domain)}} ${up}\nsporades_observability_enabled{capsule_domain=${JSON.stringify(host.domain)}} ${enabled ? 1 : 0}\nsporades_observability_checked_seconds{capsule_domain=${JSON.stringify(host.domain)}} ${Math.floor(Date.now() / 1000)}\n`, { flag: "wx", mode: 0o644 });
  try { await chmod(temp, 0o644); await rename(temp, file); } finally { await rm(temp, { force: true }); }
}

const SERVICE_BACKUP_TAG = "_observability";
export async function backupObservability(host: HostHelperHost) {
  const policy = await readHostBackupPolicy(host);
  if (!policy) fail("Configure Host backups before backing up observability.");
  const state = await readObservabilityState(host);
  if (!state?.ready) fail("Enable observability before its first backup.");
  if (await lstat(path.join(observabilityDirectory(host), "restore.json")).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; })) fail("Finish service restore before creating another backup.");
  const directory = observabilityDirectory(host);
  const staging = path.join(directory, "backup-stage");
  await trustedBackupPath(directory, true);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { mode: 0o700 });
  try {
    // pg_dump takes a transaction-consistent snapshot of each independent database.
    const checksums: Record<string,string> = {};
    for (const [service, user] of [["errors-db", "glitchtip"], ["analytics-db", "umami"]]) {
      const file = `${user}.dump`;
      await databaseDumpFile(host, ["exec", "-T", service, "pg_dump", "-U", user, "-d", user, "-Fc"], path.join(staging, file));
      checksums[file] = await fileDigest(path.join(staging, file));
    }
    const createdAt = new Date().toISOString();
    await atomicBackupJson(path.join(staging, "manifest.json"), { version: 1, domain: host.domain, createdAt, secrets: state.secrets, checksums });
    const output = await restic(policy, ["backup", "--host", host.domain, "--tag", `sporades:${host.domain}:${SERVICE_BACKUP_TAG}`, "--", "glitchtip.dump", "umami.dump", "manifest.json"], staging);
    const summary = output.trim().split("\n").map(line => JSON.parse(line)).find(v => v.message_type === "summary");
    if (!/^[a-f0-9]{64}$/.test(summary?.snapshot_id)) fail("Incomplete observability backup.");
    await atomicBackupJson(path.join(hostBackupDirectory(host), `${SERVICE_BACKUP_TAG}.json`), { id: summary.snapshot_id, createdAt, repository: createHash("sha256").update(policy.repository).digest("hex") });
    await publishHostBackupMetric(host, SERVICE_BACKUP_TAG);
    return { id: summary.snapshot_id, createdAt };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
export async function listObservabilityBackups(host: HostHelperHost) {
  const policy = await readHostBackupPolicy(host);
  if (!policy) fail("Host backups are not configured.");
  return { snapshots: await listHostBackups(policy, host, SERVICE_BACKUP_TAG) };
}
export async function pruneObservabilityBackups(host: HostHelperHost) {
  const policy = await readHostBackupPolicy(host);
  if (!policy) fail("Host backups are not configured.");
  return pruneHostBackups(policy, host, SERVICE_BACKUP_TAG);
}
export async function restoreObservability(host: HostHelperHost, id: string | undefined, confirm: string | undefined) {
  const state = await readObservabilityState(host);
  const policy = await readHostBackupPolicy(host);
  if (!state || state.enabled || !policy || !id || confirm !== "observability" || !/^[a-f0-9]{64}$/.test(id)) fail("Disable observability and confirm a full snapshot ID before restoring.");
  if (!(await listHostBackups(policy, host, SERVICE_BACKUP_TAG)).some(s => s.id === id)) fail("Snapshot is not an observability backup for this Hosted domain.");
  const directory = observabilityDirectory(host);
  const staging = path.join(directory, "restore-stage");
  const journal = path.join(directory, "restore.json");
  await trustedBackupPath(directory, true);
  const pending = await readFile(journal, "utf8").then(v => { try { return JSON.parse(v); } catch { return fail("Invalid protected restore journal."); } }).catch(e => { if (e.code === "ENOENT") return null; throw e; });
  if (pending && pending.id !== id) fail("Retry the interrupted service restore with its original snapshot ID.");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { mode: 0o700 });
  try {
    await restic(policy, ["restore", id, "--target", staging]);
    if (JSON.stringify((await readdir(staging)).sort()) !== JSON.stringify(["glitchtip.dump", "manifest.json", "umami.dump"])) fail("Unexpected observability backup contents.");
    for (const name of ["manifest.json", "glitchtip.dump", "umami.dump"]) {
      await trustedBackupPath(path.join(staging, name));
      const details = await lstat(path.join(staging, name));
      if (!details.isFile() || details.nlink !== 1) fail("Invalid observability backup file.");
    }
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(staging, "manifest.json"), "utf8")); } catch { return fail("Invalid observability backup manifest."); }
    if (manifest.version !== 1 || manifest.domain !== host.domain || JSON.stringify(manifest.secrets) !== JSON.stringify(state.secrets)) fail("Observability backup identity or retained credentials do not match.");
    for (const user of ["glitchtip", "umami"]) {
      if (await fileDigest(path.join(staging, `${user}.dump`)) !== manifest.checksums[`${user}.dump`]) fail("Observability backup checksum mismatch.");
    }
    // A journal fences enable/connect until both databases have converged. If a
    // restore crashes, repeat the same snapshot; partial databases stay offline.
    await atomicBackupJson(journal, { version: 1, id });
    observabilityDocker(host, ["stop", "web", "worker", "umami"]);
    observabilityDocker(host, ["up", "-d", "--wait", "errors-db", "analytics-db"]);
    for (const [service, user] of [["errors-db", "glitchtip"], ["analytics-db", "umami"]]) {
      // GlitchTip uses inherited partition constraints: pg_restore --clean
      // cannot drop these individually. Replace the isolated service database
      // while all its clients are stopped, then restore into the empty database.
      observabilityDocker(host, ["exec", "-T", service, "psql", "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS "${user}" WITH (FORCE)`]);
      observabilityDocker(host, ["exec", "-T", service, "createdb", "-U", user, "-O", user, user]);
      await databaseDumpFile(host, ["exec", "-T", service, "pg_restore", "-U", user, "-d", user, "--no-owner", "--exit-on-error"], path.join(staging, `${user}.dump`), true);
    }
    await rm(journal);
    return { restored: true, id, enabled: false, enableRequired: true };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export function observabilityMonitorUnits(host: HostHelperHost) {
  const name = observabilityProject(host);
  const helper = JSON.stringify(path.join(host.remoteRoot, "bin", "sporades-host-helper")).replace(/%/g, "%%").replace(/\$/g, () => "$$");
  const encoded = Buffer.from(JSON.stringify(host)).toString("base64url");
  return { name, service: `# Sporades observability health\n[Unit]\nDescription=Sporades observability health\nAfter=docker.service\n[Service]\nType=oneshot\nUMask=0077\nExecStart=${helper} --observe-host ${encoded}\nTimeoutStartSec=90\n`, timer: `# Sporades observability health\n[Unit]\nDescription=Sporades observability health\n[Timer]\nOnBootSec=60\nOnUnitActiveSec=60\n[Install]\nWantedBy=timers.target\n` };
}
export async function installObservabilityMonitor(host: HostHelperHost, enabled: boolean, directory = "/etc/systemd/system") {
  const units = observabilityMonitorUnits(host);
  await trustedBackupPath(directory, true);
  for (const extension of ["service", "timer"]) {
    const file = path.join(directory, `${units.name}.${extension}`);
    const previous = await readFile(file, "utf8").catch(e => { if (e.code === "ENOENT") return null; throw e; });
    if (previous) {
      await trustedBackupPath(file);
      if (!previous.startsWith("# Sporades observability health\n")) fail("Observability timer is operator-owned.");
    }
  }
  if (enabled) {
    await trustedBackupPath(path.join(host.remoteRoot, "bin", "sporades-host-helper"));
    for (const [extension, contents] of [["service", units.service], ["timer", units.timer]]) {
      const file = path.join(directory, `${units.name}.${extension}`);
      const previous = await readFile(file, "utf8").catch(e => { if (e.code === "ENOENT") return null; throw e; });
      if (previous && !previous.startsWith("# Sporades observability health\n")) fail("Observability timer is operator-owned.");
      if (previous) await trustedBackupPath(file);
      const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(temp, contents, { flag: "wx", mode: 0o644 });
      try { await rename(temp, file); } finally { await rm(temp, { force: true }); }
    }
  }
  for (const args of [["daemon-reload"], [enabled ? "enable" : "disable", "--now", `${units.name}.timer`]]) if (spawnSync("systemctl", args, { timeout: 30_000 }).status !== 0) fail("Could not reconcile observability monitoring; retry the services command.");
}
