import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkNpmRelease, checkPublishedRelease } from "../scripts/check-npm-release.mjs";
import { assertCiPublishUpstream, parsePackageArgs, publishOrHandoff } from "../scripts/package.mjs";
import { publishNpmRelease } from "../scripts/publish-npm-release.mjs";

const identity = { GIT_AUTHOR_NAME: "Release test", GIT_AUTHOR_EMAIL: "release@example.test", GIT_COMMITTER_NAME: "Release test", GIT_COMMITTER_EMAIL: "release@example.test" };
const upstream = { branch: "main", mergeRef: "refs/heads/main" };
const canonical = "git@github.com:mgscox/sporades.git";
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity }, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), "sporades-release-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-b", "main");
  const pkg = { name: "sporades", version: "1.2.3", type: "module", repository: { type: "git", url: "git+https://github.com/mgscox/sporades.git" } };
  await writeFile(path.join(cwd, "package.json"), JSON.stringify(pkg));
  await writeFile(path.join(cwd, "package-lock.json"), JSON.stringify({ name: "sporades", version: pkg.version, packages: { "": { version: pkg.version } } }));
  git(cwd, "add", "."); git(cwd, "commit", "-m", "Release v1.2.3");
  git(cwd, "tag", "-a", "v1.2.3", "-m", "Release v1.2.3");
  git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
  return cwd;
}

test("CI release accepts only the canonical synchronized main upstream", () => {
  assert.equal(parsePackageArgs(["--ci-publish", "--patch"]).ciPublish, true);
  assert.throws(() => parsePackageArgs(["--ci-publish", "--resume"]), /re-run the failed/);
  assert.doesNotThrow(() => assertCiPublishUpstream(upstream, canonical));
  assert.doesNotThrow(() => assertCiPublishUpstream(upstream, "https://github.com/mgscox/sporades.git"));
  for (const remote of ["git@github.com:attacker/sporades.git", "https://github.com/mgscox/sporades.git.evil", "/tmp/remote"]) {
    assert.throws(() => assertCiPublishUpstream(upstream, remote), /requires main/);
  }
  assert.throws(() => assertCiPublishUpstream({ ...upstream, branch: "feature" }, canonical), /requires main/);
});

test("CI handoff never invokes local publishing and makes pending status explicit", async () => {
  const lines = [];
  await publishOrHandoff(true, "candidate.tgz", () => assert.fail("CI handoff called local npm publish"), line => lines.push(line));
  assert.match(lines.join("\n"), /Publication is pending/);
  let published;
  await publishOrHandoff(false, "candidate.tgz", async filename => { published = filename; }, () => {});
  assert.equal(published, "candidate.tgz");
});

test("registry confirmation requires the exact tested tarball and provenance metadata", () => {
  const pack = JSON.stringify([{ filename: "sporades-1.2.3.tgz", integrity: "sha512-test" }]);
  const metadata = { name: "sporades", version: "1.2.3", dist: { integrity: "sha512-test", attestations: { url: "https://registry.npmjs.org/attestation", provenance: { predicateType: "https://slsa.dev/provenance/v1" } } } };
  assert.equal(checkPublishedRelease("v1.2.3", pack, metadata), "1.2.3");
  assert.equal(checkPublishedRelease("v1.2.3", pack, [metadata]), "1.2.3");
  for (const invalid of [{}, { ...metadata, version: "1.2.4" }, { ...metadata, dist: { integrity: "sha512-wrong" } }, { ...metadata, dist: { integrity: "sha512-test" } }]) {
    assert.throws(() => checkPublishedRelease("v1.2.3", pack, invalid), /must all/);
  }
});

test("publish retries skip an existing matching version and fail closed for registry errors or conflicting bytes", async () => {
  const pack = JSON.stringify([{ filename: "sporades-1.2.3.tgz", integrity: "sha512-tested" }]);
  let metadata;
  let publishes = 0;
  const run = async args => {
    if (args[0] === "view") {
      if (!metadata) throw Object.assign(new Error("missing"), { stdout: JSON.stringify({ error: { code: "E404" } }) });
      return { stdout: JSON.stringify(metadata) };
    }
    assert.deepEqual(args.slice(0, 6), ["publish", "./sporades-1.2.3.tgz", "--access", "public", "--provenance", "--ignore-scripts"]);
    publishes++;
    metadata = { name: "sporades", version: "1.2.3", dist: { integrity: "sha512-tested", attestations: { url: "https://registry.npmjs.org/attestation", provenance: { predicateType: "https://slsa.dev/provenance/v1" } } } };
    return { stdout: "+ sporades@1.2.3" };
  };
  const options = { run, log: () => {} };
  assert.equal(await publishNpmRelease("v1.2.3", pack, options), "published");
  assert.equal(await publishNpmRelease("v1.2.3", pack, options), "already-published");
  assert.equal(publishes, 1);
  metadata.dist.integrity = "sha512-other";
  await assert.rejects(publishNpmRelease("v1.2.3", pack, options), /must all/);
  assert.equal(publishes, 1);
  for (const code of ["E401", "E503"]) {
    await assert.rejects(publishNpmRelease("v1.2.3", pack, { run: async () => { throw Object.assign(new Error(code), { stdout: JSON.stringify({ error: { code } }) }); } }), new RegExp(code));
  }
});

test("release validation rejects mismatched versions, forks, missing tags and non-main commits", async t => {
  const cwd = await fixture(t);
  const options = { cwd, repository: "mgscox/sporades" };
  assert.equal(checkNpmRelease("v1.2.3", options), "1.2.3");
  assert.throws(() => checkNpmRelease("v1.2.3", { ...options, repository: "fork/sporades" }), /restricted/);
  assert.throws(() => checkNpmRelease("v1.2.4", options), /must agree/);
  assert.throws(() => checkNpmRelease("v1.2.3-beta.1", options), /stable/);
  await writeFile(path.join(cwd, "package-lock.json"), JSON.stringify({ version: "9.0.0" }));
  assert.throws(() => checkNpmRelease("v1.2.3", options), /must agree/);
  git(cwd, "restore", "package-lock.json");
  git(cwd, "tag", "-d", "v1.2.3");
  assert.throws(() => checkNpmRelease("v1.2.3", options));
  git(cwd, "commit", "--allow-empty", "-m", "Release v1.2.3");
  git(cwd, "tag", "v1.2.3");
  assert.throws(() => checkNpmRelease("v1.2.3", options), /merge-base/);
  git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
  assert.equal(checkNpmRelease("v1.2.3", options), "1.2.3");
  git(cwd, "checkout", "HEAD~1");
  assert.throws(() => checkNpmRelease("v1.2.3", options), /checked-out/);
});

test("release preparation pushes commit and tag to a disposable Git remote without npm login or publish", async t => {
  const cwd = await fixture(t);
  // Copy the actual command into a test-owned repository. No real checkout or
  // registry is mutated. npm models preparation, while Git performs real pushes.
  for (const dir of ["scripts", "skills/generate-changes/scripts", "docs/api", "src/cli", "dist", "bin"]) await mkdir(path.join(cwd, dir), { recursive: true });
  for (const file of ["scripts/package.mjs", "scripts/npm-pack-json.mjs", "skills/generate-changes/scripts/generate-changes.mjs"]) await copyFile(file, path.join(cwd, file));
  for (const file of ["CHANGES.md", "docs/api/index.md", "src/cli/cli-version.ts", "dist/index.js", "bin/index.js"]) await writeFile(path.join(cwd, file), "initial\n");
  git(cwd, "add", "."); git(cwd, "commit", "-m", "Prepare fixture");
  const remote = `${cwd}-remote.git`;
  const tools = `${cwd}-tools`;
  t.after(() => Promise.all([rm(remote, { recursive: true, force: true }), rm(tools, { recursive: true, force: true })]));
  git(cwd, "init", "--bare", remote);
  git(cwd, "remote", "add", "origin", remote);
  git(cwd, "push", "-u", "origin", "main");
  await mkdir(tools);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  await writeFile(path.join(tools, "git"), `#!/usr/bin/env node\nimport {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2); if(args.join(' ')==='remote get-url --push origin') console.log(${JSON.stringify(canonical)}); else {const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);}\n`);
  await writeFile(path.join(tools, "npm"), `#!/usr/bin/env node\nconst args=process.argv.slice(2);\nif(args[0]==='whoami'||args[0]==='publish'){console.error('unexpected authentication or publish');process.exit(77);}\nif(args[0]==='view'){if(args[1]==='sporades')console.log('1.2.3');else {console.error('E404');process.exit(1);}}\nelse if(args[0]==='pack')console.log(JSON.stringify([{filename:'candidate.tgz',shasum:'a'.repeat(40),integrity:'sha512-test'}]));\nelse if(args[0]!=='run')process.exit(78);\n`);
  await writeFile(path.join(tools, "package.json"), '{"type":"module"}');
  await chmod(path.join(tools, "git"), 0o755); await chmod(path.join(tools, "npm"), 0o755);
  const result = execFileSync(process.execPath, ["scripts/package.mjs", "--ci-publish", "--patch"], {
    cwd, encoding: "utf8", env: { ...process.env, ...identity, PATH: `${tools}${path.delimiter}${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(result, /Publication is pending/);
  assert.equal(git(cwd, "rev-parse", "HEAD"), git(cwd, "--git-dir", remote, "rev-parse", "refs/heads/main"));
  assert.equal(git(cwd, "rev-parse", "HEAD"), git(cwd, "--git-dir", remote, "rev-parse", "refs/tags/v1.2.4^{}"));
});
