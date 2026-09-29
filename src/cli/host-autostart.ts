import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { helperError } from "./cli-support.js";
import type { HostHelperHost } from "./hosted-capsule-contract.js";

// This service runs once after Docker/Caddy startup. Docker alone owns crash retries.
export async function installHostAutostart(host: HostHelperHost) {
  const probe = spawnSync("systemctl", ["show", "docker.service", "--property=LoadState", "--value"], { encoding: "utf8", timeout: 10_000 });
  if (probe.status !== 0 || probe.stdout.trim() !== "loaded") return { installed: false, reason: "systemd-docker-unavailable" };
  const unit = `sporades-capsules-${createHash("sha256").update(`${host.remoteRoot}\0${host.domain}`).digest("hex").slice(0,16)}.service`;
  const file = path.join("/etc/systemd/system", unit);
  const marker = "# Managed by Sporades Host bootstrap: Capsule boot recovery\n";
  const helper = path.join(host.remoteRoot, "bin", "sporades-host-helper");
  const encoded = Buffer.from(JSON.stringify({ alias: host.alias, domain: host.domain, scheme: host.scheme ?? "https", remoteRoot: host.remoteRoot })).toString("base64url");
  const quotedHelper = JSON.stringify(helper).replace(/%/g, "%%").replace(/\$/g, () => "$$");
  const content = `${marker}[Unit]\nDescription=Sporades Capsule boot recovery (${host.domain})\nWants=network-online.target\nAfter=network-online.target docker.service caddy.service\nRequires=docker.service caddy.service\nPartOf=docker.service\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=${quotedHelper} --resume-host ${encoded}\nTimeoutStartSec=0\nRestart=no\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`;
  for (const target of ["/etc/systemd/system", helper, file]) {
    try {
      const s = await lstat(target);
      if (s.isSymbolicLink() || (s.mode & 0o022) || s.uid !== 0) throw new Error("unsafe");
    } catch (e) {
      if (target === file && (e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw helperError("Unsafe Host autostart installation path.", "Repair root ownership and permissions before bootstrapping the Host.");
    }
  }
  const before = await readFile(file, "utf8").catch(e => { if (e.code === "ENOENT") return null; throw e; });
  if (before && !before.startsWith(marker)) throw helperError("Host autostart service is operator-owned.", "Resolve the service name conflict before bootstrap.");
  if (before !== content) {
    const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, content, { mode: 0o644, flag: "wx" });
    try { await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
    if (spawnSync("systemctl", ["daemon-reload"], { timeout: 30_000 }).status !== 0) throw helperError("Cannot reload Host autostart service.", "Inspect systemd and retry bootstrap.");
  }
  if (spawnSync("systemctl", ["enable", unit], { timeout: 30_000 }).status !== 0) throw helperError("Cannot enable Host autostart service.", "Inspect systemd and retry bootstrap.");
  return { installed: true, unit, startsExistingCapsules: false };
}
