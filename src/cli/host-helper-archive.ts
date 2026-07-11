import { spawnSync } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import { PUBLIC_TREE_LIMITS } from "../public-tree.js";
import { helperError } from "./cli-support.js";
import type { HostHelperRelease, HostHelperRequest as HostHelperContractRequest, HostHelperCapsuleTarget } from "./host-helper-contract.js";
import { expectedReleaseFiles } from "./host-helper-release-files.js";

type HostHelperRequest = HostHelperContractRequest & {
  capsule: HostHelperCapsuleTarget;
  release: HostHelperRelease;
};

export function validateReleaseArchive(request: HostHelperRequest) {
  const release = request.release;
  const entries = listArchiveEntries(release.remoteArchive);
  const expectedFiles = expectedReleaseFiles(release);
  const allNames = entries.map((entry) => normaliseArchiveEntryName(entry.name));
  const runtimeEntries = entries.filter((entry) => !isDiscardableArchiveMetadata(entry.name));
  if (entries.some((entry) => !isSafeArchiveEntryType(entry, expectedFiles))) {
    throw helperError(
      "Hosted Capsule release archive contains unsafe entries.",
      "Push again so Sporades can package regular runtime files only.",
    );
  }
  if (allNames.some((name) => !isSafeArchiveEntryName(name))) {
    throw helperError(
      "Hosted Capsule release archive contains unsafe paths.",
      "Push again so Sporades can package runtime files without absolute or parent-relative paths.",
    );
  }

  const canonicalNames = new Set<string>();
  for (const entry of runtimeEntries) {
    const name = normaliseArchiveEntryName(entry.name);
    const canonical = name.normalize("NFC");
    if (canonicalNames.has(canonical)) {
      throw helperError("Hosted Capsule release archive contains duplicate paths.", "Push again so every runtime path is unique after Unicode normalization.");
    }
    canonicalNames.add(canonical);
  }

  const unexpectedEntry = runtimeEntries.find((entry) => {
    const name = normaliseArchiveEntryName(entry.name);
    if (entry.type === "-") return !expectedFiles.includes(name);
    return !expectedFiles.some((file) => file.startsWith(`${name}/`));
  });
  if (unexpectedEntry) {
    throw helperError("Hosted Capsule release archive contains unexpected files.", "Push again so Sporades can package only runtime files.");
  }

  validatePublicArchiveBounds(runtimeEntries);

  const actual = runtimeEntries.filter((entry) => entry.type === "-").map((entry) => normaliseArchiveEntryName(entry.name)).sort();
  const expected = [...expectedFiles].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw helperError(
      "Hosted Capsule release archive contains unexpected files.",
      "Push again so Sporades can package only runtime files.",
    );
  }
}

export async function removeDiscardedArchiveMetadata(directory: string) {
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

function listArchiveEntries(archivePath: string) {
  const namesResult = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
  const verboseResult = spawnSync("tar", ["-tvzf", archivePath], { encoding: "utf8" });
  if (namesResult.error || namesResult.status !== 0 || verboseResult.error || verboseResult.status !== 0) {
    throw helperError(
      "Failed to inspect Hosted Capsule release archive.",
      "Upload the release again with `sporades host push` and check that tar is installed on the Host server.",
    );
  }

  const names = namesResult.stdout.trim().split("\n").filter(Boolean);
  const verboseLines = verboseResult.stdout.trim().split("\n").filter(Boolean);
  if (names.length !== verboseLines.length) {
    throw helperError(
      "Hosted Capsule release archive could not be validated.",
      "Push again so Sporades can package a clean runtime archive.",
    );
  }
  return names.map((name, index) => ({
    name,
    type: verboseLines[index]?.[0],
    size: archiveEntrySize(verboseLines[index] ?? ""),
  }));
}

function archiveEntrySize(line: string) {
  const bsd = line.match(/^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+/);
  const gnu = line.match(/^\S+\s+\S+\/\S+\s+(\d+)\s+/);
  return Number((bsd ?? gnu)?.[1] ?? NaN);
}

function normaliseArchiveEntryName(name: unknown) {
  return String(name).replace(/^\.\//, "").replace(/\/+$/, "");
}

function isDiscardableArchiveMetadata(name: unknown) {
  const normalisedName = normaliseArchiveEntryName(name);
  return (
    normalisedName === "__MACOSX" ||
    normalisedName.startsWith("__MACOSX/") ||
    normalisedName.split("/").some((segment) => segment.startsWith("._"))
  );
}

function isSafeArchiveEntryType(entry: { type?: string; name: string }, expectedFiles: string[]) {
  if (entry.type === "-") {
    return true;
  }
  if (entry.type !== "d") return false;
  const name = normaliseArchiveEntryName(entry.name);
  return isDiscardableArchiveMetadata(entry.name) || expectedFiles.some((file) => file.startsWith(`${name}/`));
}

function isSafeArchiveEntryName(name: string) {
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0") || /[\r\n]/.test(name)) {
    return false;
  }
  return name.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function validatePublicArchiveBounds(entries: Array<{ name: string; type?: string; size: number }>) {
  const files = entries.filter((entry) => entry.type === "-" && normaliseArchiveEntryName(entry.name).startsWith("public/"));
  if (files.length > PUBLIC_TREE_LIMITS.files) {
    throw helperError("Hosted Capsule public tree exceeds release bounds.", "Reduce the number of public files and push again.");
  }
  let totalBytes = 0;
  for (const entry of files) {
    const relative = normaliseArchiveEntryName(entry.name).slice("public/".length);
    if (Buffer.byteLength(relative, "utf8") > PUBLIC_TREE_LIMITS.pathBytes || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw helperError("Hosted Capsule public tree exceeds release bounds.", "Use bounded public paths and regular files, then push again.");
    }
    if (entry.size > PUBLIC_TREE_LIMITS.fileBytes) {
      throw helperError("Hosted Capsule public tree exceeds release bounds.", "Reduce oversized public files and push again.");
    }
    totalBytes += entry.size;
  }
  if (totalBytes > PUBLIC_TREE_LIMITS.totalBytes) {
    throw helperError("Hosted Capsule public tree exceeds release bounds.", "Reduce the total public output size and push again.");
  }
}
