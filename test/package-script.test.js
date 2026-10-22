import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildChangeEntries,
  categorizeChange,
  generateChanges,
  upsertTopSection,
} from "../skills/generate-changes/scripts/generate-changes.mjs";
import {
  applyPackageVersion,
  assertCleanWorkingTree,
  assertNpmAuthenticated,
  assertPublishedArtifactMatches,
  assertRemoteReleaseTagAvailable,
  assertReleaseCommitOnUpstream,
  assertReleaseTagAvailable,
  assertReleaseTagTargetsHead,
  assertSynchronizedUpstream,
  assertVersionNotPublished,
  bumpVersion,
  describeRegistryFailure,
  detachedReleaseUpstream,
  nextReleaseVersion,
  npmRegistryArgs,
  parsePackageArgs,
  parsePackedArtifact,
  parsePackedTarball,
  remoteTagTarget,
  releaseCommitMessage,
  releaseTagForVersion,
  usage,
} from "../scripts/package.mjs";
import { parseNpmPackJson } from "../scripts/npm-pack-json.mjs";

test("package script defaults to a minor version bump", () => {
  assert.deepEqual(parsePackageArgs([]), {
    help: false,
    recoveryBranch: "",
    recoveryRemote: "",
    releaseType: "minor",
    resume: false,
  });
});

test("package script accepts explicit semver bump flags", () => {
  assert.equal(parsePackageArgs(["--major"]).releaseType, "major");
  assert.equal(parsePackageArgs(["--minor"]).releaseType, "minor");
  assert.equal(parsePackageArgs(["--patch"]).releaseType, "patch");
});

test("package script accepts recovery only without a version bump", () => {
  assert.deepEqual(parsePackageArgs(["--resume", "--branch=release", "--remote=upstream"]), {
    help: false,
    recoveryBranch: "release",
    recoveryRemote: "upstream",
    releaseType: "minor",
    resume: true,
  });
  assert.throws(() => parsePackageArgs(["--resume", "--patch"]), /cannot be combined/);
  assert.throws(() => parsePackageArgs(["--branch=main"]), /only be used with --resume/);
  assert.throws(() => parsePackageArgs(["--resume", "--branch="]), /requires a branch name/);
});

test("package script bumps semver versions", () => {
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
});

test("package script bumps from the newer published patch version", () => {
  assert.equal(nextReleaseVersion("0.5.0", "patch", { code: 0, stdout: "0.5.1\n", stderr: "" }), "0.5.2");
  assert.equal(nextReleaseVersion("0.6.0", "patch", { code: 0, stdout: "0.5.1\n", stderr: "" }), "0.6.1");
  assert.equal(nextReleaseVersion("0.1.0", "patch", { code: 1, stdout: "", stderr: "npm error code E404" }), "0.1.1");
  assert.throws(
    () => nextReleaseVersion("0.5.0", "patch", { code: 1, stdout: "", stderr: "npm error code E401" }),
    /Could not determine/,
  );
});

test("package script writes the exact resolved version to both manifests", () => {
  const packageJson = { version: "0.5.0" };
  const packageLock = { version: "0.5.0", packages: { "": { version: "0.5.0" } } };

  applyPackageVersion(packageJson, packageLock, "0.5.2");

  assert.equal(packageJson.version, "0.5.2");
  assert.equal(packageLock.version, "0.5.2");
  assert.equal(packageLock.packages[""].version, "0.5.2");
});

test("package script reads npm pack tarball filenames from npm 11 and npm 12 JSON", () => {
  assert.equal(
    parsePackedTarball(JSON.stringify([{ name: "sporades", filename: "sporades-0.6.3.tgz" }])),
    "sporades-0.6.3.tgz",
  );
  assert.equal(
    parsePackedTarball(
      JSON.stringify({ sporades: { name: "sporades", filename: "sporades-0.6.3.tgz" } }),
    ),
    "sporades-0.6.3.tgz",
  );
});

test("package script reads exact npm pack artifact provenance", () => {
  assert.deepEqual(
    parsePackedArtifact(
      JSON.stringify([{ filename: "sporades-1.2.3.tgz", shasum: "abc123", integrity: "sha512-example" }]),
    ),
    { filename: "sporades-1.2.3.tgz", shasum: "abc123", integrity: "sha512-example" },
  );
});

test("npm pack JSON parser normalizes npm 11 keyed wrappers and preserves provenance", () => {
  const metadata = {
    filename: "sporades-0.9.39.tgz",
    version: "0.9.39",
    shasum: "abc123",
    integrity: "sha512-example",
    files: [{ path: "bin/sporades.js", size: 42 }],
  };
  const output = JSON.stringify([{ sporades: metadata }]);
  assert.deepEqual(parseNpmPackJson(output), [metadata]);
  assert.deepEqual(parsePackedArtifact(output), {
    filename: metadata.filename,
    integrity: metadata.integrity,
    shasum: metadata.shasum,
  });
  assert.deepEqual(
    parseNpmPackJson(JSON.stringify({ sporades: metadata })),
    [metadata],
  );
  assert.deepEqual(parseNpmPackJson(JSON.stringify([metadata])), [metadata]);
  assert.deepEqual(parseNpmPackJson(JSON.stringify(metadata)), [metadata]);
});

test("npm pack JSON parser rejects empty, malformed, and filename-free results", () => {
  assert.throws(() => parseNpmPackJson(""), /did not report a tarball filename/);
  assert.throws(() => parseNpmPackJson("not json"), /invalid JSON/);
  assert.throws(() => parseNpmPackJson(JSON.stringify([{ sporades: { version: "1.0.0" } }])), /did not include/);
  for (const value of [null, [], [null], ["invalid"], { sporades: { filename: "" } }, { sporades: { filename: " " } }]) {
    assert.throws(() => parseNpmPackJson(JSON.stringify(value)), /did not include/);
  }
});

test("npm pack JSON parser refuses ambiguous output instead of skipping malformed entries", () => {
  const artifact = { filename: "sporades-1.0.0.tgz" };
  for (const value of [[artifact, artifact], [artifact, null], { sporades: artifact, other: {} }, [{ sporades: artifact, other: artifact }]]) {
    assert.throws(() => parseNpmPackJson(JSON.stringify(value)), /exactly one package/);
  }
});

test("package script rejects npm pack JSON without a tarball filename", () => {
  assert.throws(() => parsePackedTarball(""), /did not report a tarball filename/);
  assert.throws(() => parsePackedTarball(JSON.stringify({ sporades: { name: "sporades" } })), /did not include/);
});

test("package script derives release tags from semver versions", () => {
  assert.equal(releaseTagForVersion("1.2.3"), "v1.2.3");
  assert.throws(() => releaseTagForVersion("1.2.3-beta.1"), /non-semver/);
});

test("package script uses matching release commit and tag messages", () => {
  assert.equal(releaseCommitMessage("v1.2.3"), "Release v1.2.3");
});

test("package script rejects dirty working trees", () => {
  assert.doesNotThrow(() => assertCleanWorkingTree(""));
  assert.throws(() => assertCleanWorkingTree(" M package.json\n"), /dirty working tree/);
});

test("package script requires a synchronized upstream branch", () => {
  assert.doesNotThrow(() => assertSynchronizedUpstream("main", "origin/main", "0\t0\n"));
  assert.throws(() => assertSynchronizedUpstream("", "", "0 0"), /detached HEAD/);
  assert.throws(() => assertSynchronizedUpstream("main", "", "0 0"), /without a configured upstream/);
  assert.throws(() => assertSynchronizedUpstream("main", "origin/main", "1\t0"), /ahead 1, behind 0/);
  assert.throws(() => assertSynchronizedUpstream("main", "origin/main", "0\t2"), /ahead 0, behind 2/);
  assert.throws(() => assertSynchronizedUpstream("main", "origin/main", "wat"), /Could not determine divergence/);
});

test("package script rejects already published target versions", () => {
  assert.doesNotThrow(() => assertVersionNotPublished("sporades", "0.2.0", { code: 1, stdout: "", stderr: "E404" }));
  assert.throws(
    () => assertVersionNotPublished("sporades", "0.2.0", { code: 0, stdout: "0.2.0\n", stderr: "" }),
    /already exists on npm/,
  );
  assert.throws(
    () => assertVersionNotPublished("sporades", "0.2.0", { code: 1, stdout: "", stderr: "E401" }),
    /Could not check/,
  );
});

test("package script rejects existing release tags", () => {
  assert.doesNotThrow(() => assertReleaseTagAvailable("v0.2.0", { code: 1, stdout: "", stderr: "" }));
  assert.throws(() => assertReleaseTagAvailable("v0.2.0", { code: 0, stdout: "abc123\n", stderr: "" }), /already exists/);
});

test("package script rejects existing or unverifiable remote release tags", () => {
  assert.doesNotThrow(() =>
    assertRemoteReleaseTagAvailable("v0.2.0", "origin", { code: 2, stdout: "", stderr: "" }),
  );
  assert.throws(
    () =>
      assertRemoteReleaseTagAvailable("v0.2.0", "origin", {
        code: 0,
        stdout: "abc123\trefs/tags/v0.2.0\n",
        stderr: "",
      }),
    /already exists on origin/,
  );
  assert.throws(
    () => assertRemoteReleaseTagAvailable("v0.2.0", "origin", { code: 128, stdout: "", stderr: "offline" }),
    /Could not check Git tag/,
  );
});

test("package script recovery requires the release commit on upstream", () => {
  assert.doesNotThrow(() => assertReleaseCommitOnUpstream("main", "origin/main", { code: 0 }));
  assert.throws(() => assertReleaseCommitOnUpstream("main", "origin/main", { code: 1 }), /not contained/);
});

test("package script resolves detached recovery through an explicit branch and remote", () => {
  assert.deepEqual(detachedReleaseUpstream(["origin"], "", "main"), {
    branch: "HEAD",
    mergeRef: "refs/heads/main",
    remote: "origin",
    upstream: "origin/main",
  });
  assert.deepEqual(detachedReleaseUpstream(["upstream", "mirror"], "upstream", "release"), {
    branch: "HEAD",
    mergeRef: "refs/heads/release",
    remote: "upstream",
    upstream: "upstream/release",
  });
  assert.throws(() => detachedReleaseUpstream(["origin"], "", ""), /requires --branch/);
  assert.throws(() => detachedReleaseUpstream(["one", "two"], "", "main"), /unambiguous Git remote/);
  assert.throws(() => detachedReleaseUpstream(["origin"], "", "main", "upstream"), /not configured/);
});

test("package script recovery verifies published artifact provenance", () => {
  const artifact = { filename: "sporades-1.2.3.tgz", shasum: "abc123", integrity: "sha512-example" };
  assert.equal(
    assertPublishedArtifactMatches(
      "sporades",
      "1.2.3",
      {
        code: 0,
        stdout: JSON.stringify({ "dist.shasum": "abc123", "dist.integrity": "sha512-example" }),
        stderr: "",
      },
      artifact,
    ),
    true,
  );
  assert.equal(
    assertPublishedArtifactMatches(
      "sporades",
      "1.2.3",
      { code: 1, stdout: "", stderr: "npm error code E404" },
      artifact,
    ),
    false,
  );
  assert.throws(
    () =>
      assertPublishedArtifactMatches(
        "sporades",
        "1.2.3",
        {
          code: 0,
          stdout: JSON.stringify({ "dist.shasum": "different", "dist.integrity": "sha512-example" }),
          stderr: "",
        },
        artifact,
      ),
    /does not match the exact local release artifact/,
  );
});

test("package script recovery resolves annotated and lightweight remote tags", () => {
  assert.equal(
    remoteTagTarget("v1.2.3", {
      code: 0,
      stdout: "tag-object\trefs/tags/v1.2.3\ncommit-id\trefs/tags/v1.2.3^{}\n",
      stderr: "",
    }),
    "commit-id",
  );
  assert.equal(
    remoteTagTarget("v1.2.3", { code: 0, stdout: "commit-id\trefs/tags/v1.2.3\n", stderr: "" }),
    "commit-id",
  );
  assert.equal(remoteTagTarget("v1.2.3", { code: 0, stdout: "", stderr: "" }), null);
  assert.doesNotThrow(() => assertReleaseTagTargetsHead("v1.2.3", "commit-id\n", "commit-id\n"));
  assert.throws(() => assertReleaseTagTargetsHead("v1.2.3", "commit-a", "commit-b"), /does not target/);
});

test("package script bounds npm registry calls instead of retrying silently", () => {
  assert.deepEqual(npmRegistryArgs, ["--fetch-retries=0", "--fetch-timeout=30000"]);
});

test("package script bails with a status hint when the npm login check fails", () => {
  assert.equal(assertNpmAuthenticated({ code: 0, stdout: "mgscox\n", stderr: "" }), "mgscox");
  assert.throws(
    () => assertNpmAuthenticated({ code: 1, stdout: "", stderr: "npm error code E503\n" }),
    /Could not confirm the npm login \(npm whoami\): npm exited with code 1:\nnpm error code E503\nCheck https:\/\/status\.npmjs\.org/,
  );
  assert.throws(
    () => assertNpmAuthenticated({ code: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: true }),
    /npm timed out after 60s\.\nCheck https:\/\/status\.npmjs\.org/,
  );
  assert.throws(() => assertNpmAuthenticated({ code: 0, stdout: "", stderr: "" }), /npm whoami/);
});

test("package script reports registry failures with exit details", () => {
  assert.match(
    describeRegistryFailure({ code: null, signal: "SIGKILL", stdout: "", stderr: "" }),
    /^npm exited with code signal SIGKILL\./,
  );
  assert.throws(
    () => nextReleaseVersion("0.5.0", "patch", { code: 1, stdout: "", stderr: "npm error code E503" }),
    /published package version: npm exited with code 1:\nnpm error code E503\nCheck https:\/\/status\.npmjs\.org/,
  );
});

test("package script rejects ambiguous or unknown options", () => {
  assert.throws(() => parsePackageArgs(["--major", "--patch"]), /Choose exactly one/);
  assert.throws(() => parsePackageArgs(["--prerelease"]), /Unknown packaging option/);
});

test("package script exposes usage text", () => {
  assert.equal(parsePackageArgs(["--help"]).help, true);
  assert.match(usage(), /Default bump: --minor/);
  assert.match(usage(), /Updates CHANGES\.md/);
  assert.match(usage(), /Commits release metadata/);
  assert.match(usage(), /annotated vX\.Y\.Z tag/);
  assert.match(usage(), /match its fetched upstream/);
  assert.match(usage(), /--resume/);
  assert.match(usage(), /detached HEAD/i);
});

test("change generator categorizes release-note entries", () => {
  assert.equal(categorizeChange({ subject: "Add public SDK docs" }), "features");
  assert.equal(categorizeChange({ subject: "Fix stale binding cleanup" }), "fixes");
  assert.equal(categorizeChange({ subject: "Document Container SSH access", files: ["docs/user-guide.md"] }), "documentation");
  assert.equal(categorizeChange({ subject: "Update package script", files: ["scripts/package.mjs"] }), "packaging");
  assert.equal(categorizeChange({ subject: "feat!: remove legacy flag", body: "BREAKING CHANGE: flag removed" }), "breaking");
});

test("change generator includes working tree changes", () => {
  const entries = buildChangeEntries([], [
    { status: "M", file: "package.json" },
    { status: "??", file: "test/package-script.test.js" },
    { status: "??", file: "skills/generate-changes/scripts/generate-changes.mjs" },
  ]);

  assert.deepEqual(entries.packaging, ["Update packaging files in the working tree: package.json."]);
  assert.deepEqual(entries.tests, ["Update tests files in the working tree: test/package-script.test.js."]);
  assert.deepEqual(entries.improvements, ["Update working tree files: skills/generate-changes/scripts/generate-changes.mjs."]);
});

test("change generator describes tagged release baselines", async () => {
  const changes = await generateChanges({
    baseline: { ref: "v1.2.3", label: "v1.2.3", kind: "tag" },
    commits: [],
    workingTreeChanges: [],
    date: "2026-07-07",
    write: false,
  });

  assert.match(changes, /Changes since v1\.2\.3\./);
  assert.doesNotMatch(changes, /No release tag was found/);
});

test("packaged release notes survive regeneration and the next release", async () => {
  const options = {
    baseline: { ref: "v0.9.35", label: "v0.9.35", kind: "tag" },
    commits: [{ hash: "abc123", subject: "Add runtime-owned ctx.ai client (#276)" }],
    workingTreeChanges: [],
    date: "2026-10-22",
    releaseVersion: "0.9.36",
    existing: "# Changes\n\n## Unreleased - 2026-10-21\n\nDraft detail.\n\n## v0.9.35 - 2026-10-20\n\nPrevious release.\n",
    write: false,
  };
  const released = await generateChanges(options);
  assert.match(released, /^# Changes\n\n## v0\.9\.36 - 2026-10-22/);
  assert.doesNotMatch(released, /Draft detail/);

  const nextOptions = {
    ...options,
    baseline: { ref: "v0.9.36", label: "v0.9.36", kind: "tag" },
    commits: [],
    existing: released,
  };
  const draft = await generateChanges({ ...nextOptions, releaseVersion: undefined });
  assert.match(draft, /^# Changes\n\n## Unreleased/);
  assert.match(draft, /## v0\.9\.36[\s\S]*ctx\.ai[\s\S]*#276/);

  const nextRelease = await generateChanges({ ...nextOptions, existing: draft, releaseVersion: "0.9.37" });
  assert.match(nextRelease, /^# Changes\n\n## v0\.9\.37 - 2026-10-22/);
  assert.match(nextRelease, /No changes detected\.[\s\S]*## v0\.9\.36[\s\S]*ctx\.ai[\s\S]*#276/);
  assert.match(nextRelease, /## v0\.9\.35[\s\S]*Previous release/);
  assert.doesNotMatch(nextRelease, /## Unreleased/);
  const directRelease = await generateChanges({ ...nextOptions, releaseVersion: "0.9.37" });
  assert.equal(directRelease.trimEnd(), nextRelease.trimEnd());
});

test("change generator preserves a versioned release section when adding Unreleased notes", () => {
  const existing = `# Changes\n\n## v1.2.3 - 2026-09-01\n\nRequired release detail.\n\n## v1.2.2 - 2026-08-01\n\nOlder detail.\n`;
  const next = upsertTopSection(existing, "## Unreleased - 2026-09-02\n\nNo changes detected.");

  assert.match(next, /^# Changes\n\n## Unreleased - 2026-09-02/);
  assert.match(next, /## v1\.2\.3[\s\S]*Required release detail/);
  assert.match(next, /## v1\.2\.2[\s\S]*Older detail/);
});

test("change generator replaces only the existing top Unreleased section", () => {
  const existing = `# Changes\n\n## Unreleased - 2026-09-01\n\nOld generated detail.\n\n## v1.2.3 - 2026-08-01\n\nRequired release detail.\n`;
  const next = upsertTopSection(existing, "## Unreleased - 2026-09-02\n\nNew generated detail.");

  assert.doesNotMatch(next, /Old generated detail/);
  assert.match(next, /New generated detail/);
  assert.match(next, /## v1\.2\.3[\s\S]*Required release detail/);
});
