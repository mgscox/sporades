#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, rename, rm, symlink } from "node:fs/promises";
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
  await mkdir(release.directories.releases, { recursive: true });
  await mkdir(release.directories.data, { recursive: true });

  const tempReleaseDirectory = `${release.directories.release}.tmp-${process.pid}`;
  const tempCurrentLink = `${release.currentLink}.tmp-${process.pid}`;
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
    await rename(tempReleaseDirectory, release.directories.release);
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

  await symlink(release.directories.release, tempCurrentLink);
  await rename(tempCurrentLink, release.currentLink);

  writeEnvelope({
    ok: true,
    data: {
      installed: true,
      restarted: Boolean(release.restart),
      capsule: {
        subname: request.capsule.subname,
        domain: request.host.domain,
        hostedUrl: release.hostedUrl,
      },
      release: {
        id: release.id,
        directory: release.directories.release,
        currentLink: release.currentLink,
        files: release.files,
        serverEnvIncluded: Boolean(release.serverEnvIncluded),
      },
    },
    error: null,
  });
}

function validateInstallRequest(request) {
  const release = request.release;
  const requiredStrings = [
    request.host?.domain,
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
