#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const changesPath = path.join(repoRoot, "CHANGES.md");

const categoryOrder = [
  "breaking",
  "features",
  "fixes",
  "improvements",
  "documentation",
  "tests",
  "packaging",
];

const categoryHeadings = {
  breaking: "### ⚠️ Breaking Changes",
  features: "### 🚀 Features",
  fixes: "### 🐛 Bug Fixes",
  improvements: "### 🔧 Improvements",
  documentation: "### 📝 Documentation",
  tests: "### 🧪 Tests",
  packaging: "### 📦 Packaging",
};

function normalizeSubject(subject) {
  return subject
    .replace(/^(feat|feature|fix|bugfix|docs|doc|test|tests|chore|refactor|perf|build|ci|release)(\(.+\))?!?:\s*/i, "")
    .replace(/^[A-Z][a-z]+:\s+/, "")
    .trim();
}

function sentenceCase(text) {
  if (!text) {
    return text;
  }
  return `${text[0].toUpperCase()}${text.slice(1)}`;
}

function hasBreakingMarker(subject, body = "") {
  return /breaking change|breaking:/i.test(body) || /^[a-z]+(\(.+\))?!:/i.test(subject);
}

export function categorizeChange({ subject, files = [], body = "" }) {
  const lowered = subject.toLowerCase();
  const fileText = files.join("\n").toLowerCase();

  if (hasBreakingMarker(subject, body)) {
    return "breaking";
  }
  if (/^(feat|feature)(\(.+\))?!?:/i.test(subject) || /^(add|allow|enable|implement|create|introduce)\b/i.test(subject)) {
    return "features";
  }
  if (/^(fix|bugfix)(\(.+\))?!?:/i.test(subject) || /^(fix|prevent|repair|correct|restore)\b/i.test(subject)) {
    return "fixes";
  }
  if (/^(docs?|documentation)(\(.+\))?:/i.test(subject) || /\b(document|docs?|readme|prd|adr)\b/i.test(lowered) || fileText.includes("docs/") || fileText.includes("readme")) {
    return "documentation";
  }
  if (/^(build|ci|release)(\(.+\))?:/i.test(subject) || /\b(package|publish|release|npm|tarball)\b/i.test(lowered) || fileText.includes("package.json") || fileText.includes("package-lock.json") || fileText.includes("scripts/package")) {
    return "packaging";
  }
  if (/^(test|tests)(\(.+\))?:/i.test(subject) || /\b(test|coverage)\b/i.test(lowered) || fileText.includes("test/")) {
    return "tests";
  }
  return "improvements";
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

async function git(args, options = {}) {
  const { stdout } = await execFile("git", args, {
    cwd: repoRoot,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function getLatestReleaseTag() {
  const tags = await git(["tag", "--merged", "HEAD", "--sort=-creatordate"]);
  return tags
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .find((tag) => /^v?\d+\.\d+\.\d+([.-].*)?$/.test(tag)) ?? null;
}

async function getLatestReleaseLikeCommit() {
  const raw = await git([
    "log",
    "--no-merges",
    "--pretty=format:%h%x1f%s",
  ]);
  if (!raw) {
    return null;
  }

  for (const line of raw.split("\n")) {
    const [hash, subject] = line.split("\x1f");
    if (/\b(publish|publishing|published)\b/i.test(subject) || /^release\b/i.test(subject) || /^prepare\b.*\brelease\b/i.test(subject)) {
      return { ref: hash, label: `${hash} ${subject}` };
    }
  }

  return null;
}

async function getReleaseBaseline() {
  const tag = await getLatestReleaseTag();
  if (tag) {
    return { ref: tag, label: tag, kind: "tag" };
  }

  const commit = await getLatestReleaseLikeCommit();
  if (commit) {
    return { ...commit, kind: "commit" };
  }

  return null;
}

function parseLog(raw) {
  if (!raw) {
    return [];
  }

  return raw.split("\x1e").filter(Boolean).map((record) => {
    const [hash, subject, body = "", fileList = ""] = record.split("\x1f");
    const files = fileList.split("\n").map((file) => file.trim()).filter(Boolean);
    return { hash, subject, body, files };
  });
}

async function collectCommitsSince(baseline) {
  const range = baseline ? `${baseline.ref}..HEAD` : "HEAD";
  const raw = await git([
    "log",
    range,
    "--no-merges",
    "--pretty=format:%x1e%h%x1f%s%x1f%b%x1f",
    "--name-only",
  ]);
  return parseLog(raw);
}

function parsePorcelainStatus(raw) {
  return raw.split("\n").filter(Boolean).map((line) => {
    const status = line.slice(0, 2).trim() || "modified";
    const file = line.replace(/^.{2}\s?/, "").trim();
    return { status, file };
  });
}

async function collectWorkingTreeChanges() {
  const raw = await git(["status", "--porcelain=v1"]);
  const changes = [];

  for (const change of parsePorcelainStatus(raw)) {
    if (change.file === "CHANGES.md") {
      continue;
    }

    if (change.status === "??" && change.file.endsWith("/")) {
      const files = await git(["ls-files", "--others", "--exclude-standard", "--", change.file]);
      for (const file of files.split("\n").map((item) => item.trim()).filter(Boolean)) {
        changes.push({ status: "??", file });
      }
      continue;
    }

    changes.push(change);
  }

  return changes;
}

function summarizeWorkingTree(changes) {
  if (changes.length === 0) {
    return [];
  }

  const files = changes.map((change) => change.file);
  const groups = {
    documentation: files.filter((file) => file.startsWith("docs/") || /^README|CHANGES|CHANGELOG/.test(file)),
    tests: files.filter((file) => file.startsWith("test/")),
    packaging: files.filter((file) => file === "package.json" || file === "package-lock.json" || file.startsWith("scripts/package")),
  };

  const summaries = [];
  for (const [category, groupedFiles] of Object.entries(groups)) {
    if (groupedFiles.length > 0) {
      summaries.push({
        category,
        text: `Update ${category} files in the working tree: ${uniqueSorted(groupedFiles).join(", ")}.`,
      });
    }
  }

  const grouped = new Set(Object.values(groups).flat());
  const remaining = files.filter((file) => !grouped.has(file));
  if (remaining.length > 0) {
    summaries.push({
      category: "improvements",
      text: `Update working tree files: ${uniqueSorted(remaining).join(", ")}.`,
    });
  }

  return summaries;
}

export function buildChangeEntries(commits, workingTreeChanges) {
  const entries = Object.fromEntries(categoryOrder.map((category) => [category, []]));

  for (const commit of commits) {
    const category = categorizeChange(commit);
    const summary = sentenceCase(normalizeSubject(commit.subject));
    entries[category].push(`${summary} (${commit.hash}).`);
  }

  for (const item of summarizeWorkingTree(workingTreeChanges)) {
    entries[item.category].push(item.text);
  }

  return entries;
}

function renderGeneratedSection({ date, baseline, commits, workingTreeChanges }) {
  const entries = buildChangeEntries(commits, workingTreeChanges);
  const intro = baseline?.kind === "tag"
    ? `Changes since ${baseline.label}.`
    : baseline?.kind === "commit"
      ? `No release tag was found, so this section uses ${baseline.label} as the last release-like commit.`
      : "No release baseline was found, so this section summarizes all reachable commits plus current working tree changes.";
  const lines = [`## Unreleased - ${date}`, "", intro, ""];

  let hasEntries = false;
  for (const category of categoryOrder) {
    const categoryEntries = entries[category];
    if (categoryEntries.length === 0) {
      continue;
    }

    hasEntries = true;
    lines.push(categoryHeadings[category], "");
    for (const entry of categoryEntries) {
      lines.push(`- ${entry}`);
    }
    lines.push("");
  }

  if (!hasEntries) {
    lines.push("No changes detected.", "");
  }

  return lines.join("\n").trimEnd();
}

function upsertTopSection(existing, section) {
  if (!existing.trim()) {
    return `# Changes\n\n${section}\n`;
  }

  if (!existing.startsWith("# Changes")) {
    return `# Changes\n\n${section}\n\n${existing.trimStart()}`;
  }

  const sectionStart = existing.indexOf("\n## ");
  if (sectionStart === -1) {
    return `${existing.trimEnd()}\n\n${section}\n`;
  }

  const rest = existing.slice(sectionStart + 1);
  const nextSectionMatch = /\n## (?![🚀🐛🔧⚠️📝🧪📦])/.exec(rest);
  const nextSectionStart = nextSectionMatch ? sectionStart + 1 + nextSectionMatch.index : -1;
  const prefix = existing.slice(0, sectionStart).trimEnd();
  const suffix = nextSectionStart === -1 ? "" : existing.slice(nextSectionStart).trimStart();
  return `${prefix}\n\n${section}${suffix ? `\n\n${suffix}` : ""}\n`;
}

export async function generateChanges(options = {}) {
  const baseline = options.baseline ?? await getReleaseBaseline();
  const commits = options.commits ?? await collectCommitsSince(baseline);
  const workingTreeChanges = options.workingTreeChanges ?? await collectWorkingTreeChanges();
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const section = renderGeneratedSection({ date, baseline, commits, workingTreeChanges });
  const existing = existsSync(changesPath) ? await readFile(changesPath, "utf8") : "";
  const next = upsertTopSection(existing, section);

  if (options.write !== false) {
    await writeFile(changesPath, next);
  }

  return next;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateChanges().then(() => {
    console.log("Generated CHANGES.md.");
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
