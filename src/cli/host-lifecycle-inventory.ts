import { readFile, readdir, lstat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { readHostTelemetryConnection } from "./host-telemetry-relay.js";
import { readInventoryFile, writeInventoryFile, withInventoryLock, validateInventory, type LifecycleInventory, type InventoryCapsule } from "./lifecycle-inventory.js";

type PendingInventory = { destination: string; desired: LifecycleInventory; acknowledgedRevision: number; acknowledgedAt: string | null; lastAttemptAt: string | null; delivery: string; lastConfirmedAt: string | null };
const files = (root: string) => ({ directory: path.join(root, "telemetry", "inventory"), state: path.join(root, "telemetry", "inventory", "desired.json") });

async function trustedDirectory(directory: string) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || (process.geteuid && stat.uid !== process.geteuid())) throw new Error("Untrusted Host registry directory.");
}

async function snapshot(root: string): Promise<InventoryCapsule[]> {
  const domains = await readdir(path.join(root, "hosts")).catch(e => { if (e.code === "ENOENT") return []; throw e; });
  const result: InventoryCapsule[] = [];
  for (const domain of domains.sort()) {
    if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(domain)) continue;
    const directory = path.join(root, "hosts", domain, "registry", "capsules");
    for (const dir of [path.join(root, "hosts"), path.join(root, "hosts", domain), path.join(root, "hosts", domain, "registry")]) await trustedDirectory(dir);
    const records = await readdir(directory).catch(e => { if (e.code === "ENOENT") return []; throw e; });
    if (records.length) await trustedDirectory(directory);
    for (const filename of records.sort()) {
      if (!filename.endsWith(".json")) continue;
      const file = path.join(directory, filename);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) || (process.geteuid && stat.uid !== process.geteuid())) throw new Error("Invalid Host registry inventory.");
      const record = JSON.parse(await readFile(file, "utf8"));
      if (record.domain !== domain || filename !== `${record.subname}.json` || (record.remoteCapsuleId && record.remoteCapsuleId !== `${domain}/${record.subname}`)) throw new Error("Invalid Host registry identity.");
      const state = record.status === "unregistered" ? "deleted" : record.telemetry?.disabled === true ? "opted-out" : record.status === "running" ? "started" : record.status ?? "registered";
      const targets: string[] = [];
      if (state !== "deleted") {
        const url = new URL(record.hostedUrl);
        if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.hostname !== `${record.subname}.${domain}`) throw new Error("Invalid Host registry address.");
        targets.push(url.origin + "/");
        for (const alias of record.aliasDomains ?? []) {
          const target = new URL(url.origin);
          target.hostname = alias;
          if (target.hostname !== alias || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(alias)) throw new Error("Invalid Host registry alias.");
          targets.push(target.origin + "/");
        }
      }
      result.push({ identity: `${domain}/${record.subname}`, state, targets, ...(record.currentRelease?.id ? { releaseId: record.currentRelease.id } : {}), ...(record.updatedAt ? { lifecycleAt: record.updatedAt } : {}) });
    }
  }
  return result;
}

export async function queueHostInventory(root: string) {
  const connection = await readHostTelemetryConnection(root);
  if (!connection?.inventoryHost) return null;
  const f = files(root);
  return withInventoryLock(f.directory, async () => {
    const previous = await readInventoryFile<PendingInventory>(f.state);
    if (previous) validateInventory(previous.desired);
    if (previous && previous.desired.host !== connection.inventoryHost) throw new Error("Inventory Host identity changed; recovery required.");
    const capsules = await snapshot(root);
    const ids = new Set(capsules.map(c => c.identity));
    for (const old of previous?.desired.capsules ?? []) if (!ids.has(old.identity)) capsules.push({ identity: old.identity, state: "deleted", targets: [] });
    const desired = validateInventory({ schemaVersion: 1, host: connection.inventoryHost, revision: previous?.desired.revision ?? 1, capsules });
    const sameDestination = previous?.destination === connection.endpoint;
    if (previous && sameDestination && JSON.stringify(previous.desired.capsules) === JSON.stringify(desired.capsules)) return previous;
    if (previous) desired.revision++;
    const next: PendingInventory = { destination: connection.endpoint, desired, acknowledgedRevision: sameDestination ? previous.acknowledgedRevision : 0, acknowledgedAt: sameDestination ? previous.acknowledgedAt : null, lastAttemptAt: sameDestination ? previous.lastAttemptAt : null, delivery: "pending", lastConfirmedAt: sameDestination ? previous.lastConfirmedAt : null };
    await writeInventoryFile(f.state, next);
    return next;
  });
}

export async function hostInventoryStatus(root: string) {
  const state = await readInventoryFile<PendingInventory>(files(root).state);
  if (!state) return { configured: false, pending: false, stale: false };
  return { configured: true, host: state.desired.host, desiredRevision: state.desired.revision, acknowledgedRevision: state.acknowledgedRevision, acknowledgedAt: state.acknowledgedAt, lastAttemptAt: state.lastAttemptAt, lastConfirmedAt: state.lastConfirmedAt, pending: state.acknowledgedRevision !== state.desired.revision, stale: !state.lastConfirmedAt || Date.now() - Date.parse(state.lastConfirmedAt) > 120000, delivery: state.delivery };
}

export async function exportHostInventory(root: string) {
  const state = await queueHostInventory(root);
  if (!state) throw new Error("Host inventory connection is not configured.");
  return state.desired;
}

async function protectedText(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) || (process.geteuid && stat.uid !== process.geteuid())) throw new Error("Unprotected Host inventory connection.");
  return readFile(file, "utf8");
}

// Runs in a Host-owned timer, never in a Capsule lifecycle request. Refresh the
// snapshot before every attempt so a crash before queueing is also recoverable.
export async function reconcileHostInventory(root: string) {
  await queueHostInventory(root);
  const connection = await readHostTelemetryConnection(root);
  if (!connection?.inventoryHost) return hostInventoryStatus(root);
  const directory = path.join(root, "telemetry");
  const credentials = await readInventoryFile<{ credential: string }>(path.join(directory, "inventory-credential.json"));
  if (!credentials || typeof credentials.credential !== "string" || credentials.credential.length < 16 || /[\x00-\x1f\x7f]/.test(credentials.credential)) throw new Error("Invalid Host inventory credential.");
  const ca = connection.caConfigured ? await protectedText(path.join(directory, "ca.pem")) : undefined;
  const f = files(root);
  const sent = await readInventoryFile<PendingInventory>(f.state);
  if (!sent) return hostInventoryStatus(root);
  const body = JSON.stringify(sent.desired);
  const result = await new Promise<{ status: number; revision?: number; acknowledgedAt?: string }>(resolve => {
    const req = httpsRequest(new URL(`/v1/inventory/${connection.inventoryHost}`, connection.endpoint), { method: "PUT", headers: { authorization: `Bearer ${credentials.credential}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) }, ...(ca ? { ca } : {}), timeout: 5000 }, res => {
      let text = "";
      res.on("data", chunk => { text += chunk; if (text.length > 4096) req.destroy(); });
      res.on("error", () => resolve({ status: 0 }));
      res.on("end", () => { try { resolve({ ...JSON.parse(text), status: res.statusCode ?? 0 }); } catch { resolve({ status: 0 }); } });
    });
    const deadline = setTimeout(() => req.destroy(), 6000);
    req.on("close", () => clearTimeout(deadline));
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ status: 0 }));
    req.end(body);
  });
  await withInventoryLock(f.directory, async () => {
    const state = await readInventoryFile<PendingInventory>(f.state);
    if (!state || state.desired.host !== sent.desired.host || state.destination !== sent.destination || state.destination !== connection.endpoint) return;
    state.lastAttemptAt = new Date().toISOString();
    if (result.status === 200 && result.revision === sent.desired.revision && result.revision >= state.acknowledgedRevision && typeof result.acknowledgedAt === "string" && Number.isFinite(Date.parse(result.acknowledgedAt))) {
      state.acknowledgedRevision = result.revision;
      state.acknowledgedAt = result.acknowledgedAt;
      state.lastConfirmedAt = new Date().toISOString();
      state.delivery = state.desired.revision === result.revision ? "acknowledged" : "pending";
    } else state.delivery = result.status === 401 || result.status === 403 ? "authority-denied" : result.status === 409 ? "revision-conflict" : "unavailable";
    await writeInventoryFile(f.state, state);
  });
  return hostInventoryStatus(root);
}

export async function importHostInventory(root: string, input: unknown) {
  const connection = await readHostTelemetryConnection(root);
  const inventory = validateInventory(input);
  if (!connection?.inventoryHost || inventory.host !== connection.inventoryHost) throw new Error("Inventory authority denied.");
  const f = files(root);
  await withInventoryLock(f.directory, async () => {
    const prior = await readInventoryFile<PendingInventory>(f.state);
    if (prior && (inventory.revision < prior.desired.revision || (inventory.revision === prior.desired.revision && JSON.stringify(inventory) !== JSON.stringify(prior.desired)))) throw new Error("Inventory revision conflict.");
    await writeInventoryFile(f.state, { destination: connection.endpoint, desired: inventory, acknowledgedRevision: 0, acknowledgedAt: null, lastAttemptAt: null, lastConfirmedAt: null, delivery: "pending" });
  });
  await queueHostInventory(root);
  return hostInventoryStatus(root);
}
