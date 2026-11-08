import { execFileSync } from "node:child_process";

const [flag, ...extra] = process.argv.slice(2);
if (!["--patch", "--minor", "--major"].includes(flag) || extra.length > 0) {
  console.error("Usage: npm run gh-package -- <--patch|--minor|--major>");
  process.exit(1);
}

const bump = flag.slice(2);
const repo = "mgscox/sporades";
try {
  const issueUrl = execFileSync("gh", [
    "issue", "create", "--repo", repo,
    "--title", "Release Sporades",
    "--body", `Requested version bump: ${bump}`,
    "--label", "ready-for-human",
  ], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] }).trim();
  console.log(issueUrl);
  execFileSync("gh", [
    "issue", "edit", issueUrl, "--repo", repo, "--add-label", `release:${bump}`,
  ], { stdio: ["inherit", "ignore", "inherit"] });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
