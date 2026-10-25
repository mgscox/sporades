import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
// The immutable Node image already pinned by Dockerfile.base. Never execute a
// companion's image as the reset helper, or mount the credentials/state parent.
export const SERVICE_STATE_CLEANUP_IMAGE = "node:24.22.1-alpine3.23@sha256:0468540aa58203ff9e40c2aab3907c52644ab818af6176b1c70a026137dc92a2";
const cleanupSource = 'const fs=require("node:fs");for(const name of fs.readdirSync("/state"))fs.rmSync("/state/"+name,{recursive:true,force:true});';
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const mountField = (value) => /[,"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const code = (error) => error?.code;
/** Remove only one service's state, after the lifecycle fence revokes secrets. */
export async function removeCapsuleServiceState(projectDir, name) {
    const root = path.resolve(projectDir, ".sporades", "services");
    const state = path.join(root, name);
    const helperName = `sporades-state-reset-${randomBytes(16).toString("hex")}`;
    const args = ["run", "--rm", "--name", helperName, "--user", "0:0", "--network", "none", "--read-only",
        "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--security-opt", "no-new-privileges:true",
        "--pids-limit", "32", "--memory", "128m", "--cpus", "1",
        "--mount", `type=bind,${mountField(`source=${state}`)},target=/state,bind-recursive=disabled`,
        "--entrypoint", "node", SERVICE_STATE_CLEANUP_IMAGE, "-e", cleanupSource];
    let owner;
    let safe = false;
    const failure = () => Object.assign(new Error("Capsule service reset incomplete."), {
        hint: safe
            ? `Generated service secrets were revoked. Cannot remove ${JSON.stringify(state)}${owner === undefined ? "" : ` (owner UID ${owner})`}. Stop the service, restore Docker access and retry reset. Recovery command: ${["docker", ...args].map(quote).join(" ")}; then retry \`sporades dev reset\` or \`sporades deploy reset\`.`
            : `Generated service secrets were revoked. Refusing unsafe or changed state path ${JSON.stringify(state)}. Restore the original real state directory and its protected parents, then retry \`sporades dev reset\` or \`sporades deploy reset\`; no cleanup bind mount is permitted for this path.`,
    });
    try {
        if (!/^[a-z][a-z0-9-]{0,30}$/.test(name))
            throw failure();
        for (const parent of [path.dirname(root), root]) {
            const stat = await lstat(parent);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw failure();
        }
        const before = await lstat(state);
        owner = before.uid;
        // A stale symlink is an entry to unlink, never a Docker bind source.
        if (!before.isDirectory() || before.isSymbolicLink()) {
            await rm(state, { force: true });
            return;
        }
        safe = true;
        const checkIdentity = async () => {
            for (const parent of [path.dirname(root), root]) {
                const stat = await lstat(parent);
                if (!stat.isDirectory() || stat.isSymbolicLink()) {
                    safe = false;
                    throw failure();
                }
            }
            const current = await lstat(state);
            if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) {
                safe = false;
                throw failure();
            }
        };
        const uid = process.getuid?.();
        let remaining = 100000;
        const hostOwned = async (file, depth = 0) => {
            if (uid === undefined || --remaining < 0 || depth > 64)
                return false;
            const stat = await lstat(file);
            if (stat.uid !== uid) {
                owner = stat.uid;
                return false;
            }
            if (!stat.isDirectory() || stat.isSymbolicLink())
                return true;
            for (const entry of await readdir(file))
                if (!await hostOwned(path.join(file, entry), depth + 1))
                    return false;
            return true;
        };
        let owned = false;
        try {
            owned = await hostOwned(state);
        }
        catch { /* An unreadable tree cannot be attested as host-owned. */ }
        if (owned) {
            await checkIdentity();
            try {
                await rm(state, { recursive: true, force: true });
                return;
            }
            catch { /* Host-owned but unwritable descendants still need confined Docker cleanup. */ }
        }
        await checkIdentity();
        const result = spawnSync("docker", args, { cwd: projectDir, encoding: "utf8", maxBuffer: 65536, timeout: 60000 });
        if (result.status !== 0) {
            // A timed-out Docker client must not leave its uniquely owned helper alive.
            spawnSync("docker", ["rm", "--force", helperName], { cwd: projectDir, stdio: "ignore", timeout: 10000 });
            throw failure();
        }
        await checkIdentity();
        // Only unlink an empty directory entry. Never recursively fall back to the
        // host after a helper claims success; it may have left foreign-owned state.
        await rmdir(state);
    }
    catch (error) {
        if (code(error) === "ENOENT")
            return;
        throw failure();
    }
}
//# sourceMappingURL=container-service-reset.js.map