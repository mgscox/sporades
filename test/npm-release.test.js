import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkNpmRelease, checkPublishedRelease } from "../scripts/check-npm-release.mjs";
import { assertCiPublishUpstream, parsePackageArgs, publishOrHandoff } from "../scripts/package.mjs";
import { guardReleaseIssue, releaseIssueTrailer, findIssueRelease, reportIssueRelease } from "../scripts/issue-npm-release.mjs";
import { publishNpmRelease } from "../scripts/publish-npm-release.mjs";

const identity = { GIT_AUTHOR_NAME: "Release test", GIT_AUTHOR_EMAIL: "release@example.test", GIT_COMMITTER_NAME: "Release test", GIT_COMMITTER_EMAIL: "release@example.test" };
const upstream = { branch: "main", mergeRef: "refs/heads/main" };
const canonical = "git@github.com:mgscox/sporades.git";
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity }, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function fixture(t, version = "1.2.3") {
  const cwd = await mkdtemp(path.join(tmpdir(), "sporades-release-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-b", "main");
  const pkg = { name: "sporades", version, type: "module", repository: { type: "git", url: "git+https://github.com/mgscox/sporades.git" } };
  await writeFile(path.join(cwd, "package.json"), JSON.stringify(pkg));
  await writeFile(path.join(cwd, "package-lock.json"), JSON.stringify({ name: "sporades", version: pkg.version, packages: { "": { version: pkg.version } } }));
  git(cwd, "add", "."); git(cwd, "commit", "-m", `Release v${version}`);
  git(cwd, "tag", "-a", `v${version}`, "-m", `Release v${version}`);
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

for (const [bump, version, entryPoint = "issue"] of [["patch", "0.9.42"], ["minor", "0.10.0"], ["major", "1.0.0"], ["patch", "0.9.42", "local"]]) test(`${entryPoint} ${bump} release preparation uses the shared packaging path`, async t => {
  const cwd = await fixture(t, "0.9.41");
  // Copy the actual command into a test-owned repository. No real checkout or
  // registry is mutated. npm models preparation, while Git performs real pushes.
  for (const dir of ["scripts", "skills/generate-changes/scripts", "docs/api", "src/cli", "dist", "bin"]) await mkdir(path.join(cwd, dir), { recursive: true });
  for (const file of ["scripts/package.mjs", "scripts/issue-npm-release.mjs", "scripts/npm-pack-json.mjs", "skills/generate-changes/scripts/generate-changes.mjs"]) await copyFile(file, path.join(cwd, file));
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
  await writeFile(path.join(tools, "npm"), `#!/usr/bin/env node\nconst args=process.argv.slice(2);\nif(args[0]==='whoami'||args[0]==='publish'){console.error('unexpected authentication or publish');process.exit(77);}\nif(args[0]==='view'){if(args[1]==='sporades')console.log('0.9.41');else {console.error('E404');process.exit(1);}}\nelse if(args[0]==='pack')console.log(JSON.stringify([{filename:'candidate.tgz',shasum:'a'.repeat(40),integrity:'sha512-test'}]));\nelse if(args[0]!=='run')process.exit(78);\n`);
  await writeFile(path.join(tools, "package.json"), '{"type":"module"}');
  await chmod(path.join(tools, "git"), 0o755); await chmod(path.join(tools, "npm"), 0o755);
  const env = { ...process.env, ...identity, RELEASE_ISSUE: "987", RELEASE_BUMP: bump, GITHUB_OUTPUT: path.join(tools, "github-output"), PATH: `${tools}${path.delimiter}${process.env.PATH}` };
  const run = () => execFileSync(process.execPath, entryPoint === "issue" ? ["scripts/issue-npm-release.mjs"] : ["scripts/package.mjs", "--ci-publish", `--${bump}`], {
    cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"],
  });
  const result = run();
  assert.match(result, /Publication is pending/);
  assert.equal(git(cwd, "rev-parse", "HEAD"), git(cwd, "--git-dir", remote, "rev-parse", "refs/heads/main"));
  assert.equal(git(cwd, "rev-parse", "HEAD"), git(cwd, "--git-dir", remote, "rev-parse", `refs/tags/v${version}^{}`));
  assert.equal(git(cwd, "cat-file", "-t", `v${version}`), "tag");
  assert.equal(git(cwd, "log", "-1", "--format=%s"), `Release v${version}`);
  assert.equal(JSON.parse(await readFile(path.join(cwd, "package.json"))).version, version);
  const lock = JSON.parse(await readFile(path.join(cwd, "package-lock.json")));
  assert.equal(lock.version, version);
  assert.equal(lock.packages[""].version, version);
  if (entryPoint === "local") {
    assert.doesNotMatch(git(cwd, "log", "-1", "--format=%B"), /Release-Issue:/);
    return;
  }
  assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), `tag=v${version}\n`);
  assert.match(git(cwd, "log", "-1", "--format=%B"), /Release-Issue: https:\/\/github.com\/mgscox\/sporades\/issues\/987/);
  const target = git(cwd, "rev-parse", "HEAD");
  // New commits on main must not cause a second bump on a retry of this issue.
  git(cwd, "commit", "--allow-empty", "-m", "Main advanced");
  git(cwd, "push", "origin", "main");
  assert.match(run(), new RegExp(`Prepared v${version.replaceAll(".", "\\.")}`));
  assert.equal(git(cwd, "rev-parse", `v${version}^{}`), target);
  assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), `tag=v${version}\ntag=v${version}\n`);
  assert.equal(findIssueRelease(987, bump, { cwd }), `v${version}`);
  assert.equal(findIssueRelease(98, bump, { cwd }), null, "issue numbers must match exactly");
  assert.throws(() => findIssueRelease(987, bump === "major" ? "minor" : "major", { cwd }), /different bump/);
  git(cwd, "tag", "-d", `v${version}`);
  assert.throws(() => findIssueRelease(987, bump, { cwd }));
  git(cwd, "tag", "-a", `v${version}`, "-m", "Wrong target");
  assert.throws(() => findIssueRelease(987, bump, { cwd }), /missing or mismatched/);
});

function issueEvent({ sender = "mgscox", label = "release:patch", state = "open", labels = [label], permission = "read" } = {}) {
  const calls = [];
  const context = { repo: { owner: "mgscox", repo: "sporades" }, eventName: "issues", runId: 12345,
    payload: { action: "labeled", sender: { login: sender }, label: { name: label }, issue: { number: 987, state } } };
  const github = { rest: {
    repos: { getCollaboratorPermissionLevel: async args => { calls.push(["permission", args]); return { data: { permission } }; } },
    issues: {
      get: async () => ({ data: { state, labels: labels.map(name => ({ name })) } }),
      createComment: async args => { calls.push(["comment", args]); },
      update: async args => { calls.push(["update", args]); },
    },
  } };
  return { context, github, calls };
}

test("issue guard accepts only an explicit authorized bump on a currently open canonical issue", async () => {
  for (const bump of ["patch", "minor", "major"]) {
    const fixture = issueEvent({ label: `release:${bump}` });
    assert.equal((await guardReleaseIssue(fixture)).bump, bump);
    assert.equal(fixture.calls.length, 0, "owner needs no permission API lookup");
  }
  assert.equal((await guardReleaseIssue(issueEvent({ sender: "admin", permission: "admin" }))).allowed, true);
  const denied = [
    issueEvent({ sender: "contributor", permission: "write" }),
    issueEvent({ sender: "maintainer", permission: "maintain" }),
    issueEvent({ label: "release:unknown" }), issueEvent({ label: "ready-for-human" }),
    issueEvent({ state: "closed" }), issueEvent({ labels: ["release:patch", "release:minor"] }),
    issueEvent({ labels: [] }), issueEvent({ labels: ["release:major"] }),
  ];
  const fork = issueEvent(); fork.context.repo.owner = "fork"; denied.push(fork);
  const pull = issueEvent(); pull.context.payload.issue.pull_request = {}; denied.push(pull);
  const wrongEvent = issueEvent(); wrongEvent.context.eventName = "push"; denied.push(wrongEvent);
  const noSender = issueEvent(); delete noSender.context.payload.sender; denied.push(noSender);
  const stale = issueEvent(); stale.github.rest.issues.get = async () => ({ data: { state: "closed", labels: ["release:patch"] } }); denied.push(stale);
  const issueApiFailure = issueEvent(); issueApiFailure.github.rest.issues.get = async () => { throw new Error("API unavailable"); }; denied.push(issueApiFailure);
  const apiFailure = issueEvent({ sender: "unknown" }); apiFailure.github.rest.repos.getCollaboratorPermissionLevel = async () => { throw new Error("API unavailable"); }; denied.push(apiFailure);
  for (const fixture of denied) {
    const result = await guardReleaseIssue(fixture);
    assert.equal(result.allowed, false);
    assert.ok(result.reason);
    assert.equal(fixture.calls.some(([type]) => type === "comment" || type === "update"), false);
  }
});

test("release reporting closes only verified successes and comments failures with recovery guidance", async () => {
  const fixture = issueEvent();
  await reportIssueRelease({ ...fixture, tag: "v0.9.42", prepareResult: "success", publishResult: "success" });
  assert.deepEqual(fixture.calls.map(([type]) => type), ["comment", "update"]);
  assert.equal(fixture.calls[1][1].state, "closed");
  assert.match(fixture.calls[0][1].body, /https:\/\/www.npmjs.com\/package\/sporades\/v\/0.9.42/);
  assert.match(fixture.calls[0][1].body, /actions\/runs\/12345/);
  assert.match(fixture.calls[0][1].body, /<!-- cubefarm:agent -->/);
  for (const [prepareResult, publishResult] of [["failure", "skipped"], ["success", "failure"], ["cancelled", "skipped"], ["success", "cancelled"]]) {
    const failure = issueEvent();
    await reportIssueRelease({ ...failure, tag: "v0.9.42", prepareResult, publishResult });
    assert.equal(failure.calls.length, 1);
    assert.match(failure.calls[0][1].body, /same tag/);
    assert.match(failure.calls[0][1].body, /actions\/runs\/12345/);
  }
  for (const bad of [0, -1, "987\nmalicious", undefined]) assert.throws(() => releaseIssueTrailer(bad, "patch"), /positive/);
});

test("publish.yml wires one publish job to tag and guarded issue preparation with reporting and PR coverage", async () => {
  const workflow = await readFile(".github/workflows/publish.yml", "utf8");
  const job = name => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][\w-]*:\n/)[0];
  assert.equal(workflow.match(/node scripts\/publish-npm-release.mjs/g).length, 1);
  assert.match(workflow, /issues:\n    types: \[labeled\]/);
  assert.match(workflow, /tags: \['v\*'\]/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(job("check-release-automation"), /node --test .*test\/npm-release.test.js/);
  assert.match(job("guard"), /guardReleaseIssue/);
  assert.match(job("guard"), /core.notice\(decision.reason\)/);
  assert.match(job("prepare"), /needs: guard/);
  assert.match(job("prepare"), /needs.guard.outputs.allowed == 'true'/);
  assert.match(job("prepare"), /guardReleaseIssue/);
  assert.match(job("prepare"), /node scripts\/issue-npm-release.mjs/);
  assert.match(job("prepare"), /contents: write/);
  assert.match(job("publish"), /needs: \[guard, prepare\]/);
  assert.match(job("publish"), /always\(\) && !cancelled\(\)/);
  assert.match(job("publish"), /github.event_name == 'push'/);
  assert.match(job("publish"), /needs.prepare.result == 'success'/);
  assert.match(job("publish"), /ref: \$\{\{ env.RELEASE_TAG \}\}/);
  assert.match(job("publish"), /id-token: write/);
  assert.match(job("report"), /if: always\(\)/);
  assert.match(job("report"), /needs: \[guard, prepare, publish\]/);
  assert.match(job("report"), /reportIssueRelease/);
  for (const name of ["guard", "prepare", "publish", "report"]) assert.match(job(name), /runs-on: ubuntu-latest/);
  const template = await readFile(".github/ISSUE_TEMPLATE/release.yml", "utf8");
  assert.match(template, /labels: \[ready-for-human\]/);
  assert.match(template, /type: dropdown/);
  assert.match(template, /dropdown does not apply labels/);
});

test("the workflow's guard script exposes authorized bumps and explains rejected release labels", async () => {
  const workflow = await readFile(".github/workflows/publish.yml", "utf8");
  const guard = workflow.split("\n  guard:\n")[1].split("\n  prepare:\n")[0];
  const script = guard.split("          script: |\n")[1].split("\n").map(line => line.replace(/^            /, "")).join("\n");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("github", "context", "core", script);
  const previous = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = process.cwd();
  try {
    for (const options of [{}, { sender: "outsider" }, { state: "closed" }, { labels: ["release:patch", "release:minor"] }, { label: "release:unknown" }, { label: "ready-for-human" }]) {
      const fixture = issueEvent(options);
      const outputs = {};
      const notices = [];
      await run(fixture.github, fixture.context, { notice: text => notices.push(text), setOutput: (key, value) => { outputs[key] = value; } });
      assert.equal(notices.length, 1);
      if (!Object.keys(options).length) {
        assert.deepEqual(outputs, { allowed: "true", bump: "patch" });
        assert.equal(fixture.calls.length, 0);
      } else {
        assert.equal(outputs.allowed, "false");
        assert.equal(outputs.bump, undefined);
        const comments = fixture.calls.filter(([type]) => type === "comment");
        if (options.label !== "ready-for-human") {
          assert.equal(comments.length, 1);
          assert.match(comments[0][1].body, /Release skipped: .*\n\n<!-- cubefarm:agent -->/);
        } else assert.equal(comments.length, 0);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = previous;
  }
});
