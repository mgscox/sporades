// Shared by publish.yml and local tests. Never infer the bump from PRs or titles.
import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { packageForNpm } from "./package.mjs";

const repository = "mgscox/sporades";
const releaseLabels = new Map([ ["release:patch", "patch"], ["release:minor", "minor"], ["release:major", "major"] ]);
export const agentMarker = "<!-- cubefarm:agent -->";

export async function guardReleaseIssue({ github, context }) {
  const deny = reason => ({ allowed: false, reason });
  const event = context.payload;
  if (`${context.repo.owner}/${context.repo.repo}` !== repository) return deny("Release automation is restricted to mgscox/sporades.");
  if (context.eventName !== "issues" || event.action !== "labeled") return deny("Expected an issue label event.");
  const bump = releaseLabels.get(event.label?.name);
  if (!bump) return deny("This label does not request a release; use release:patch, release:minor or release:major.");
  if (event.issue?.state !== "open" || event.issue?.pull_request) return deny("A release requires an open issue.");
  const sender = event.sender?.login;
  if (!sender) return deny("The label event has no sender.");
  if (sender !== "mgscox") {
    try {
      const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ ...context.repo, username: sender });
      if (data.permission !== "admin") return deny("Only mgscox or a repository administrator may request a release.");
    } catch {
      return deny("Could not verify repository administrator permission; release denied.");
    }
  }
  // Check current state as well as the event snapshot: queued/rerun events can be stale.
  let issue;
  try {
    ({ data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: event.issue.number }));
  } catch {
    return deny("Could not read the current issue state; release denied.");
  }
  if (issue.state !== "open" || issue.pull_request) return deny("The release issue is no longer open.");
  const labels = issue.labels.map(label => typeof label === "string" ? label : label.name).filter(label => releaseLabels.has(label));
  if (labels.length !== 1 || labels[0] !== event.label.name) return deny("Apply exactly one release label matching this event. Remove conflicting labels before retrying.");
  return { allowed: true, bump, reason: `Authorized ${bump} release from issue #${event.issue.number}.` };
}

export function releaseIssueTrailer(issueNumber, bump) {
  if (!Number.isSafeInteger(Number(issueNumber)) || Number(issueNumber) <= 0 || ![...releaseLabels.values()].includes(bump)) {
    throw new Error("Expected a positive release issue number and an explicit patch, minor or major bump.");
  }
  return `Release-Issue: https://github.com/${repository}/issues/${Number(issueNumber)}\nRelease-Bump: ${bump}`;
}

export function findIssueRelease(issueNumber, bump, { cwd = process.cwd() } = {}) {
  const trailer = releaseIssueTrailer(issueNumber, bump);
  const issueLine = trailer.split("\n")[0];
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commits = git("log", "origin/main", "--format=%H", "--fixed-strings", `--grep=${issueLine}`).split("\n").filter(Boolean);
  const matches = commits.filter(commit => git("show", "-s", "--format=%B", commit).split("\n").includes(issueLine));
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error("Multiple release commits reference this issue; inspect before retrying.");
  const commit = matches[0];
  const message = git("show", "-s", "--format=%B", commit);
  if (!message.includes(trailer)) throw new Error("This issue already prepared a different bump; retry its original release tag.");
  const tag = /^Release (v\d+\.\d+\.\d+)\n/.exec(message)?.[1];
  if (!tag || git("cat-file", "-t", `refs/tags/${tag}`) !== "tag" || git("rev-parse", `refs/tags/${tag}^{commit}`) !== commit) {
    throw new Error("The issue's release tag is missing or mismatched; inspect before retrying. Never move a published tag.");
  }
  return tag;
}

export async function prepareIssueRelease(issueNumber, bump) {
  // The checkout is main with full history. The shared packaging command checks
  // canonical upstream, synchronization, registry state and atomic push safety.
  execFileSync("git", ["fetch", "--tags", "origin"], { stdio: "inherit" });
  const existing = findIssueRelease(issueNumber, bump);
  if (existing) return existing;
  return packageForNpm(["--ci-publish", `--${bump}`], { commitTrailer: releaseIssueTrailer(issueNumber, bump) });
}

export async function reportIssueRelease({ github, context, tag, prepareResult, publishResult }) {
  const success = prepareResult === "success" && publishResult === "success";
  const runUrl = `https://github.com/${repository}/actions/runs/${context.runId}`;
  const version = /^v\d+\.\d+\.\d+$/.test(tag ?? "") ? tag.slice(1) : null;
  const body = success && version
    ? `Published Sporades ${version}: https://www.npmjs.com/package/sporades/v/${version}\n\nVerified release run: ${runUrl}`
    : `Sporades release${version ? ` ${version}` : ""} failed or was cancelled (prepare: ${prepareResult}, publish: ${publishResult}). Inspect the run: ${runUrl}\n\nLeave this issue open. Retry the failed workflow using the same tag if preparation pushed it; never move a published tag. If source changes are required, merge the fix and request a new patch release in a new issue.`;
  await github.rest.issues.createComment({ ...context.repo, issue_number: context.payload.issue.number, body: `${body}\n\n${agentMarker}` });
  if (success && version) await github.rest.issues.update({ ...context.repo, issue_number: context.payload.issue.number, state: "closed" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const tag = await prepareIssueRelease(process.env.RELEASE_ISSUE, process.env.RELEASE_BUMP);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
    console.log(`Prepared ${tag}; publication is pending.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
