import assert from "node:assert/strict";
import { test } from "node:test";

import { buildChangeEntries, categorizeChange, generateChanges } from "../skills/generate-changes/scripts/generate-changes.mjs";
import { bumpVersion, parsePackageArgs, releaseTagForVersion, usage } from "../scripts/package.mjs";

test("package script defaults to a minor version bump", () => {
  assert.deepEqual(parsePackageArgs([]), { help: false, releaseType: "minor" });
});

test("package script accepts explicit semver bump flags", () => {
  assert.equal(parsePackageArgs(["--major"]).releaseType, "major");
  assert.equal(parsePackageArgs(["--minor"]).releaseType, "minor");
  assert.equal(parsePackageArgs(["--patch"]).releaseType, "patch");
});

test("package script bumps semver versions", () => {
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
});

test("package script derives release tags from semver versions", () => {
  assert.equal(releaseTagForVersion("1.2.3"), "v1.2.3");
  assert.throws(() => releaseTagForVersion("1.2.3-beta.1"), /non-semver/);
});

test("package script rejects ambiguous or unknown options", () => {
  assert.throws(() => parsePackageArgs(["--major", "--patch"]), /Choose exactly one/);
  assert.throws(() => parsePackageArgs(["--prerelease"]), /Unknown packaging option/);
});

test("package script exposes usage text", () => {
  assert.equal(parsePackageArgs(["--help"]).help, true);
  assert.match(usage(), /Default bump: --minor/);
  assert.match(usage(), /Updates CHANGES\.md/);
  assert.match(usage(), /annotated vX\.Y\.Z Git tag/);
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
