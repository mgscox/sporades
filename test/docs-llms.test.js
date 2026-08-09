import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { generateLlmsDocumentation, SPORADES_LLMS_SECTIONS } from "../scripts/generate-llms-docs.mjs";

test("LLM documentation publishes the split feature reference as focused sources", () => {
  const reference = SPORADES_LLMS_SECTIONS.find(({ heading }) => heading === "Reference");
  assert.deepEqual(reference.entries.map(({ path }) => path).filter(Boolean), [
    "guide/reference.md",
    "reference/projects-and-configuration.md",
    "reference/server-runtime.md",
    "reference/jobs-and-schedules.md",
    "reference/client-auth-and-preferences.md",
    "reference/files-and-realtime.md",
    "reference/operations-and-hosting.md",
    "sdk-documentation.md",
  ]);
});

test("LLM documentation publishes a curated manifest and release-local Markdown sources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-llms-"));
  const docsDir = path.join(root, "docs");
  const outputDir = path.join(root, "dist");

  try {
    for (const relativePath of [
      "user-guide.md",
      "guide/getting-started.md",
      "guide/server.md",
      "guide/reference.md",
      "architecture.md",
    ]) {
      const target = path.join(docsDir, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `# ${relativePath}\n`, "utf8");
    }

    await generateLlmsDocumentation({
      docsDir,
      outputDir,
      siteUrl: "https://example.test/sporades",
      sections: [
        {
          heading: "Start",
          entries: [
            { title: "User guide", path: "user-guide.md", description: "Start here." },
            { title: "First Capsule", path: "guide/getting-started.md", description: "Tutorial." },
          ],
        },
        {
          heading: "Build",
          entries: [{ title: "Server", path: "guide/server.md", description: "Server guide." }],
        },
        {
          heading: "Reference",
          entries: [
            { title: "Reference", path: "guide/reference.md", description: "Exhaustive lookup." },
          ],
        },
        {
          heading: "Optional",
          entries: [
            { title: "Architecture", path: "architecture.md", description: "Internals." },
            { title: "API", url: "https://example.test/sporades/api/", description: "Generated reference." },
          ],
        },
      ],
    });

    const manifest = await readFile(path.join(outputDir, "llms.txt"), "utf8");
    assert.match(manifest, /^# Sporades\n\n> /);
    assert.match(manifest, /## Start\n\n- \[User guide\]\(https:\/\/example\.test\/sporades\/llms\/user-guide\.md\): Start here\./);
    assert.match(manifest, /## Optional/);
    assert.match(manifest, /## Reference/);
    assert.match(manifest, /\[API\]\(https:\/\/example\.test\/sporades\/api\/\): Generated reference\./);
    assert.doesNotMatch(manifest, /PRD|ROADMAP|\.scratch/);

    for (const relativePath of ["user-guide.md", "guide/getting-started.md", "guide/server.md", "guide/reference.md", "architecture.md"]) {
      assert.equal(
        await readFile(path.join(outputDir, "llms", relativePath), "utf8"),
        `# ${relativePath}\n`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
