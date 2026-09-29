import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, lstat, readFile, writeFile, rename, rm, access } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { helperError } from "./cli-support.js";

export const HOST_METRICS_NETWORK = "sporades-host-metrics";
const NAME = "sporades-node-exporter";
const IMAGE = "quay.io/prometheus/node-exporter:v1.12.1";
const OWNER = "com.sporades.host-metrics";
export type HostMetrics = { host: string; address: string; enabled: boolean; psi: boolean; caddyMetricsServer?: string };

function fail(message: string): never {
  throw helperError(message, "Inspect Host telemetry resources and protected Caddy configuration, then retry `sporades host telemetry reconcile`. No secret values are included in diagnostics.");
}
function run(command: string, args: string[], timeout = 60_000) {
  const r = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024 });
  return { ok: !r.error && r.status === 0, text: String(r.stdout ?? "").trim() };
}
function inspect(kind: "container" | "network", name: string) {
  const r = run("docker", [kind, "inspect", name]);
  if (!r.ok) return null;
  try { return JSON.parse(r.text)[0]; } catch { return fail("Invalid Docker inspection response."); }
}
function ownedContainer() {
  const c = inspect("container", NAME);
  if (c && c.Config?.Labels?.[OWNER] !== "true") fail("The Host exporter container name belongs to another installation.");
  return c;
}
async function trusted(file: string, optional = false) {
  try {
    const s = await lstat(file);
    if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory()) || (s.mode & 0o022) || (process.geteuid && s.uid !== process.geteuid())) fail("Unsafe Host metrics configuration path.");
  } catch (e) { if (!optional || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
}
async function publish(file: string, text: string, mode = 0o600) {
  await trusted(path.dirname(file)); await trusted(file, true);
  const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(tmp, text, { flag: "wx", mode });
  try { await rename(tmp, file); } finally { await rm(tmp, { force: true }); }
}
export async function readHostMetrics(root: string): Promise<HostMetrics | null> {
  const file = path.join(root, "telemetry", "resources.json");
  try { await trusted(path.dirname(file)); await trusted(file); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  const v = JSON.parse(await readFile(file, "utf8"));
  if (typeof v.host !== "string" || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(v.host) || isIP(v.address) !== 4 || typeof v.enabled !== "boolean" || typeof v.psi !== "boolean") fail("Invalid Host metrics state.");
  if (v.caddyMetricsServer !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(v.caddyMetricsServer)) fail("Invalid Caddy metrics server identity.");
  return v;
}

// Token offsets let us add metrics without reserializing operator Caddy options,
// comments, quoted strings or site blocks. Caddy remains the syntax validator.
function tokens(s: string) {
  const result: { value: string; start: number; end: number }[] = [];
  const pattern = /#[^\n]*|"(?:\\.|[^"\\])*"|`[^`]*`|[{}]|[^\s{}#]+/g;
  for (const match of s.matchAll(pattern)) {
    if (!match[0].startsWith("#")) result.push({ value: match[0], start: match.index!, end: match.index! + match[0].length });
  }
  return result;
}
const BEGIN = "# BEGIN Sporades Host metrics";
const END = "# END Sporades Host metrics";
function stripManaged(s: string) {
  return s.replace(/# BEGIN Sporades Host metrics[\s\S]*?# END Sporades Host metrics\n?/g, "");
}
function enableCaddy(s: string, address: string) {
  if (s.includes(`${BEGIN}\nhttp://${address}:20190 {\n bind ${address}\n metrics /metrics\n}\n${END}`)) return s;
  s = stripManaged(s);
  const t = tokens(s);
  const additions: { at: number; text: string }[] = [];
  const metric = `\n${BEGIN}\nmetrics\n${END}\n`;
  if (t[0]?.value !== "{") {
    s = `{\n${BEGIN}\nservers {\n metrics\n}\n${END}\n}\n${s}`;
  } else {
    let depth = 1, globalEnd = -1, catchall = false;
    for (let i = 1; i < t.length; i++) {
      if (depth === 1 && t[i].value === "servers") {
        let open = i + 1;
        while (open < t.length && t[open].value !== "{") open++;
        if (open === t.length) fail("Cannot locate Caddy servers options.");
        if (open === i + 1) catchall = true;
        let d = 1, hasMetrics = false;
        for (let j = open + 1; j < t.length && d; j++) {
          if (d === 1 && t[j].value === "metrics") hasMetrics = true;
          if (t[j].value === "{") d++;
          if (t[j].value === "}") d--;
        }
        if (!hasMetrics) additions.push({ at: t[open].end, text: metric });
      }
      if (t[i].value === "{") depth++;
      if (t[i].value === "}") depth--;
      if (depth === 0) { globalEnd = t[i].start; break; }
    }
    if (globalEnd < 0) fail("Unclosed Caddy global options.");
    if (!catchall) additions.push({ at: globalEnd, text: `${BEGIN}\nservers {\n metrics\n}\n${END}\n` });
    for (const a of additions.sort((a,b) => b.at - a.at)) s = s.slice(0,a.at) + a.text + s.slice(a.at);
  }
  return `${s.trimEnd()}\n\n${BEGIN}\nhttp://${address}:20190 {\n bind ${address}\n metrics /metrics\n}\n${END}\n`;
}
async function configureBootOrder(root: string) {
  // Docker restores the private bridge before Caddy binds its metrics address.
  if (run("systemctl", ["show", "caddy.service", "--property=LoadState", "--value"]).text !== "loaded") return;
  const dir = "/etc/systemd/system/caddy.service.d";
  await trusted("/etc/systemd/system");
  await mkdir(dir, { recursive: true, mode: 0o755 }); await trusted(dir);
  const file = path.join(dir, "90-sporades-host-metrics.conf");
  const config = JSON.stringify(path.join(root, "caddy", "Caddyfile")).replace(/%/g, "%%");
  const content = `# Sporades Host metrics boot ordering\n[Unit]\nAfter=docker.service\nRequires=docker.service\n[Service]\nExecStart=\nExecStart=/usr/bin/caddy run --config ${config} --adapter caddyfile\nExecReload=\nExecReload=/usr/bin/caddy reload --config ${config} --adapter caddyfile\nRestart=on-failure\nRestartSec=5s\n`;
  await trusted(file, true);
  const before = await readFile(file, "utf8").catch((e) => { if(e.code === "ENOENT") return null; throw e; });
  if (before === content) return;
  if (before && !before.startsWith("# Sporades Host metrics boot ordering\n")) fail("Caddy boot-order override is operator-owned.");
  await publish(file, content, 0o644);
  if (!run("systemctl", ["daemon-reload"]).ok) fail("Could not reload Caddy boot ordering.");
}

async function configureCaddy(root: string, address: string, enabled: boolean) {
  const dir = path.join(root, "caddy");
  const file = path.join(dir, "Caddyfile");
  await trusted(root); await trusted(dir); await trusted(file);
  const before = await readFile(file, "utf8");
  const after = enabled ? enableCaddy(before, address) : stripManaged(before);
  if (before === after) return enabled ? metricsServer(file, address) : undefined;
  const candidate = path.join(dir, `.telemetry-${randomBytes(8).toString("hex")}.tmp`);
  await writeFile(candidate, after, { flag: "wx", mode: 0o644 });
  try {
    if (!run("caddy", ["validate", "--config", candidate, "--adapter", "caddyfile"]).ok) fail("Caddy rejected the Host metrics configuration; the active configuration was preserved.");
    await publish(path.join(root,"telemetry","caddy-before-resources.conf"), before);
    await publish(file, after, 0o644);
    if (!run("caddy", ["reload", "--config", file, "--adapter", "caddyfile"]).ok) {
      await publish(file, before, 0o644);
      if (!run("caddy", ["reload", "--config", file, "--adapter", "caddyfile"]).ok) fail("Caddy reload and recovery failed; the previous file has been restored.");
      fail("Caddy reload failed; the previous configuration was restored.");
    }
  } finally { await rm(candidate, { force: true }); }
  return enabled ? metricsServer(file, address) : undefined;
}

function metricsServer(file: string, address: string): string {
  const result = run("caddy", ["adapt", "--config", file, "--adapter", "caddyfile"]);
  if (!result.ok) fail("Cannot identify the private Caddy metrics listener.");
  const servers = JSON.parse(result.text)?.apps?.http?.servers ?? {};
  const match = Object.entries(servers).find(([, value]) => (value as { listen?: string[] }).listen?.includes(`${address}:20190`));
  if (!match || !/^[a-zA-Z0-9_-]{1,80}$/.test(match[0])) fail("Cannot identify the private Caddy metrics listener.");
  return match[0];
}

export async function configureHostMetrics(root: string, host: string, operation: "reconcile" | "enable" | "disable" | "remove" = "reconcile"): Promise<HostMetrics> {
  if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(host)) fail("Invalid canonical Host identity.");
  const saved = await readHostMetrics(root);
  host = saved?.host ?? host;
  const enabled = operation === "enable" || (operation === "reconcile" && saved?.enabled !== false);
  if (!enabled) {
    await configureCaddy(root, saved?.address ?? "127.0.0.1", false);
    if (ownedContainer() && !run("docker", operation === "remove" ? ["rm", "-f", NAME] : ["stop", NAME]).ok) fail("Could not stop the Host exporter.");
    const state = { host, address: saved?.address ?? "127.0.0.1", enabled: false, psi: saved?.psi ?? false };
    await publish(path.join(root, "telemetry", "resources.json"), JSON.stringify(state));
    return state;
  }
  let network = inspect("network", HOST_METRICS_NETWORK);
  if (!network) {
    if (!run("docker", ["network", "create", "--internal", "--label", `${OWNER}=true`, HOST_METRICS_NETWORK]).ok) fail("Could not create the private Host metrics network.");
    network = inspect("network", HOST_METRICS_NETWORK);
  }
  if (network?.Labels?.[OWNER] !== "true" || network?.Internal !== true) fail("The Host metrics network is not privately owned by Sporades.");
  const address = network?.IPAM?.Config?.find((c: {Gateway?: string}) => isIP(c.Gateway ?? "") === 4)?.Gateway;
  if (!address) fail("The Host metrics network needs an IPv4 gateway.");
  const args = ["--network", "host", "--pid", "host", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65534:65534", "--memory", "128m", "--cpus", "0.25", "--pids-limit", "64", "--log-opt", "max-size=10m", "--log-opt", "max-file=3", "--mount", "type=bind,source=/,target=/host,readonly,bind-propagation=rslave", IMAGE, "--path.rootfs=/host", "--path.procfs=/host/proc", "--path.sysfs=/host/sys", `--web.listen-address=${address}:9100`, "--collector.disable-defaults", ...["cpu", "loadavg", "meminfo", "vmstat", "diskstats", "filesystem", "netdev", "netstat", "pressure", "uname", "time", "stat"].map(c=>`--collector.${c}`), "--collector.filesystem.fs-types-exclude=^(autofs|binfmt_misc|bpf|cgroup2?|configfs|debugfs|devpts|devtmpfs|fusectl|hugetlbfs|mqueue|nsfs|overlay|proc|pstore|rpc_pipefs|securityfs|squashfs|sysfs|tracefs)$", "--collector.filesystem.mount-points-exclude=^/(dev|proc|sys|run/docker/netns)($|/)", "--collector.netdev.device-exclude=^(veth.*|br-.*|docker.*|lo)$"];
  const hash = createHash("sha256").update(JSON.stringify(args)).digest("hex");
  const current = ownedContainer();
  if (current?.Config?.Labels?.[`${OWNER}.hash`] !== hash) {
    if (!run("docker", ["pull", IMAGE], 180_000).ok) fail("Could not obtain the pinned Host exporter image.");
    if (current && !run("docker", ["rm", "-f", NAME]).ok) fail("Could not replace the Host exporter.");
    if (!run("docker", ["run", "-d", "--name", NAME, "--restart", "unless-stopped", "--label", `${OWNER}=true`, "--label", `${OWNER}.hash=${hash}`, ...args]).ok) fail("Could not start the Host exporter.");
  } else if (!current?.State?.Running && !run("docker", ["start", NAME]).ok) fail("Could not restart the Host exporter.");
  let caddyMetricsServer: string | undefined;
  try { caddyMetricsServer = await configureCaddy(root, address, true); }
  catch (e) { if (!current) run("docker", ["rm", "-f", NAME]); throw e; }
  await configureBootOrder(root);
  const psi = await access("/proc/pressure/cpu").then(()=>true,()=>false);
  const state = { host, address, enabled: true, psi, caddyMetricsServer };
  await publish(path.join(root, "telemetry", "resources.json"), JSON.stringify(state));
  return state;
}

export function hostScrapeConfig(state: HostMetrics) {
  if (!state.enabled) return "";
  return `  prometheus/host:\n    config:\n      scrape_configs:\n${[ ["node",9100], ["caddy",20190] ].map(([source,port])=>`        - job_name: sporades-host-${source}\n          scrape_interval: 15s\n          scrape_timeout: 5s\n          sample_limit: 10000\n          static_configs:\n            - targets: [${JSON.stringify(`${state.address}:${port}`)}]\n              labels:\n                sporades_host: ${JSON.stringify(state.host)}\n                telemetry_source: ${source}\n          metric_relabel_configs:\n${source === "caddy" && state.caddyMetricsServer ? `            - source_labels: [server]\n              regex: ${JSON.stringify(state.caddyMetricsServer)}\n              action: drop\n` : ""}            - action: labeldrop\n              regex: "host|url|url_path"\n`).join("")}`;
}

export async function hostMetricsStatus(root: string) {
  const state = await readHostMetrics(root);
  if (!state) return { configured: false, enabled: false, backendVerification: "unavailable" };
  const node = ownedContainer();
  return { configured: true, enabled: state.enabled, host: state.host, exporterRunning: Boolean(node?.State?.Running), psi: state.psi ? "supported" : "unsupported", backendVerification: "unavailable" };
}
