import { spawnSync } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { helperError } from "./cli-support.js";
import { expectedReleaseFiles } from "./host-helper-release-files.js";
export function validateReleaseArchive(request) {
    const release = request.release;
    const entries = listArchiveEntries(release.remoteArchive);
    const expectedFiles = expectedReleaseFiles(release);
    const allNames = entries.map((entry) => normaliseArchiveEntryName(entry.name));
    const runtimeEntries = entries.filter((entry) => !isDiscardableArchiveMetadata(entry.name));
    const actualNames = runtimeEntries.map((entry) => normaliseArchiveEntryName(entry.name));
    if (entries.some((entry) => !isSafeArchiveEntryType(entry))) {
        throw helperError("Hosted Capsule release archive contains unsafe entries.", "Push again so Sporades can package regular runtime files only.");
    }
    if (allNames.some((name) => !isSafeArchiveEntryName(name))) {
        throw helperError("Hosted Capsule release archive contains unsafe paths.", "Push again so Sporades can package runtime files without absolute or parent-relative paths.");
    }
    const actual = [...actualNames].sort();
    const expected = [...expectedFiles].sort();
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
        throw helperError("Hosted Capsule release archive contains unexpected files.", "Push again so Sporades can package only runtime files.");
    }
}
export async function removeDiscardedArchiveMetadata(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.name === "__MACOSX" || entry.name.startsWith("._")) {
            await rm(entryPath, { recursive: entry.isDirectory(), force: true });
            continue;
        }
        if (entry.isDirectory()) {
            await removeDiscardedArchiveMetadata(entryPath);
        }
    }
}
function listArchiveEntries(archivePath) {
    const namesResult = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
    const verboseResult = spawnSync("tar", ["-tvzf", archivePath], { encoding: "utf8" });
    if (namesResult.error || namesResult.status !== 0 || verboseResult.error || verboseResult.status !== 0) {
        throw helperError("Failed to inspect Hosted Capsule release archive.", "Upload the release again with `sporades host push` and check that tar is installed on the Host server.");
    }
    const names = namesResult.stdout.trim().split("\n").filter(Boolean);
    const verboseLines = verboseResult.stdout.trim().split("\n").filter(Boolean);
    if (names.length !== verboseLines.length) {
        throw helperError("Hosted Capsule release archive could not be validated.", "Push again so Sporades can package a clean runtime archive.");
    }
    return names.map((name, index) => ({
        name,
        type: verboseLines[index]?.[0],
    }));
}
function normaliseArchiveEntryName(name) {
    return String(name).replace(/^\.\//, "").replace(/\/+$/, "");
}
function isDiscardableArchiveMetadata(name) {
    const normalisedName = normaliseArchiveEntryName(name);
    return (normalisedName === "__MACOSX" ||
        normalisedName.startsWith("__MACOSX/") ||
        normalisedName.split("/").some((segment) => segment.startsWith("._")));
}
function isSafeArchiveEntryType(entry) {
    if (entry.type === "-") {
        return true;
    }
    return entry.type === "d" && isDiscardableArchiveMetadata(entry.name);
}
function isSafeArchiveEntryName(name) {
    if (!name || name.startsWith("/") || name.includes("\0")) {
        return false;
    }
    return name.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}
//# sourceMappingURL=host-helper-archive.js.map