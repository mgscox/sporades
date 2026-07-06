import type { HostHelperRelease } from "./host-helper-contract.js";

export function expectedReleaseFiles(release: HostHelperRelease) {
  const files = ["server.mjs", "client.js", "index.html", "sporades.json"];
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
  return [
    "server.mjs",
    "client.js",
    "index.html",
    "sporades.json",
    ".env.sporades.server",
    ".sporades/sealed-server-env/server-env.sealed.json",
    ".sporades/ssh/authorized_keys",
  ].includes(file as string);
}
