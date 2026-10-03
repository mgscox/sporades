import { spawn } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

async function protectedPath(file: string, isDirectory = false) {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077) || (process.geteuid && stat.uid !== process.geteuid())) throw new Error("Unprotected Host inventory state.");
}
// OS-owned lock releases on exit/crash. Neither a stale mkdir lock nor an HTTP
// request can obstruct Capsule lifecycle locks. The sender releases it before HTTPS.
export async function withHostTelemetryLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const dir = path.join(root, "telemetry");
  if (!path.isAbsolute(root) || root === "/" || path.normalize(root) !== root) throw new Error("Invalid Host inventory root.");
  await protectedPath(dir, true);
  const file = path.join(dir, "inventory.lock");
  const handle = await open(file, "a", 0o600); await handle.close();
  await protectedPath(file);
  const child = spawn(process.env.SPORADES_TEST_FLOCK_PATH || "/usr/bin/flock", ["--exclusive", "--timeout", "2", "--conflict-exit-code", "75", "--no-fork", file, process.execPath, "-e", "process.stdout.write('locked');process.stdin.resume();"], { stdio: ["pipe", "pipe", "ignore"] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Inventory lock unavailable.")));
      child.stdout.once("data", () => resolve());
    });
    return await operation();
  } finally { child.stdin.end(); }
}
