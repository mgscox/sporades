import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseNpmPackJson } from "./npm-pack-json.mjs";

export function checkPublishedRelease(tag, packedJson, metadata) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error("Expected a stable release tag.");
  const [packed] = parseNpmPackJson(packedJson);
  const published = Array.isArray(metadata) && metadata.length === 1 ? metadata[0] : metadata;
  if (published?.name !== "sporades" || published.version !== tag.slice(1) ||
      !packed.integrity?.startsWith("sha512-") || published.dist?.integrity !== packed.integrity ||
      !published.dist?.attestations?.url || !published.dist.attestations.provenance?.predicateType) {
    throw new Error("Registry version, packed artifact integrity and provenance must all be present and agree.");
  }
  return published.version;
}

export function checkNpmRelease(tag, { cwd = process.cwd(), repository = process.env.GITHUB_REPOSITORY } = {}) {
  if (repository !== "mgscox/sporades") throw new Error("Publishing is restricted to mgscox/sporades.");
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error("Expected a stable vX.Y.Z release tag.");
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const readJson = file => JSON.parse(readFileSync(path.join(cwd, file), "utf8"));
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  if (pkg.name !== "sporades" || tag !== `v${pkg.version}` ||
      lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) {
    throw new Error("Release tag, package name and lockfile versions must agree.");
  }
  if (pkg.repository?.url !== "git+https://github.com/mgscox/sporades.git") {
    throw new Error("package.json must declare the canonical GitHub repository for npm provenance.");
  }
  if (git("rev-parse", "HEAD") !== git("rev-parse", `refs/tags/${tag}^{commit}`)) {
    throw new Error("Release tag must target the checked-out commit.");
  }
  git("merge-base", "--is-ancestor", "HEAD", "origin/main");
  if (git("log", "-1", "--pretty=%s") !== `Release ${tag}`) {
    throw new Error("Release tag must target the release preparation commit on main.");
  }
  return pkg.version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "--published") {
      const [, , , tag, packFile, metadataFile] = process.argv;
      console.log(`Verified published Sporades ${checkPublishedRelease(tag, readFileSync(packFile, "utf8"), JSON.parse(readFileSync(metadataFile, "utf8")))}.`);
    } else {
      console.log(`Validated Sporades ${checkNpmRelease(process.argv[2])}.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
