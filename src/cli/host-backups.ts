import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, chown, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { helperError } from "./cli-support.js";
import type { HostHelperHost } from "./hosted-capsule-contract.js";

export type HostBackupPolicy = {
  repository: string;
  passwordFile: string;
  credentialsFile?: string;
  schedule: "hourly" | "daily" | "weekly" | null;
  retention: number;
  maxAgeHours: number;
};
type Snapshot = { id: string; time: string; tags: string[] };
export type HostBackupManifest = { version: 1; domain: string; subname: string; releaseId: string; createdAt: string; schemaHash: string; checksums: Record<string, string>; directories: string[] };
export type BackupTarget = { host: HostHelperHost; subname: string; releaseId: string; data: string };
function manifestSummary(manifest: HostBackupManifest) {
  const { checksums, directories, ...identity } = manifest;
  return { ...identity, fileCount: Object.keys(checksums).length, directoryCount: directories.length };
}

function fail(message: string): never {
  throw helperError(message, "Inspect protected Host backup configuration and restic repository access; no credentials are included in diagnostics.");
}
function absolute(value: unknown): value is string {
  return typeof value === "string" && value.length < 4096 && path.isAbsolute(value) && path.normalize(value) === value && !/[\x00-\x1f\x7f]/.test(value);
}
export function validateHostBackupPolicy(value: unknown): HostBackupPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid Host backup policy.");
  const v = value as HostBackupPolicy;
  if (Object.keys(v).some(k => !["repository", "passwordFile", "credentialsFile", "schedule", "retention", "maxAgeHours"].includes(k))) fail("Unknown Host backup policy field.");
  let repository = absolute(v.repository);
  if (typeof v.repository === "string" && v.repository.startsWith("s3:https://")) {
    let url: URL;
    try { url = new URL(v.repository.slice(3)); } catch { return fail("Invalid Host backup repository."); }
    repository = !!url.hostname && !url.username && !url.password && !url.search && !url.hash && /^\/[^/]+/.test(url.pathname);
  }
  // SFTP is deliberately left to restic's operator interface: scheduled SSH authority is not implicit.
  if (!repository || !absolute(v.passwordFile) || (v.credentialsFile !== undefined && !absolute(v.credentialsFile))
    || ![null, "hourly", "daily", "weekly"].includes(v.schedule)
    || !Number.isSafeInteger(v.retention) || v.retention < 1 || v.retention > 10000
    || !Number.isSafeInteger(v.maxAgeHours) || v.maxAgeHours < 1 || v.maxAgeHours > 87600) fail("Invalid Host backup policy.");
  return { repository: v.repository, passwordFile: v.passwordFile, ...(v.credentialsFile ? { credentialsFile: v.credentialsFile } : {}), schedule: v.schedule, retention: v.retention, maxAgeHours: v.maxAgeHours };
}

// Host-owned paths never follow symlinks, including in ancestors. Capsule bytes are separately
// walked while its only writer is stopped; they are never interpreted as archive paths.
export async function trustedBackupPath(file: string, secret = false) {
  if (!absolute(file)) fail("Invalid Host backup path.");
  const parts = file.split(path.sep).filter(Boolean);
  let current = path.parse(file).root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const s = await lstat(current);
    if (s.isSymbolicLink() || (i < parts.length - 1 && !s.isDirectory())) fail("Unsafe Host backup path.");
    const final = i === parts.length - 1;
    if (secret && ((s.uid !== process.geteuid?.() && (final || s.uid !== 0)) || (s.mode & (final && !s.isDirectory() ? 0o077 : 0o022)))) fail("Host backup credentials must be owned by the helper user and private.");
  }
}
export function hostBackupDirectory(host: HostHelperHost) { return path.join(host.remoteRoot, "hosts", host.domain, "backups"); }
export async function atomicBackupJson(file: string, value: unknown) {
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
  try { await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
}
export async function readHostBackupPolicy(host: HostHelperHost): Promise<HostBackupPolicy | null> {
  const file = path.join(hostBackupDirectory(host), "policy.json");
  try { await lstat(file); await trustedBackupPath(file, true); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  return validateHostBackupPolicy(JSON.parse(await readFile(file, "utf8")));
}

async function resticEnvironment(policy: HostBackupPolicy) {
  await trustedBackupPath(policy.passwordFile, true);
  if (!(await lstat(policy.passwordFile)).isFile()) fail("Invalid backup password file.");
  // Do not inherit RESTIC_*, AWS_*, shell hooks or repository selection from the CLI caller.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, SYSTEMROOT: process.env.SYSTEMROOT, RESTIC_REPOSITORY: policy.repository, RESTIC_PASSWORD_FILE: policy.passwordFile, AWS_SHARED_CREDENTIALS_FILE: "/dev/null", AWS_CONFIG_FILE: "/dev/null", AWS_EC2_METADATA_DISABLED: "true" };
  if (policy.credentialsFile) {
    await trustedBackupPath(policy.credentialsFile, true);
    let credentials;
    try { credentials = JSON.parse(await readFile(policy.credentialsFile, "utf8")); } catch { return fail("Invalid backup credentials file."); }
    if (!credentials || Array.isArray(credentials) || Object.keys(credentials).some(k => !["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_DEFAULT_REGION"].includes(k))) fail("Invalid backup credentials file.");
    for (const [key, value] of Object.entries(credentials)) {
      if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) fail("Invalid backup credential.");
      env[key] = value;
    }
  }
  return env;
}
export async function restic(policy: HostBackupPolicy, args: string[], cwd?: string) {
  const result = spawnSync("restic", ["--no-cache", "--json", ...args], { env: await resticEnvironment(policy), cwd, encoding: "utf8", timeout: 3600_000, maxBuffer: 8 * 1024 * 1024 });
  // Exit 3 (incomplete backup) must never advance freshness or trigger retention.
  if (result.error || result.status !== 0) fail("Host backup repository operation failed.");
  return result.stdout;
}
function tag(host: HostHelperHost, subname: string) { return `sporades:${host.domain}:${subname}`; }
export async function listHostBackups(policy: HostBackupPolicy, host: HostHelperHost, subname: string): Promise<Snapshot[]> {
  const values = JSON.parse(await restic(policy, ["snapshots", "--tag", tag(host, subname)]));
  if (!Array.isArray(values)) fail("Invalid backup repository response.");
  return values.map((s: Snapshot) => {
    if (!/^[a-f0-9]{64}$/.test(s.id) || !Number.isFinite(Date.parse(s.time)) || !s.tags?.includes(tag(host, subname))) fail("Invalid backup identity.");
    return { id: s.id, time: s.time, tags: s.tags };
  }).sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}
export async function pruneHostBackups(policy: HostBackupPolicy, host: HostHelperHost, subname: string) {
  await restic(policy, ["forget", "--tag", tag(host, subname), "--group-by", "tags", "--keep-last", String(policy.retention), "--prune"]);
  return { pruned: true, retention: policy.retention };
}
async function digest(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function inventory(directory: string) {
  const checksums: Record<string, string> = Object.create(null);
  const directories: string[] = [];
  async function walk(relative: string) {
    const file = path.join(directory, relative);
    const s = await lstat(file);
    if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()) || (s.isFile() && s.nlink !== 1)) fail("Backup data contains a link or special file.");
    if (s.isDirectory()) {
      directories.push(relative);
      for (const name of (await readdir(file)).sort()) await walk(path.posix.join(relative, name));
    } else checksums[relative] = await digest(file);
  }
  await walk("data.db");
  await walk("files");
  return { checksums, directories };
}
function schemaHash(database: DatabaseSync) {
  const rows = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name").all();
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
async function checkDatabase(file: string) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (Object.values(db.prepare("PRAGMA integrity_check").get() ?? {})[0] !== "ok") fail("Backup SQLite integrity check failed.");
    return schemaHash(db);
  } finally { db.close(); }
}
export async function createHostBackup(policy: HostBackupPolicy, target: BackupTarget, afterCapture?: () => Promise<void>) {
  const directory = path.join(path.dirname(target.data), ".backup-create");
  await trustedBackupPath(path.dirname(directory), true);
  await trustedBackupPath(target.data);
  await trustedBackupPath(path.join(target.data, "data.db"));
  const sourceDb = await lstat(path.join(target.data, "data.db"));
  if (!sourceDb.isFile() || sourceDb.nlink !== 1) fail("Backup database must be a regular unlinked file.");
  await rm(directory, { force: true, recursive: true });
  await mkdir(directory, { mode: 0o700 });
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(target.data, "data.db"), { readOnly: true });
    try { db.prepare("VACUUM INTO ?").run(path.join(directory, "data.db")); } finally { db.close(); }
    const files = path.join(target.data, "files");
    // Inspect the source before cp: never read through a Capsule-created symlink.
    const hasFiles = await lstat(files).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; });
    if (hasFiles) {
      await inventoryFiles(files);
      await cp(files, path.join(directory, "files"), { recursive: true, preserveTimestamps: true });
    } else await mkdir(path.join(directory, "files"), { mode: 0o700 });
    const manifest: HostBackupManifest = { version: 1, domain: target.host.domain, subname: target.subname, releaseId: target.releaseId,
      createdAt: new Date().toISOString(), schemaHash: await checkDatabase(path.join(directory, "data.db")), ...await inventory(directory) };
    await atomicBackupJson(path.join(directory, "manifest.json"), manifest);
    await afterCapture?.(); // Upload and repository encryption do not extend the write outage.
    const output = await restic(policy, ["backup", "--host", target.host.domain, "--tag", tag(target.host, target.subname), "--", "data.db", "files", "manifest.json"], directory);
    const summary = output.trim().split("\n").map(line => JSON.parse(line)).find(v => v.message_type === "summary");
    if (!/^[a-f0-9]{64}$/.test(summary?.snapshot_id)) fail("Backup did not produce a complete snapshot.");
    await atomicBackupJson(path.join(hostBackupDirectory(target.host), `${target.subname}.json`), { id: summary.snapshot_id, createdAt: manifest.createdAt, repository: repositoryIdentity(policy) });
    return { id: summary.snapshot_id, manifest: manifestSummary(manifest) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function publishHostBackupMetric(host: HostHelperHost, subname: string, removed = false) {
  const directory = path.join(host.remoteRoot, "backup-metrics");
  await trustedBackupPath(host.remoteRoot, true);
  await mkdir(directory, { mode: 0o755, recursive: true });
  await trustedBackupPath(directory);
  // Only numeric metrics are shared with the unprivileged exporter. The timer's
  // private umask still applies to backup policy, credentials and staging data.
  await chmod(directory, 0o755);
  const file = path.join(directory, createHash("sha256").update(`${host.domain}/${subname}`).digest("hex") + ".prom");
  const status = await hostBackupStatus(host, subname);
  if (removed || !status.configured) { await rm(file, { force: true }); return; }
  const labels = `capsule_domain=${JSON.stringify(host.domain)},capsule_subname=${JSON.stringify(subname)}`;
  const text = `sporades_backup_last_success_seconds{${labels}} ${status.lastBackupAt ? Date.parse(status.lastBackupAt) / 1000 : 0}\nsporades_backup_max_age_seconds{${labels}} ${status.maxAgeSeconds}\n`;
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o644); // Establish readability before atomic publication, independent of umask.
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}
async function inventoryFiles(directory: string): Promise<void> {
  const s = await lstat(directory).catch(e => { if (e.code === "ENOENT") return null; throw e; });
  if (!s) { await mkdir(directory, { mode: 0o700 }); return; }
  if (!s.isDirectory() || s.isSymbolicLink()) fail("Unsafe Capsule files directory.");
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name);
    const entry = await lstat(file);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()) || (entry.isFile() && entry.nlink !== 1)) fail("Backup data contains a link or special file.");
    if (entry.isDirectory()) await inventoryFiles(file);
  }
}

// A restore never restarts its target. Both initial restore and restart recovery happen with
// the Capsule lifecycle lock held and no running container. The journal precedes either rename.
export async function recoverHostBackupRestore(data: string) {
  const capsule = path.dirname(data);
  const journal = path.join(capsule, ".backup-restore.json");
  // Ordinary lifecycle operations do not opt into backup path policy without a journal.
  try { await lstat(journal); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  await trustedBackupPath(journal, true);
  const value = JSON.parse(await readFile(journal, "utf8"));
  if (value.version !== 1 || !["prepared", "committed"].includes(value.phase)) fail("Invalid backup restore recovery journal.");
  const previous = path.join(capsule, ".backup-previous");
  const staged = path.join(capsule, ".backup-next");
  if (value.phase === "prepared" && await lstat(previous).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; })) {
    await trustedBackupPath(previous);
    await rm(data, { recursive: true, force: true });
    await rename(previous, data);
  }
  await rm(previous, { recursive: true, force: true });
  await rm(staged, { recursive: true, force: true });
  await rm(journal);
}
export async function restoreHostBackup(policy: HostBackupPolicy, target: BackupTarget, sourceSubname: string, id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) fail("Restore requires a full backup snapshot ID.");
  if (!(await listHostBackups(policy, target.host, sourceSubname)).some(s => s.id === id)) fail("Backup does not belong to the requested Capsule.");
  await trustedBackupPath(path.dirname(target.data), true);
  await recoverHostBackupRestore(target.data);
  const capsule = path.dirname(target.data);
  const restored = path.join(capsule, ".backup-verify");
  const staged = path.join(capsule, ".backup-next");
  const previous = path.join(capsule, ".backup-previous");
  const journal = path.join(capsule, ".backup-restore.json");
  await rm(restored, { recursive: true, force: true });
  await mkdir(restored, { mode: 0o700 });
  try {
    await restic(policy, ["restore", id, "--target", restored]);
    const top = (await readdir(restored)).sort();
    const manifestFile = await lstat(path.join(restored, "manifest.json"));
    if (JSON.stringify(top) !== JSON.stringify(["data.db", "files", "manifest.json"]) || !manifestFile.isFile() || manifestFile.isSymbolicLink()) fail("Invalid backup contents.");
    const manifest: HostBackupManifest = JSON.parse(await readFile(path.join(restored, "manifest.json"), "utf8"));
    const actual = await inventory(restored);
    if (manifest.version !== 1 || manifest.domain !== target.host.domain || manifest.subname !== sourceSubname
      || typeof manifest.releaseId !== "string" || !manifest.releaseId || !Number.isFinite(Date.parse(manifest.createdAt))
      || JSON.stringify(actual.checksums) !== JSON.stringify(manifest.checksums) || JSON.stringify(actual.directories) !== JSON.stringify(manifest.directories)
      || await checkDatabase(path.join(restored, "data.db")) !== manifest.schemaHash) fail("Backup manifest or checksums do not match.");
    // Preserve target keys and other data-owned runtime state; never import source authority.
    await trustedBackupPath(target.data);
    await inventoryFiles(target.data);
    await rm(staged, { recursive: true, force: true });
    await cp(target.data, staged, { recursive: true, preserveTimestamps: true });
    for (const name of ["data.db", "data.db-wal", "data.db-shm", "data.db-journal", "files"]) await rm(path.join(staged, name), { recursive: true, force: true });
    await cp(path.join(restored, "data.db"), path.join(staged, "data.db"));
    await cp(path.join(restored, "files"), path.join(staged, "files"), { recursive: true });
    // Restored Capsule files must remain writable by the non-root runtime user.
    const owner = await lstat(target.data);
    async function ownership(file: string, original?: string) {
      const s = await lstat(file);
      const before = original ? await lstat(original).catch(e => { if (e.code === "ENOENT") return owner; throw e; }) : owner;
      await chown(file, before.uid, before.gid);
      if (s.isDirectory()) for (const name of await readdir(file)) await ownership(path.join(file, name), original ? path.join(original, name) : undefined);
    }
    await ownership(staged, target.data);
    await atomicBackupJson(journal, { version: 1, phase: "prepared" });
    try {
      await rename(target.data, previous);
      await rename(staged, target.data);
      await atomicBackupJson(journal, { version: 1, phase: "committed" });
    } finally { await recoverHostBackupRestore(target.data); }
    return { restored: true, id, sourceSubname, subname: target.subname, manifest: manifestSummary(manifest), restartRequired: true };
  } finally { await rm(restored, { recursive: true, force: true }); await rm(staged, { recursive: true, force: true }); }
}
export async function hostBackupStatus(host: HostHelperHost, subname: string) {
  const policy = await readHostBackupPolicy(host);
  if (!policy) return { configured: false };
  const file = path.join(hostBackupDirectory(host), `${subname}.json`);
  let value;
  try { await trustedBackupPath(file, true); value = JSON.parse(await readFile(file, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const time = value?.repository === repositoryIdentity(policy) ? Date.parse(value?.createdAt) : NaN;
  const ageSeconds = Number.isFinite(time) ? Math.max(0, (Date.now() - time) / 1000) : null;
  return { configured: true, lastBackupAt: Number.isFinite(time) ? value.createdAt as string : null, ageSeconds, maxAgeSeconds: policy.maxAgeHours * 3600, stale: ageSeconds === null || ageSeconds > policy.maxAgeHours * 3600 };
}
function repositoryIdentity(policy: HostBackupPolicy) { return createHash("sha256").update(policy.repository).digest("hex"); }

export function backupTimerUnits(host: HostHelperHost, policy: HostBackupPolicy) {
  const identity = createHash("sha256").update(`${host.remoteRoot}\0${host.domain}`).digest("hex").slice(0, 16);
  const name = `sporades-backups-${identity}`;
  const helper = JSON.stringify(path.join(host.remoteRoot, "bin", "sporades-host-helper")).replace(/%/g, "%%").replace(/\$/g, () => "$$");
  const encoded = Buffer.from(JSON.stringify({ alias: host.alias, domain: host.domain, scheme: host.scheme, remoteRoot: host.remoteRoot })).toString("base64url");
  return { name, service: `# Sporades Capsule backups\n[Unit]\nDescription=Sporades Capsule backups\nAfter=docker.service sporades-capsules-${identity}.service\nRequires=docker.service\n[Service]\nType=oneshot\nUMask=0077\nExecStart=${helper} --backup-host ${encoded}\nTimeoutStartSec=infinity\n`, timer: `# Sporades Capsule backups\n[Unit]\nDescription=Sporades Capsule backup schedule\n[Timer]\nOnCalendar=${policy.schedule ?? "daily"}\nPersistent=true\nRandomizedDelaySec=60\n[Install]\nWantedBy=timers.target\n` };
}
export async function configureHostBackups(host: HostHelperHost, input: unknown, systemdDirectory = "/etc/systemd/system") {
  const policy = validateHostBackupPolicy(input);
  if (absolute(policy.repository)) {
    await trustedBackupPath(policy.repository, true);
    const capsules = path.join(host.remoteRoot, "hosts");
    if (policy.repository === capsules || policy.repository.startsWith(capsules + path.sep)) fail("Backup repository must be outside Hosted Capsule storage.");
  }
  await restic(policy, ["snapshots"]); // Repository initialization is an explicit operator action.
  const directory = hostBackupDirectory(host);
  await trustedBackupPath(path.dirname(directory), true);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await trustedBackupPath(directory, true);
  const units = backupTimerUnits(host, policy);
  if (policy.schedule !== null) {
    if (spawnSync("systemctl", ["show", "docker.service", "--property=LoadState", "--value"], { encoding: "utf8" }).stdout?.trim() !== "loaded") fail("Scheduled backups require systemd and Docker.");
  }
  await atomicBackupJson(path.join(directory, "policy.json"), policy);
  if (policy.schedule !== null || await lstat(path.join(systemdDirectory, `${units.name}.timer`)).then(() => true, () => false)) {
    await trustedBackupPath(systemdDirectory, true);
    const helper = path.join(host.remoteRoot, "bin", "sporades-host-helper");
    await trustedBackupPath(helper);
    const helperStat = await lstat(helper);
    if (!helperStat.isFile() || helperStat.uid !== process.geteuid?.() || (helperStat.mode & 0o022)) fail("Unsafe scheduled backup helper.");
    for (const [extension, contents] of [["service", units.service], ["timer", units.timer]]) {
      const file = path.join(systemdDirectory, `${units.name}.${extension}`);
      const before = await readFile(file, "utf8").catch(e => { if (e.code === "ENOENT") return null; throw e; });
      if (before && !before.startsWith("# Sporades Capsule backups\n")) fail("Backup timer is operator-owned.");
      if (before) await trustedBackupPath(file);
      const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(temp, contents, { flag: "wx", mode: 0o644 });
      try { await rename(temp, file); } finally { await rm(temp, { force: true }); }
    }
    for (const args of [["daemon-reload"], [policy.schedule ? "enable" : "disable", "--now", `${units.name}.timer`]]) {
      if (spawnSync("systemctl", args, { timeout: 30_000 }).status !== 0) fail("Could not reconcile the backup timer; retry configuration.");
    }
  }
  return { configured: true, schedule: policy.schedule, timer: policy.schedule ? `${units.name}.timer` : null };
}
