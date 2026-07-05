export function expectedReleaseFiles(release) {
    const files = ["server.mjs", "client.js", "index.html", "sporades.json"];
    if (release.serverEnvIncluded) {
        files.push(".env.sporades.server");
    }
    if (release.sealedServerEnvIncluded) {
        files.push(".sporades/sealed-server-env/server-env.sealed.json");
    }
    return files;
}
export function isExpectedClaimedReleaseFile(file) {
    return [
        "server.mjs",
        "client.js",
        "index.html",
        "sporades.json",
        ".env.sporades.server",
        ".sporades/sealed-server-env/server-env.sealed.json",
    ].includes(file);
}
//# sourceMappingURL=host-helper-release-files.js.map