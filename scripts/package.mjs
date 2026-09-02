#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generateChanges } from "../skills/generate-changes/scripts/generate-changes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseTypes = new Set(["major", "minor", "patch"]);

export function parsePackageArgs(args) {
  const selected = [];
  let resume = false;
  let recoveryBranch = "";
  let recoveryRemote = "";

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
    if (arg === "--resume") {
      resume = true;
      continue;
    }
    if (arg.startsWith("--branch=")) {
      recoveryBranch = arg.slice("--branch=".length).trim();
      if (!recoveryBranch) {
        throw new Error("--branch requires a branch name.");
      }
      continue;
    }
    if (arg.startsWith("--remote=")) {
      recoveryRemote = arg.slice("--remote=".length).trim();
      if (!recoveryRemote) {
        throw new Error("--remote requires a remote name.");
      }
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true, recoveryBranch: "", recoveryRemote: "", releaseType: "minor", resume: false };
    }

    throw new Error(`Unknown packaging option: ${arg}`);
  }

  const unique = [...new Set(selected)];
  if (unique.length > 1) {
    throw new Error("Choose exactly one version bump: --major, --minor, or --patch.");
  }
  if (resume && unique.length > 0) {
    throw new Error("--resume cannot be combined with a version bump.");
  }
  if (!resume && (recoveryBranch || recoveryRemote)) {
    throw new Error("--branch and --remote may only be used with --resume.");
  }

  return { help: false, recoveryBranch, recoveryRemote, releaseType: unique[0] ?? "minor", resume };
}

export function usage() {
  return `Usage: npm run package -- [--major | --minor | --patch]
       npm run package -- --resume [--branch=<name>] [--remote=<name>]

Builds API docs, bumps package semver, creates an npm tarball, and publishes it.
Updates CHANGES.md from Git history before the version bump.
Commits release metadata before packaging.
Atomically pushes the release commit and annotated vX.Y.Z tag before npm publish.
Requires the current branch to match its fetched upstream before publishing.
Recovery from detached HEAD requires --branch; --remote is needed only when the remote is ambiguous.
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

function compareVersions(left, right) {
  const leftMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(left);
  const rightMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(right);
  if (!leftMatch || !rightMatch) {
    throw new Error(`Cannot compare non-semver package versions: ${left} and ${right}`);
  }

  const leftParts = leftMatch.slice(1).map(Number);
  const rightParts = rightMatch.slice(1).map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function isNotFoundResult(result) {
  return result.code !== 0 && /\bE404\b|404 Not Found/i.test(`${result.stdout}\n${result.stderr}`);
}

export function nextReleaseVersion(packageVersion, releaseType, publishedResult) {
  let releaseBase = packageVersion;

  if (publishedResult.code === 0) {
    const publishedVersion = publishedResult.stdout.trim();
    if (!/^(\d+)\.(\d+)\.(\d+)$/.test(publishedVersion)) {
      throw new Error(`npm reported a non-semver package version: ${publishedVersion || "(empty)"}`);
    }
    if (compareVersions(publishedVersion, packageVersion) > 0) {
      releaseBase = publishedVersion;
    }
  } else if (!isNotFoundResult(publishedResult)) {
    throw new Error(`Could not determine the current published package version:\n${publishedResult.stderr.trim()}`);
  }

  return bumpVersion(releaseBase, releaseType);
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

function runResult(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

export function parsePackedArtifact(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("npm pack did not report a tarball filename.");
  }

  const packed = JSON.parse(trimmed);
  const packageEntries = Array.isArray(packed)
    ? packed
    : packed && typeof packed === "object"
      ? Object.values(packed)
      : [];
  const filename = packageEntries[0]?.filename;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("npm pack output did not include a tarball filename.");
  }
  return {
    filename,
    integrity: packageEntries[0]?.integrity ?? "",
    shasum: packageEntries[0]?.shasum ?? "",
  };
}

export function parsePackedTarball(stdout) {
  return parsePackedArtifact(stdout).filename;
}

export function releaseTagForVersion(version) {
  if (!/^(\d+)\.(\d+)\.(\d+)$/.test(version)) {
    throw new Error(`Cannot create release tag for non-semver package version: ${version}`);
  }

  return `v${version}`;
}

export function releaseCommitMessage(tag) {
  return `Release ${tag}`;
}

export function assertCleanWorkingTree(status) {
  if (status.trim()) {
    throw new Error(`Refusing to package with a dirty working tree:\n${status.trim()}`);
  }
}

export function assertSynchronizedUpstream(branch, upstream, divergence) {
  if (!branch) {
    throw new Error("Refusing to package from a detached HEAD.");
  }
  if (!upstream) {
    throw new Error(`Refusing to package branch ${branch} without a configured upstream.`);
  }

  const match = /^(\d+)\s+(\d+)$/.exec(divergence.trim());
  if (!match) {
    throw new Error(`Could not determine divergence between ${branch} and ${upstream}.`);
  }

  const [, ahead, behind] = match.map(Number);
  if (ahead !== 0 || behind !== 0) {
    throw new Error(
      `Refusing to package because ${branch} and ${upstream} have diverged ` +
        `(ahead ${ahead}, behind ${behind}). Pull and reconcile the branch before publishing.`,
    );
  }
}

export function assertVersionNotPublished(packageName, version, result) {
  if (result.code === 0 && result.stdout.trim()) {
    throw new Error(`${packageName}@${version} already exists on npm.`);
  }
  if (!isNotFoundResult(result)) {
    throw new Error(`Could not check whether ${packageName}@${version} is published:\n${result.stderr.trim()}`);
  }
}

export function assertReleaseTagAvailable(tag, result) {
  if (result.code === 0) {
    throw new Error(`Git tag ${tag} already exists.`);
  }
}

export function assertRemoteReleaseTagAvailable(tag, remote, result) {
  if (result.code === 0 && result.stdout.trim()) {
    throw new Error(`Git tag ${tag} already exists on ${remote}.`);
  }
  if (result.code !== 2 && !(result.code === 0 && !result.stdout.trim())) {
    throw new Error(`Could not check Git tag ${tag} on ${remote}:\n${result.stderr.trim()}`);
  }
}

export function assertReleaseCommitOnUpstream(branch, upstream, result) {
  if (result.code !== 0) {
    throw new Error(
      `Cannot resume because release commit ${branch} is not contained in ${upstream}. ` +
        "Reconcile the branch before retrying; npm will not be changed.",
    );
  }
}

export function detachedReleaseUpstream(remotes, pushDefault, branchName, requestedRemote = "") {
  const available = remotes.map((remote) => remote.trim()).filter(Boolean);
  if (!branchName) {
    throw new Error("Detached recovery requires --branch=<name>.");
  }
  const remote = requestedRemote || pushDefault || (available.includes("origin") ? "origin" : available.length === 1 ? available[0] : "");
  if (!remote) {
    throw new Error("Cannot resume from detached HEAD without an unambiguous Git remote.");
  }
  if (!available.includes(remote)) {
    throw new Error(`Cannot resume because Git remote ${remote} is not configured.`);
  }

  return {
    branch: "HEAD",
    mergeRef: `refs/heads/${branchName}`,
    remote,
    upstream: `${remote}/${branchName}`,
  };
}

export function assertPublishedArtifactMatches(packageName, version, publishedResult, packedArtifact) {
  if (isNotFoundResult(publishedResult)) {
    return false;
  }
  if (publishedResult.code !== 0) {
    throw new Error(
      `Could not verify ${packageName}@${version} before resuming:\n${publishedResult.stderr.trim()}`,
    );
  }

  let published;
  try {
    published = JSON.parse(publishedResult.stdout);
  } catch {
    throw new Error(`npm returned invalid artifact metadata for ${packageName}@${version}.`);
  }

  if (!packedArtifact.shasum || !packedArtifact.integrity) {
    throw new Error("npm pack did not provide shasum and integrity metadata required for recovery.");
  }
  const publishedShasum = published.shasum ?? published["dist.shasum"] ?? published.dist?.shasum;
  const publishedIntegrity = published.integrity ?? published["dist.integrity"] ?? published.dist?.integrity;
  if (publishedShasum !== packedArtifact.shasum || publishedIntegrity !== packedArtifact.integrity) {
    throw new Error(
      `Refusing to resume because ${packageName}@${version} does not match the exact local release artifact.`,
    );
  }
  return true;
}

export function assertReleaseTagTargetsHead(tag, head, tagTarget) {
  if (head.trim() !== tagTarget.trim()) {
    throw new Error(`Git tag ${tag} does not target the current release commit.`);
  }
}

async function readReleaseUpstream(options = {}) {
  const currentBranch = (await run("git", ["branch", "--show-current"], { captureStdout: true })).trim();
  if (!currentBranch) {
    if (!options.allowDetached) {
      assertSynchronizedUpstream(branch, "", "0 0");
    }
    const remotes = (await run("git", ["remote"], { captureStdout: true })).trim().split("\n");
    const pushDefaultResult = await runResult("git", ["config", "--get", "remote.pushDefault"]);
    const pushDefault = pushDefaultResult.code === 0 ? pushDefaultResult.stdout.trim() : "";
    const branchCheck = options.recoveryBranch
      ? await runResult("git", ["check-ref-format", "--branch", options.recoveryBranch])
      : { code: 1 };
    if (branchCheck.code !== 0) {
      throw new Error("Detached recovery requires a valid --branch=<name>.");
    }
    return detachedReleaseUpstream(remotes, pushDefault, options.recoveryBranch, options.recoveryRemote);
  }

  const remoteResult = await runResult("git", ["config", "--get", `branch.${currentBranch}.remote`]);
  const mergeResult = await runResult("git", ["config", "--get", `branch.${currentBranch}.merge`]);
  const remote = remoteResult.code === 0 ? remoteResult.stdout.trim() : "";
  const mergeRef = mergeResult.code === 0 ? mergeResult.stdout.trim() : "";
  const upstream = remote && mergeRef ? `${remote}/${mergeRef.replace(/^refs\/heads\//, "")}` : "";
  if (!remote || remote === "." || !mergeRef.startsWith("refs/heads/")) {
    assertSynchronizedUpstream(currentBranch, "", "0 0");
  }
  if (options.recoveryBranch && mergeRef !== `refs/heads/${options.recoveryBranch}`) {
    throw new Error(`Configured upstream does not match --branch=${options.recoveryBranch}.`);
  }
  if (options.recoveryRemote && remote !== options.recoveryRemote) {
    throw new Error(`Configured upstream does not match --remote=${options.recoveryRemote}.`);
  }

  return { branch: currentBranch, mergeRef, remote, upstream };
}

export function applyPackageVersion(packageJson, packageLock, nextVersion) {
  releaseTagForVersion(nextVersion);
  packageJson.version = nextVersion;
  packageLock.version = nextVersion;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = nextVersion;
  }
}

async function updatePackageVersion(nextVersion) {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageLockPath = path.join(repoRoot, "package-lock.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

  const packageLock = JSON.parse(await readFile(packageLockPath, "utf8"));
  applyPackageVersion(packageJson, packageLock, nextVersion);

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);

  return nextVersion;
}

async function readPackageJson() {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
}

export function remoteTagTarget(tag, result) {
  if (result.code !== 0) {
    throw new Error(`Could not inspect Git tag ${tag} on the configured remote:\n${result.stderr.trim()}`);
  }

  const entries = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/, 2));
  const peeled = entries.find(([, ref]) => ref === `refs/tags/${tag}^{}`);
  const direct = entries.find(([, ref]) => ref === `refs/tags/${tag}`);
  return peeled?.[0] ?? direct?.[0] ?? null;
}

async function inspectLocalReleaseTag(releaseTag, head) {
  const existingTag = await runResult("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${releaseTag}`]);
  if (existingTag.code !== 0) {
    return false;
  }

  const tagTarget = await run("git", ["rev-parse", `${releaseTag}^{}`], { captureStdout: true });
  assertReleaseTagTargetsHead(releaseTag, head, tagTarget);
  return true;
}

async function resumeRelease(packageJson, options) {
  const releaseTag = releaseTagForVersion(packageJson.version);
  const status = await run("git", ["status", "--porcelain=v1"], { captureStdout: true });
  assertCleanWorkingTree(status);
  const releaseUpstream = await readReleaseUpstream({
    allowDetached: true,
    recoveryBranch: options.recoveryBranch,
    recoveryRemote: options.recoveryRemote,
  });
  await run("git", ["fetch", "--tags", releaseUpstream.remote]);

  const head = (await run("git", ["rev-parse", "HEAD"], { captureStdout: true })).trim();
  const subject = (await run("git", ["log", "-1", "--pretty=%s"], { captureStdout: true })).trim();
  if (subject !== releaseCommitMessage(releaseTag)) {
    throw new Error(`Cannot resume because HEAD is not ${releaseCommitMessage(releaseTag)}.`);
  }
  const contained = await runResult("git", ["merge-base", "--is-ancestor", "HEAD", releaseUpstream.upstream]);
  let pushReleaseCommit = false;
  if (contained.code !== 0) {
    const upstreamContained = await runResult("git", [
      "merge-base",
      "--is-ancestor",
      releaseUpstream.upstream,
      "HEAD",
    ]);
    assertReleaseCommitOnUpstream(releaseUpstream.branch, releaseUpstream.upstream, upstreamContained);
    pushReleaseCommit = true;
  }

  const packOutput = await run("npm", ["pack", "--json"], { captureStdout: true });
  const artifact = parsePackedArtifact(packOutput);
  try {
    const hasLocalTag = await inspectLocalReleaseTag(releaseTag, head);
    const remoteTagResult = await runResult("git", [
      "ls-remote",
      "--tags",
      releaseUpstream.remote,
      `refs/tags/${releaseTag}`,
      `refs/tags/${releaseTag}^{}`,
    ]);
    const remoteTarget = remoteTagTarget(releaseTag, remoteTagResult);
    if (remoteTarget) {
      assertReleaseTagTargetsHead(releaseTag, head, remoteTarget);
    }

    const published = await runResult("npm", [
      "view",
      `${packageJson.name}@${packageJson.version}`,
      "dist.shasum",
      "dist.integrity",
      "--json",
    ]);
    const alreadyPublished = assertPublishedArtifactMatches(
      packageJson.name,
      packageJson.version,
      published,
      artifact,
    );
    if (!hasLocalTag) {
      await run("git", ["tag", "--annotate", releaseTag, "--message", releaseCommitMessage(releaseTag)]);
    }
    if (pushReleaseCommit) {
      await run("git", [
        "push",
        "--atomic",
        releaseUpstream.remote,
        `HEAD:${releaseUpstream.mergeRef}`,
        `refs/tags/${releaseTag}`,
      ]);
    } else if (!remoteTarget) {
      await run("git", ["push", releaseUpstream.remote, `refs/tags/${releaseTag}`]);
    }

    if (!alreadyPublished) {
      await run("npm", ["whoami"]);
      await run("npm", ["publish", artifact.filename]);
    }

    console.log(`Verified ${packageJson.name}@${packageJson.version}.`);
    console.log(`Release commit and ${releaseTag} are synchronized with ${releaseUpstream.remote}.`);
  } finally {
    await rm(path.join(repoRoot, artifact.filename), { force: true });
  }
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

  const packageJson = await readPackageJson();

  if (options.resume) {
    await resumeRelease(packageJson, options);
    return;
  }
  await run("npm", ["whoami"]);
  const status = await run("git", ["status", "--porcelain=v1"], { captureStdout: true });
  assertCleanWorkingTree(status);
  const releaseUpstream = await readReleaseUpstream();
  await run("git", ["fetch", "--tags", releaseUpstream.remote]);
  const divergence = await run(
    "git",
    ["rev-list", "--left-right", "--count", `HEAD...${releaseUpstream.upstream}`],
    { captureStdout: true },
  );
  assertSynchronizedUpstream(releaseUpstream.branch, releaseUpstream.upstream, divergence);
  const currentPublished = await runResult("npm", ["view", packageJson.name, "version"]);
  const nextVersion = nextReleaseVersion(packageJson.version, options.releaseType, currentPublished);
  const releaseTag = releaseTagForVersion(nextVersion);

  console.log(`Packaging ${packageJson.name}@${nextVersion} with a ${options.releaseType} version bump...`);
  const published = await runResult("npm", ["view", `${packageJson.name}@${nextVersion}`, "version"]);
  assertVersionNotPublished(packageJson.name, nextVersion, published);
  const existingTag = await runResult("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${releaseTag}`]);
  assertReleaseTagAvailable(releaseTag, existingTag);
  const remoteTag = await runResult("git", [
    "ls-remote",
    "--exit-code",
    "--tags",
    releaseUpstream.remote,
    `refs/tags/${releaseTag}`,
  ]);
  assertRemoteReleaseTagAvailable(releaseTag, releaseUpstream.remote, remoteTag);

  await run("npm", ["run", "docs:api"]);
  await generateChanges();
  console.log("Updated CHANGES.md.");
  await updatePackageVersion(nextVersion);
  console.log(`Version bumped to ${nextVersion}.`);
  await run("npm", ["run", "build"]);
  console.log("Rebuilt packaged files with baked CLI version.");
  await run("git", ["add", "--", "package.json", "package-lock.json", "CHANGES.md", "docs/api", "src/cli/cli-version.ts", "dist", "bin"]);
  await run("git", ["commit", "--message", releaseCommitMessage(releaseTag)]);
  const packOutput = await run("npm", ["pack", "--json"], { captureStdout: true });
  const artifact = parsePackedArtifact(packOutput);
  try {
    await run("git", ["tag", "--annotate", releaseTag, "--message", releaseCommitMessage(releaseTag)]);
    await run("git", [
      "push",
      "--atomic",
      releaseUpstream.remote,
      `HEAD:${releaseUpstream.mergeRef}`,
      `refs/tags/${releaseTag}`,
    ]);
    await run("npm", ["publish", artifact.filename]);
    console.log(`Published ${artifact.filename}.`);
    console.log(`Created release tag ${releaseTag}.`);
    console.log(`Pushed the release commit and ${releaseTag} to ${releaseUpstream.remote}.`);
  } finally {
    await rm(path.join(repoRoot, artifact.filename), { force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  packageForNpm().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
