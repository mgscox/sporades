import { cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { generateLlmsDocumentation } from "./generate-llms-docs.mjs";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

execFileSync(npmCommand, ["run", "docs:api"], { stdio: "inherit" });

execFileSync(process.execPath, ["./node_modules/vitepress/bin/vitepress.js", "build", "docs"], {
  stdio: "inherit",
});

cpSync("docs/api", "docs/.vitepress/dist/api", { recursive: true });

await generateLlmsDocumentation({
  docsDir: "docs",
  outputDir: "docs/.vitepress/dist",
  siteUrl: "https://mgscox.github.io/sporades",
});
