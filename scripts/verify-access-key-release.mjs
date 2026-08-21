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
let parsedPostgres;
try { parsedPostgres = new URL(postgresUrl); }
catch { throw new Error("SPORADES_POSTGRES_TEST_URL must be a valid PostgreSQL URL; its value was not logged."); }
if (!/^postgres(?:ql)?:$/.test(parsedPostgres.protocol)) {
  throw new Error("SPORADES_POSTGRES_TEST_URL must use the PostgreSQL URL scheme.");
}
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
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${label} failed with exit code ${result.status}.`);
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
  const suite = run(process.execPath, [
    "--test",
    "--test-concurrency=1",
    "--test-reporter=junit",
    `--test-reporter-destination=${junitPath}`,
  ], "complete test suite", { allowFailure: true });

  const junit = readFileSync(junitPath, "utf8");
  const decodeXml = (value) => value
    .replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const testcase = (attributes, body = "") => {
    const name = decodeXml(/\bname="([^"]*)"/.exec(attributes)?.[1] ?? "");
    const skipped = /<skipped\b([^>]*)\/?>(?:<\/skipped>)?/.exec(body);
    return {
      name,
      skipped: Boolean(skipped),
      skipType: skipped ? decodeXml(/\btype="([^"]*)"/.exec(skipped[1])?.[1] ?? "skipped") : null,
      reason: skipped ? decodeXml(/\bmessage="([^"]*)"/.exec(skipped[1])?.[1] ?? "") : null,
      failed: /<failure\b/.test(body) || /<error\b/.test(body),
    };
  };
  const testcases = [...junit.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)]
    .map((match) => testcase(match[1], match[2] ?? ""));
  const suites = [...junit.matchAll(/<testsuite\b([^>]*)>/g)].map((match) => ({
    name: decodeXml(/\bname="([^"]*)"/.exec(match[1])?.[1] ?? ""),
    tests: Number(/\btests="(\d+)"/.exec(match[1])?.[1] ?? -1),
    disabled: Number(/\bdisabled="(\d+)"/.exec(match[1])?.[1] ?? -1),
    errors: Number(/\berrors="(\d+)"/.exec(match[1])?.[1] ?? -1),
    failures: Number(/\bfailures="(\d+)"/.exec(match[1])?.[1] ?? -1),
    skipped: Number(/\bskipped="(\d+)"/.exec(match[1])?.[1] ?? -1),
  }));
  const successfulSuites = suites
    .filter((suite) => suite.tests > 0 && suite.disabled === 0 && suite.errors === 0 && suite.failures === 0 && suite.skipped === 0)
    .map(({ name }) => name);
  const allowedOptionalSmoke = (name) =>
    name === "ctx.mail sends through Mailjet's generic authenticated STARTTLS endpoint" ||
    name.startsWith("real Container serves a complete ") ||
    name === "real browser clicks the generated Facebook control and performs a top-level protocol redirect" ||
    name.startsWith("sporades host bootstrap can run against an opt-in real SSH Host server") ||
    name.startsWith("sporades host register can run against an opt-in real SSH Host server") ||
    name.startsWith("sporades host logs can read a real Host server") ||
    name.startsWith("sporades host list can run against an opt-in real SSH Host server") ||
    name.startsWith("sporades host push can restart a real Hosted Capsule") ||
    name === "sporades deploy does not require changing local runtime data ownership" ||
    name === "sporades host helper reports remediation when data ownership cannot be prepared" ||
    name === "Microsoft discovery accepts an exact IPv6 loopback override when IPv6 is available";
  const skippedCases = testcases.filter((entry) => entry.skipped);
  const failedCases = testcases.filter((entry) => entry.failed);
  const todoCases = skippedCases.filter((entry) => entry.skipType === "todo");
  const unexplainedSkips = skippedCases.filter((entry) => entry.skipType === "todo" || !allowedOptionalSmoke(entry.name));
  if (todoCases.length || unexplainedSkips.length) {
    throw new Error(`Release verification found non-allowlisted skips/todos: ${JSON.stringify(unexplainedSkips)}`);
  }
  const requiredCases = [
    "a linked Session carries one scoped canary through real Dev and fresh Container runtimes",
    "Database adapter conformance (auth storage): SQLite",
    "Database adapter conformance (auth storage): libSQL",
    "Database adapter conformance (auth storage): Postgres",
    "Access-key Job lifecycle is stable across PostgreSQL restart",
    "every statement the runtime storage bootstrap emits quotes the identifiers it names",
    "every statement the conformance specification drives the adapter to emit quotes the identifiers it names",
    "the generated Bundle runs audited Access-key operator actions without credential material",
    "the packed package exposes the complete server and client Access-key contract",
  ];
  const missingRequiredCases = requiredCases.filter((name) =>
    !successfulSuites.includes(name) && !testcases.some((entry) => entry.name === name && !entry.skipped && !entry.failed));
  if (missingRequiredCases.length) {
    throw new Error(`Release verification did not execute required cases: ${JSON.stringify(missingRequiredCases)}`);
  }
  const metric = (name) => Number(new RegExp(`<!-- ${name} (\\d+) -->`).exec(junit)?.[1] ?? NaN);
  const totals = Object.fromEntries(["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"].map((name) => [name, metric(name)]));
  const metricsAreValid = Object.values(totals).every((value) => Number.isInteger(value) && value >= 0);
  const accountedTests = totals.pass + totals.fail + totals.cancelled + totals.skipped + totals.todo;
  if (!metricsAreValid || totals.tests !== accountedTests || totals.tests !== testcases.length + suites.length ||
    totals.fail !== 0 || totals.cancelled !== 0 || totals.todo !== 0 || totals.skipped !== skippedCases.length) {
    throw new Error(`Invalid or failing JUnit summary: ${JSON.stringify({ suiteExitCode: suite.status, totals, failedCases: failedCases.map(({ name }) => name) })}`);
  }
  if (suite.status !== 0) throw new Error(`Complete test suite exited ${suite.status} despite a passing JUnit summary.`);
  const decodedJunit = decodeXml(junit.replaceAll("<![CDATA[", "").replaceAll("]]>", ""));
  const acceptanceDiagnosticText = /\{"devPort":\d+,"containerPort":\d+,"userId":"[^"]+","keyId":"[^"]+","jobId":"[^"]+","hostedActionContract":"cli-to-host-helper-to-container-exec-to-generated-bundle","scannedBearerCount":\d+,"retainedBearerFiles":\d+\}/.exec(decodedJunit)?.[0];
  if (!acceptanceDiagnosticText) throw new Error("Release acceptance did not emit its safe diagnostic evidence.");
  const acceptanceEvidence = JSON.parse(acceptanceDiagnosticText);
  if (acceptanceEvidence.scannedBearerCount < 1 || acceptanceEvidence.retainedBearerFiles !== 0) {
    throw new Error("Release acceptance bearer-retention evidence was incomplete.");
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    node: process.version,
    dockerServer: dockerVersion,
    postgres: postgresIdentity,
    acceptance: "required",
    generatedManifest: "passed",
    documentationBuild: "passed",
    allowedOptionalSkips: skippedCases.map(({ name, reason }) => ({ name, reason })),
    acceptanceEvidence,
    totals,
  })}\n`);
} finally {
  rmSync(evidenceDir, { recursive: true, force: true });
}
