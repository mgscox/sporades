import type { HostHelperRelease } from "./host-helper-contract.js";

export function expectedReleaseFiles(release: HostHelperRelease) {
  const publicFiles = Array.isArray(release.files)
    ? release.files.filter((file): file is string => typeof file === "string" && file.startsWith("public/"))
    : [];
  const legacyFiles = publicFiles.length === 0 ? ["client.js", "index.html"] : [];
  const files = ["server.mjs", "sporades.json", ...legacyFiles, ...publicFiles];
  if (release.serverEnvIncluded) {
    files.push(".env.sporades.server");
  }
  if (release.sealedServerEnvIncluded) {
    files.push(".sporades/sealed-server-env/server-env.sealed.json");
  }
  if (release.ssh?.enabled) {
    files.push(".sporades/ssh/authorized_keys");
  }
  return files;
}

export function isExpectedClaimedReleaseFile(file: unknown) {
  return typeof file === "string" && (file.startsWith("public/") || [
    "server.mjs",
    "client.js",
    "index.html",
    "sporades.json",
    ".env.sporades.server",
    ".sporades/sealed-server-env/server-env.sealed.json",
    ".sporades/ssh/authorized_keys",
  ].includes(file));
}
