import path from "node:path";
export function redactBuildProjectRoots(message, projectRoots) {
    const absoluteRoots = new Set();
    const relativeRoots = new Set();
    for (const projectRoot of projectRoots) {
        const resolved = path.resolve(projectRoot);
        for (const root of [resolved, path.isAbsolute(projectRoot) ? projectRoot : ""]) {
            if (!root)
                continue;
            for (const normalizedRoot of diagnosticNormalizationForms(root)) {
                absoluteRoots.add(normalizedRoot);
                absoluteRoots.add(normalizedRoot.replaceAll("\\", "/"));
                absoluteRoots.add(normalizedRoot.replaceAll("/", "\\"));
            }
        }
        const relative = path.relative(process.cwd(), resolved);
        if (!relative || relative === ".")
            continue;
        for (const normalizedRoot of diagnosticNormalizationForms(relative)) {
            for (const root of [normalizedRoot, normalizedRoot.replaceAll("\\", "/"), normalizedRoot.replaceAll("/", "\\")]) {
                relativeRoots.add(root);
                relativeRoots.add(`./${root}`);
                relativeRoots.add(`.\\${root}`);
            }
        }
    }
    let redacted = message;
    for (const root of [...absoluteRoots].filter(Boolean).sort((left, right) => right.length - left.length)) {
        redacted = redacted.split(root).join("<project>");
    }
    for (const root of [...relativeRoots].filter(Boolean).sort((left, right) => right.length - left.length)) {
        const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        redacted = redacted.replace(new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}\\p{Pc}.\\/\\\\-])${escaped}(?=[/\\\\])`, "gu"), "$1<project>");
    }
    return redacted;
}
export function canonicalBuildDiagnosticRoots(projectRoots) {
    return [...new Set(projectRoots.flatMap((projectRoot) => {
            const resolved = path.resolve(projectRoot);
            const relative = path.relative(process.cwd(), resolved);
            return [projectRoot, resolved, relative, relative.split(path.sep).join("/")];
        }).filter(Boolean))].sort((left, right) => right.length - left.length);
}
function diagnosticNormalizationForms(value) {
    return [...new Set([value, value.normalize("NFC"), value.normalize("NFD")])];
}
//# sourceMappingURL=build-diagnostics.js.map