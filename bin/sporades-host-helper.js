#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";

main().catch((error) => {
  writeEnvelope(
    {
      ok: false,
      data: null,
      error: {
        message: error.message,
        hint: error.hint ?? "Check the Host helper request and retry the command.",
      },
    },
    false,
  );
});

async function main() {
  const request = JSON.parse(await readStdin());
  if (request.action === "capsule.release.install") {
    await installRelease(request);
    return;
  }

  throw helperError("Unsupported Host helper action.", "Update the Host helper or use a supported Sporades host command.");
}

async function installRelease(request) {
  const release = request.release;
  validateInstallRequest(request);
  await verifyRegisteredCapsule(request);
  validateReleaseArchive(request);
  const paths = canonicalReleasePaths(request);
  await mkdir(paths.releases, { recursive: true });
  await mkdir(paths.data, { recursive: true });

  const tempReleaseDirectory = `${paths.release}.tmp-${process.pid}`;
  const tempCurrentLink = `${paths.currentLink}.tmp-${process.pid}`;
  await rm(tempReleaseDirectory, { recursive: true, force: true });
  await rm(tempCurrentLink, { force: true });
  await mkdir(tempReleaseDirectory, { recursive: true });

  const extract = spawnSync("tar", ["-xzf", release.remoteArchive, "-C", tempReleaseDirectory], {
    encoding: "utf8",
  });
  if (extract.error || extract.status !== 0) {
    await rm(tempReleaseDirectory, { recursive: true, force: true });
    throw helperError(
      "Failed to extract Hosted Capsule release archive.",
      "Upload the release again with `sporades host push` and check that tar is installed on the Host server.",
    );
  }

  try {
    await rename(tempReleaseDirectory, paths.release);
  } catch (error) {
    await rm(tempReleaseDirectory, { recursive: true, force: true });
    if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") {
      throw helperError(
        "Hosted Capsule release already exists.",
        "Push again to generate a fresh immutable release ID.",
      );
    }
    throw error;
  }

  await symlink(paths.release, tempCurrentLink);
  await rename(tempCurrentLink, paths.currentLink);

  writeEnvelope({
    ok: true,
    data: {
      installed: true,
      restartRequested: Boolean(release.restart),
      restarted: false,
      capsule: {
        subname: request.capsule.subname,
        domain: request.host.domain,
        hostedUrl: release.hostedUrl,
      },
      release: {
        id: release.id,
        directory: paths.release,
        currentLink: paths.currentLink,
        files: release.files,
        serverEnvIncluded: Boolean(release.serverEnvIncluded),
      },
    },
    error: null,
  });
}

function canonicalReleasePaths(request) {
  const capsule = path.join(
    request.host.remoteRoot,
    "hosts",
    request.host.domain,
    "capsules",
    request.capsule.subname,
  );
  const releases = path.join(capsule, "releases");
  return {
    capsule,
    releases,
    release: path.join(releases, request.release.id),
    data: path.join(capsule, "data"),
    currentLink: path.join(capsule, "current"),
  };
}

function validateReleaseArchive(request) {
  const release = request.release;
  const entries = listArchiveEntries(release.remoteArchive);
  const expectedFiles = expectedReleaseFiles(release);
  const actualNames = entries.map((entry) => normaliseArchiveEntryName(entry.name));

  if (entries.some((entry) => entry.type !== "-")) {
    throw helperError(
      "Hosted Capsule release archive contains unsafe entries.",
      "Push again so Sporades can package regular runtime files only.",
    );
  }
  if (actualNames.some((name) => !isSafeArchiveEntryName(name))) {
    throw helperError(
      "Hosted Capsule release archive contains unsafe paths.",
      "Push again so Sporades can package runtime files without absolute or parent-relative paths.",
    );
  }

  const actual = [...actualNames].sort();
  const expected = [...expectedFiles].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw helperError(
      "Hosted Capsule release archive contains unexpected files.",
      "Push again so Sporades can package only runtime files.",
    );
  }
}

function listArchiveEntries(archivePath) {
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
  }));
}

function expectedReleaseFiles(release) {
  return release.serverEnvIncluded
    ? ["server.mjs", "client.js", "index.html", "sporades.json", ".env.sporades.server"]
    : ["server.mjs", "client.js", "index.html", "sporades.json"];
}

function normaliseArchiveEntryName(name) {
  return String(name).replace(/^\.\//, "");
}

function isSafeArchiveEntryName(name) {
  if (!name || name.startsWith("/") || name.includes("\0")) {
    return false;
  }
  return name.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

async function verifyRegisteredCapsule(request) {
  const registryRecordPath = path.join(
    request.host.remoteRoot,
    "hosts",
    request.host.domain,
    "registry",
    "capsules",
    `${request.capsule.subname}.json`,
  );
  let record;
  try {
    record = JSON.parse(await readFile(registryRecordPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw helperError(
        "Hosted Capsule is not registered.",
        `Run \`sporades host register ${request.capsule.subname} --host ${request.host.alias}\` before pushing a release.`,
      );
    }
    if (error instanceof SyntaxError) {
      throw helperError(
        "Hosted Capsule registry record is invalid.",
        "Repair the Host server registry record before pushing a release.",
      );
    }
    throw error;
  }

  const expectedRemoteCapsuleId = `${request.host.domain}/${request.capsule.subname}`;
  const matches =
    record?.subname === request.capsule.subname &&
    record?.domain === request.host.domain &&
    (record?.remoteCapsuleId ?? expectedRemoteCapsuleId) === expectedRemoteCapsuleId;
  if (!matches) {
    throw helperError(
      "Hosted Capsule registry record does not match the release request.",
      "Rebind the local project or pass the correct Host profile and Capsule subname.",
    );
  }
}

function validateInstallRequest(request) {
  const release = request.release;
  const requiredStrings = [
    request.host?.domain,
    request.host?.alias,
    request.host?.remoteRoot,
    request.capsule?.subname,
    release?.id,
    release?.remoteArchive,
    release?.hostedUrl,
    release?.directories?.releases,
    release?.directories?.release,
    release?.directories?.data,
    release?.currentLink,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw helperError("Invalid release install request.", "Update the Sporades CLI and retry `sporades host push`.");
  }
  if (!/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(release.id)) {
    throw helperError("Invalid Hosted Capsule release ID.", "Push again to generate a fresh UTC-sortable release ID.");
  }
  if (!Array.isArray(release.files) || release.files.some((file) => typeof file !== "string" || file.includes("/") || file === "..")) {
    throw helperError("Invalid Hosted Capsule release file list.", "Update the Sporades CLI and retry `sporades host push`.");
  }
  const expectedFiles = expectedReleaseFiles(release);
  const claimedFiles = [...release.files].sort();
  const sortedExpectedFiles = [...expectedFiles].sort();
  if (claimedFiles.length !== sortedExpectedFiles.length || claimedFiles.some((file, index) => file !== sortedExpectedFiles[index])) {
    throw helperError("Invalid Hosted Capsule release file list.", "Update the Sporades CLI and retry `sporades host push`.");
  }
  const expectedReleaseDirectory = path.join(release.directories.releases, release.id);
  if (path.resolve(release.directories.release) !== path.resolve(expectedReleaseDirectory)) {
    throw helperError("Invalid Hosted Capsule release directory.", "Update the Sporades CLI and retry `sporades host push`.");
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let stdin = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      stdin += chunk;
    });
    process.stdin.on("end", () => resolve(stdin));
    process.stdin.on("error", reject);
  });
}

function helperError(message, hint) {
  const error = new Error(message);
  error.hint = hint;
  return error;
}

function writeEnvelope(result, failed = false) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (failed) {
    process.exitCode = 1;
  }
}
