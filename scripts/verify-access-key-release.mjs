import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor !== 22) {
  throw new Error(`Access-key release verification requires Node 22; received ${process.version}.`);
}

const postgresUrl = process.env.SPORADES_POSTGRES_TEST_URL;
if (!postgresUrl) {
  throw new Error("SPORADES_POSTGRES_TEST_URL must identify the dedicated PostgreSQL test database.");
}
const parsedPostgres = new URL(postgresUrl);
const databaseName = parsedPostgres.pathname.replace(/^\//, "");
if (!databaseName || databaseName === "postgres") {
  throw new Error("SPORADES_POSTGRES_TEST_URL must name a dedicated non-default PostgreSQL test database.");
}
const postgresIdentity = `${parsedPostgres.hostname}:${parsedPostgres.port || "5432"}/${databaseName}`;

const commandEnv = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
  SPORADES_ACCESS_KEY_ACCEPTANCE: "1",
};

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: commandEnv,
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
  return result;
}

const dockerVersion = execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
  cwd: root,
  env: commandEnv,
  encoding: "utf8",
}).trim();

const evidenceDir = mkdtempSync(path.join(tmpdir(), "sporades-access-key-release-"));
const junitPath = path.join(evidenceDir, "full-suite.xml");
try {
  run("npm", ["run", "build"], "generated build");
  run(process.execPath, ["scripts/check-generated-bin.mjs"], "generated Bundle freshness");
  run("npm", ["run", "docs:build"], "documentation build");
  run(process.execPath, [
    "--test",
    "--test-concurrency=1",
    "--test-reporter=junit",
    `--test-reporter-destination=${junitPath}`,
  ], "complete test suite");

  const junit = readFileSync(junitPath, "utf8");
  for (const forbiddenSkip of [
    "Set SPORADES_POSTGRES_TEST_URL",
    "Set SPORADES_ACCESS_KEY_ACCEPTANCE=1",
  ]) {
    if (junit.includes(forbiddenSkip)) throw new Error(`Mandatory release proof was skipped: ${forbiddenSkip}`);
  }
  const metric = (name) => Number(new RegExp(`<!-- ${name} (\\d+) -->`).exec(junit)?.[1] ?? NaN);
  const totals = Object.fromEntries(["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"].map((name) => [name, metric(name)]));
  if (!Number.isInteger(totals.tests) || totals.fail !== 0 || totals.cancelled !== 0) {
    throw new Error(`Invalid or failing JUnit summary: ${JSON.stringify(totals)}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    node: process.version,
    dockerServer: dockerVersion,
    postgres: postgresIdentity,
    acceptance: "required",
    generatedManifest: "passed",
    documentationBuild: "passed",
    totals,
  })}\n`);
} finally {
  rmSync(evidenceDir, { recursive: true, force: true });
}
