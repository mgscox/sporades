#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generateChanges } from "../skills/generate-changes/scripts/generate-changes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseTypes = new Set(["major", "minor", "patch"]);

export function parsePackageArgs(args) {
  const selected = [];

  for (const arg of args) {
    if (arg === "--major") {
      selected.push("major");
      continue;
    }
    if (arg === "--minor") {
      selected.push("minor");
      continue;
    }
    if (arg === "--patch") {
      selected.push("patch");
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true, releaseType: "minor" };
    }

    throw new Error(`Unknown packaging option: ${arg}`);
  }

  const unique = [...new Set(selected)];
  if (unique.length > 1) {
    throw new Error("Choose exactly one version bump: --major, --minor, or --patch.");
  }

  return { help: false, releaseType: unique[0] ?? "minor" };
}

export function usage() {
  return `Usage: npm run package -- [--major | --minor | --patch]

Builds API docs, bumps package semver, creates an npm tarball, and publishes it.
Updates CHANGES.md from Git history before the version bump.
Creates an annotated vX.Y.Z Git tag after npm publish succeeds.
Default bump: --minor`;
}

export function bumpVersion(version, releaseType) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Cannot bump non-semver package version: ${version}`);
  }

  const [, major, minor, patch] = match.map(Number);
  if (releaseType === "major") {
    return `${major + 1}.0.0`;
  }
  if (releaseType === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  if (releaseType === "patch") {
    return `${major}.${minor}.${patch + 1}`;
  }
  throw new Error(`Unsupported release type: ${releaseType}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: options.captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
    });

    let stdout = "";
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function parsePackedTarball(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("npm pack did not report a tarball filename.");
  }

  const packed = JSON.parse(trimmed);
  const filename = packed?.[0]?.filename;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("npm pack output did not include a tarball filename.");
  }
  return filename;
}

export function releaseTagForVersion(version) {
  if (!/^(\d+)\.(\d+)\.(\d+)$/.test(version)) {
    throw new Error(`Cannot create release tag for non-semver package version: ${version}`);
  }

  return `v${version}`;
}

async function updatePackageVersion(releaseType) {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageLockPath = path.join(repoRoot, "package-lock.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const nextVersion = bumpVersion(packageJson.version, releaseType);

  packageJson.version = nextVersion;
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const packageLock = JSON.parse(await readFile(packageLockPath, "utf8"));
  packageLock.version = nextVersion;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = nextVersion;
  }
  await writeFile(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);

  return nextVersion;
}

export async function packageForNpm(args = process.argv.slice(2)) {
  const options = parsePackageArgs(args);
  if (options.help) {
    console.log(usage());
    return;
  }

  if (!releaseTypes.has(options.releaseType)) {
    throw new Error(`Unsupported release type: ${options.releaseType}`);
  }

  console.log(`Packaging sporades with a ${options.releaseType} version bump...`);
  await run("npm", ["run", "docs:api"]);
  await generateChanges();
  console.log("Updated CHANGES.md.");
  const nextVersion = await updatePackageVersion(options.releaseType);
  console.log(`Version bumped to ${nextVersion}.`);
  const packOutput = await run("npm", ["pack", "--json"], { captureStdout: true });
  const tarball = parsePackedTarball(packOutput);
  await run("npm", ["publish", tarball]);
  const releaseTag = releaseTagForVersion(nextVersion);
  await run("git", ["tag", "--annotate", releaseTag, "--message", `Release ${releaseTag}`]);
  console.log(`Published ${tarball}.`);
  console.log(`Created release tag ${releaseTag}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  packageForNpm().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
