import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { parseNpmPackJson } from "./npm-pack-json.mjs";
import { checkPublishedRelease } from "./check-npm-release.mjs";

const exec = promisify(execFile);
const registry = "--registry=https://registry.npmjs.org";
const runNpm = args => exec("npm", args, { maxBuffer: 10 * 1024 * 1024 });

export async function publishNpmRelease(tag, packedJson, { run = runNpm, log = console.log } = {}) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error("Expected a stable release tag.");
  const [artifact] = parseNpmPackJson(packedJson);
  if (!/^[a-zA-Z0-9._-]+\.tgz$/.test(artifact.filename)) throw new Error("Expected a local npm tarball filename.");
  let existing;
  let missing = false;
  try {
    const result = await run(["view", `sporades@${tag.slice(1)}`, "--json", registry, "--prefer-online", "--fetch-retries=0", "--fetch-timeout=30000"]);
    existing = JSON.parse(result.stdout);
  } catch (error) {
    // Only an explicit missing version permits publication. A registry outage or
    // failed authentication must not be treated as an absent package.
    let code;
    try { code = JSON.parse(error.stdout).error?.code; } catch {}
    if (code !== "E404") throw error;
    missing = true;
  }
  if (!missing) {
    checkPublishedRelease(tag, packedJson, existing);
    log(`sporades@${tag.slice(1)} already matches the tested tarball and has provenance; skipping publication.`);
    return "already-published";
  }
  const result = await run(["publish", `./${artifact.filename}`, "--access", "public", "--provenance", "--ignore-scripts", registry]);
  log(result.stdout.trim());
  return "published";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await publishNpmRelease(process.argv[2], await readFile(process.argv[3], "utf8"));
  } catch (error) {
    console.error(error.stderr || error.message);
    process.exitCode = 1;
  }
}
