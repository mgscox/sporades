import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { helperError } from "./cli-support.js";
// This service runs once after Docker/Caddy startup. Docker alone owns crash retries.
export async function installHostAutostart(host) {
    const probe = spawnSync("systemctl", ["show", "docker.service", "--property=LoadState", "--value"], { encoding: "utf8", timeout: 10_000 });
    if (probe.status !== 0 || probe.stdout.trim() !== "loaded")
        return { installed: false, reason: "systemd-docker-unavailable" };
    const unit = `sporades-capsules-${createHash("sha256").update(`${host.remoteRoot}\0${host.domain}`).digest("hex").slice(0, 16)}.service`;
    const shutdownUnit = unit.replace(/\.service$/, "-shutdown.service");
    const file = path.join("/etc/systemd/system", unit);
    const shutdownFile = path.join("/etc/systemd/system", shutdownUnit);
    const marker = "# Managed by Sporades Host bootstrap: Capsule boot recovery\n";
    const helper = path.join(host.remoteRoot, "bin", "sporades-host-helper");
    const encoded = Buffer.from(JSON.stringify({ alias: host.alias, domain: host.domain, scheme: host.scheme ?? "https", remoteRoot: host.remoteRoot })).toString("base64url");
    const quotedHelper = JSON.stringify(helper).replace(/%/g, "%%").replace(/\$/g, () => "$$");
    const content = `${marker}[Unit]\nDescription=Sporades Capsule boot recovery (${host.domain})\nWants=network-online.target\nAfter=network-online.target docker.service caddy.service\nRequires=docker.service caddy.service\nPartOf=docker.service\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=${quotedHelper} --resume-host ${encoded}\nTimeoutStartSec=0\nRestart=no\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`;
    const shutdownContent = `${marker}[Unit]\nDescription=Sporades Capsule shutdown evidence (${host.domain})\nAfter=docker.service caddy.service\nRequires=docker.service caddy.service\nPartOf=docker.service\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/bin/true\nExecStop=${quotedHelper} --checkpoint-host ${encoded}\nTimeoutStopSec=120\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target docker.service\n`;
    for (const target of ["/etc/systemd/system", helper, file, shutdownFile]) {
        try {
            const s = await lstat(target);
            if (s.isSymbolicLink() || (s.mode & 0o022) || s.uid !== 0)
                throw new Error("unsafe");
        }
        catch (e) {
            if ((target === file || target === shutdownFile) && e.code === "ENOENT")
                continue;
            throw helperError("Unsafe Host autostart installation path.", "Repair root ownership and permissions before bootstrapping the Host.");
        }
    }
    let changed = false;
    for (const [target, contents] of [[file, content], [shutdownFile, shutdownContent]]) {
        const before = await readFile(target, "utf8").catch(e => { if (e.code === "ENOENT")
            return null; throw e; });
        if (before && !before.startsWith(marker))
            throw helperError("Host autostart service is operator-owned.", "Resolve the service name conflict before bootstrap.");
        if (before !== contents) {
            const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
            await writeFile(temporary, contents, { mode: 0o644, flag: "wx" });
            try {
                await rename(temporary, target);
            }
            finally {
                await rm(temporary, { force: true });
            }
            changed = true;
        }
    }
    if (changed && spawnSync("systemctl", ["daemon-reload"], { timeout: 30_000 }).status !== 0)
        throw helperError("Cannot reload Host autostart service.", "Inspect systemd and retry bootstrap.");
    if (spawnSync("systemctl", ["enable", unit, shutdownUnit], { timeout: 30_000 }).status !== 0)
        throw helperError("Cannot enable Host autostart service.", "Inspect systemd and retry bootstrap.");
    // Activate only the inert shutdown observer. Starting the recovery service during bootstrap
    // would resume existing Capsules; this service's ExecStart deliberately changes no runtime.
    if (spawnSync("systemctl", ["start", shutdownUnit], { timeout: 30_000 }).status !== 0)
        throw helperError("Cannot activate Host shutdown evidence.", "Inspect systemd and retry bootstrap.");
    return { installed: true, unit, shutdownUnit, startsExistingCapsules: false };
}
//# sourceMappingURL=host-autostart.js.map