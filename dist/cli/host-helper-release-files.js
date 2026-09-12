import { resolveDeployFiles } from "../deploy-files.js";
export function expectedReleaseFiles(release) {
    const publicFiles = Array.isArray(release.files)
        ? release.files.filter((file) => typeof file === "string" && file.startsWith("public/"))
        : [];
    const files = ["server.mjs", "sporades.json", ...publicFiles, ...resolveDeployFiles(release.deployFiles).map((file) => file.path)];
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
export function isExpectedClaimedReleaseFile(file, deployFiles = []) {
    return typeof file === "string" && (file.startsWith("public/") || deployFiles.includes(file) || [
        "server.mjs",
        "sporades.json",
        ".env.sporades.server",
        ".sporades/sealed-server-env/server-env.sealed.json",
        ".sporades/ssh/authorized_keys",
    ].includes(file));
}
//# sourceMappingURL=host-helper-release-files.js.map