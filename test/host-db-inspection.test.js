import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteDatabaseAdapter } from "../dist/server-runtime-source.js";
import { createServerBundleModuleSource } from "../dist/templates/server-bundle-module-graph.js";

// `sporades host db` (#285): read-only database inspection of a Hosted Capsule through the Host
// helper and the generated Bundle's one-shot action seam, answering in `sporades db`'s shape.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "sporades.js");
const helper = path.join(root, "bin", "sporades-host-helper.js");

const run = (args, cwd, env = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-host-db-"));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

// A Host whose SSH runs the real Host helper and whose Docker runs `bundle` for `docker exec`, with
// the Capsule database at `databasePath`.
async function installFakeHost(dir, { bundle, databasePath, dockerScript }) {
  const bin = path.join(dir, "fake-bin"), config = path.join(dir, "fake-config");
  const requestLog = path.join(dir, "requests.log"), dockerLog = path.join(dir, "docker.log");
  await mkdir(bin, { recursive: true }); await mkdir(config, { recursive: true });
  await writeFile(path.join(config, "hosts.json"), JSON.stringify({ currentHostAlias: "live", profiles: { live: { server: "host", domain: "example.test", scheme: "https", remoteRoot: "/srv/sporades" } } }));
  await writeFile(path.join(bin, "ssh"), `#!/bin/sh
IFS= read -r input || exit 9
printf '%s\\n' "$input" >> ${JSON.stringify(requestLog)}
printf '%s\\n' "$input" | ${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}
`);
  await writeFile(path.join(bin, "docker"), dockerScript ?? `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(dockerLog)}
if [ "$1" = inspect ]; then echo true; exit 0; fi
if [ "$1" = exec ] && [ "$2" = sporades-example-test-notes ] && [ "$3" = node ] && [ "$4" = /app/server.mjs ]; then
  shift 4
  SPORADES_DATABASE_PATH=${JSON.stringify(databasePath)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(bundle)} "$@"
fi
exit 9
`);
  await chmod(path.join(bin, "ssh"), 0o755); await chmod(path.join(bin, "docker"), 0o755);
  return {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, SPORADES_CONFIG_DIR: config },
    requests: async () => (await readFile(requestLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    dockerCalls: async () => (await readFile(dockerLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean),
  };
}

async function writeFakePackage(projectDir, name, exports, files) {
  const dir = path.join(projectDir, "node_modules", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", type: "module", exports }));
  for (const [file, contents] of Object.entries(files)) await writeFile(path.join(dir, file), contents);
}

function waitForJsonLine(child) {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for Dev.\n${stdout}\n${stderr}`)); }, 20_000);
    const onStdout = (chunk) => { stdout += chunk; const line = stdout.split("\n").find((candidate) => candidate.trim()); if (line) { cleanup(); resolve(JSON.parse(line)); } };
    const onStderr = (chunk) => { stderr += chunk; };
    const onExit = (code) => { cleanup(); reject(new Error(`Dev exited with ${code}.\n${stdout}\n${stderr}`)); };
    function cleanup() { clearTimeout(timeout); child.stdout.off("data", onStdout); child.stderr.off("data", onStderr); child.off("exit", onExit); }
    child.stdout.on("data", onStdout); child.stderr.on("data", onStderr); child.on("exit", onExit);
  });
}

async function findDevActionBundle(projectDir) {
  const actions = path.join(projectDir, ".sporades", "build", ".dev-actions");
  for (const entry of await readdir(actions).catch(() => [])) {
    const candidate = path.join(actions, entry, "server.mjs");
    if (await stat(candidate).then(() => true, () => false)) return candidate;
  }
  return path.join(projectDir, ".sporades", "build", "server.mjs");
}

test("sporades host db answers exactly as sporades db does against the same running Dev database", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "package.json"), '{"type":"commonjs"}\n');
    const created = run(["create", "notes", "--template", "todo", "--no-install", "--no-git", "--json"], dir);
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const projectDir = path.join(dir, "notes");
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFakePackage(projectDir, "react", { ".": "./index.js", "./jsx-runtime": "./jsx-runtime.js" }, {
      "index.js": "export function useEffect() {}\nexport function useState(value) { return [value, () => {}]; }\n",
      "jsx-runtime.js": "export const Fragment = Symbol.for('react.fragment');\nexport function jsx(type, props) { return { type, props }; }\nexport const jsxs = jsx;\n",
    });
    await writeFakePackage(projectDir, "react-dom", { "./client": "./client.js" }, { "client.js": "export function createRoot() { return { render() {} }; }\n" });

    const dev = spawn(process.execPath, [cli, "dev", "--json"], { cwd: projectDir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const started = await waitForJsonLine(dev);
      assert.equal(started.ok, true, JSON.stringify(started.error));
      const databasePath = path.join(projectDir, ".sporades", "data.db");
      // The Dev runtime holds its WAL writer open, as a running Hosted Capsule does. Add rows it
      // has not checkpointed so the Hosted read has to see live WAL content.
      const { DatabaseSync } = await import("node:sqlite");
      const writer = new DatabaseSync(databasePath);
      try {
        const columns = writer.prepare("PRAGMA table_info(todos)").all().map((column) => column.name);
        const now = new Date().toISOString();
        const values = { id: "todo-1", text: "Chase the client", done: 0, createdAt: now, updatedAt: now };
        const insertable = columns.filter((column) => column in values);
        writer.prepare(`INSERT INTO todos (${insertable.join(", ")}) VALUES (${insertable.map(() => "?").join(", ")})`).run(...insertable.map((column) => values[column]));
      } finally { writer.close(); }

      const host = await installFakeHost(dir, { bundle: await findDevActionBundle(projectDir), databasePath });
      const commands = [
        ["list"],
        ["dump"],
        ["query", "SELECT text, count(*) AS total FROM todos GROUP BY text"],
        ["query", "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name"],
        ["query", "SELECT * FROM missing_table"],
        ["query", "DELETE FROM todos"],
        ["query", "UPDATE todos SET text = 'changed'"],
      ];
      for (const command of commands) {
        const local = run(["db", ...command, "--json"], projectDir);
        const hosted = run(["host", "db", ...command, "--host", "live", "--subname", "notes", "--json"], projectDir, host.env);
        assert.equal(hosted.stdout, local.stdout, `host db ${command[0]} must match db ${command[0]} (${command.slice(1).join(" ")})\n${hosted.stderr}`);
        assert.equal(hosted.status, local.status, command.join(" "));
      }

      const list = JSON.parse(run(["host", "db", "list", "--host", "live", "--subname", "notes", "--json"], projectDir, host.env).stdout);
      assert.deepEqual(Object.keys(list.data), ["tables"]);
      assert.ok(list.data.tables.includes("todos"));
      const query = JSON.parse(run(["host", "db", "query", "SELECT text FROM todos", "--subname", "notes", "--json"], projectDir, host.env).stdout);
      assert.deepEqual(query, { ok: true, data: { columns: ["text"], rows: [{ text: "Chase the client" }] }, error: null });

      // Mutating SQL never reaches the Host, and the data is untouched.
      const requests = await host.requests();
      assert.ok(requests.every((request) => !/DELETE|UPDATE/.test(request.db?.sql ?? "")), "the CLI refuses mutating SQL before SSH");
      assert.deepEqual(requests.find((request) => request.action === "db.query").capsule, { subname: "notes" });
      assert.deepEqual(Object.keys(requests.find((request) => request.action === "db.query")), ["action", "host", "capsule", "db"]);
      assert.ok((await host.dockerCalls()).some((call) => /^exec sporades-example-test-notes node \/app\/server\.mjs --sporades-action db\.query --sporades-action-input \S+$/.test(call)));

      // Without --subname or --host, the project's Host binding selects the Capsule.
      await writeFile(path.join(projectDir, ".sporades", "remote-binding.json"), JSON.stringify({ hostAlias: "live", domain: "example.test", scheme: "https", subname: "notes" }));
      const bound = run(["host", "db", "query", "SELECT count(*) AS total FROM todos", "--json"], projectDir, host.env);
      assert.equal(bound.status, 0, bound.stdout);
      assert.deepEqual(JSON.parse(bound.stdout).data.rows, [{ total: 1 }]);

      // Human output matches too.
      assert.equal(run(["host", "db", "list"], projectDir, host.env).stdout, run(["db", "list"], projectDir).stdout);
    } finally {
      dev.kill("SIGTERM");
      await new Promise((resolve) => dev.once("exit", resolve));
    }
  });
});

test("the Bundle's db actions read a live WAL database read-only and refuse mutation themselves", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "server.mjs"), await createServerBundleModuleSource({
      config: { name: "notes" }, serverEnv: {}, serverSource: "", serverModuleSource: "export default {};",
    }));
    await mkdir(path.join(dir, "data"));
    const databasePath = path.join(dir, "data", "data.db");
    // A live writer with uncheckpointed WAL content stands in for the running Capsule.
    const writer = await createSqliteDatabaseAdapter(databasePath);
    try {
      await writer.exec("CREATE TABLE answerChecks (id TEXT PRIMARY KEY, kept INTEGER)");
      await writer.exec("INSERT INTO answerChecks VALUES ('a', 1), ('b', 0)");
      const action = (name, input) => {
        const args = [path.join(dir, "server.mjs"), "--sporades-action", name];
        if (input !== undefined) args.push("--sporades-action-input", Buffer.from(JSON.stringify(input), "utf8").toString("base64url"));
        const result = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
        return { status: result.status, body: JSON.parse(result.stdout) };
      };

      assert.deepEqual(action("db.query", { sql: "SELECT id FROM answerChecks WHERE kept = 1" }), { status: 0, body: { ok: true, data: { columns: ["id"], rows: [{ id: "a" }] }, error: null } });
      assert.deepEqual(action("db.list").body, { ok: true, data: { tables: ["answerChecks"] }, error: null });
      assert.deepEqual(action("db.dump").body.data.tables[0], { name: "answerChecks", columns: ["id", "kept"], rows: [{ id: "a", kept: 1 }, { id: "b", kept: 0 }] });

      // SQL that skipped the CLI's check is still refused by the runtime gate.
      for (const sql of ["DELETE FROM answerChecks", "SELECT 1; DELETE FROM answerChecks", "INSERT INTO answerChecks VALUES ('c', 1)", "DROP TABLE answerChecks", "ATTACH DATABASE 'x.db' AS x", "PRAGMA journal_mode = DELETE"]) {
        const refused = action("db.query", { sql });
        assert.equal(refused.status, 1, sql);
        assert.equal(refused.body.ok, false, sql);
        assert.deepEqual(Object.keys(refused.body.error), ["message", "hint"], sql);
      }
      assert.equal((await writer.prepare("SELECT count(*) AS total FROM answerChecks").get()).total, 2);

      for (const [name, input] of [["db.query", undefined], ["db.query", { sql: 1 }], ["db.query", { sql: "SELECT 1", extra: true }], ["db.list", { sql: "SELECT 1" }]]) {
        assert.deepEqual(action(name, input).body.error.message, "Invalid database inspection input.", `${name} ${JSON.stringify(input)}`);
      }
    } finally { await writer.close(); }

    await rm(databasePath, { force: true });
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    const missing = spawnSync(process.execPath, [path.join(dir, "server.mjs"), "--sporades-action", "db.list"], { cwd: dir, encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(JSON.parse(missing.stdout).error.message, /does not exist yet/);
    await assert.rejects(stat(databasePath), { code: "ENOENT" }, "a read must not create the Capsule database");
  });
});

test("sporades host db re-shapes Host responses and explains upgrades and stopped Capsules", async () => {
  await withTempDir(async (dir) => {
    const dockerLog = path.join(dir, "docker.log");
    const respond = (envelope, running = "true") => `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(dockerLog)}
if [ "$1" = inspect ]; then echo ${running}; exit 0; fi
if [ "$1" = exec ]; then echo '${JSON.stringify(envelope)}'; exit 0; fi
exit 9
`;
    const host = await installFakeHost(dir, { dockerScript: respond({ ok: true, data: { columns: ["n"], rows: [{ n: 1 }], capsule: { name: "x" }, env: { SECRET: "raw-secret" } }, error: null, extra: "raw-secret" }) });
    const query = (env = host.env) => run(["host", "db", "query", "SELECT 1 AS n", "--host", "live", "--subname", "notes", "--json"], dir, env);

    const shaped = query();
    assert.equal(shaped.status, 0, shaped.stdout);
    assert.deepEqual(JSON.parse(shaped.stdout), { ok: true, data: { columns: ["n"], rows: [{ n: 1 }] }, error: null });

    await writeFile(path.join(dir, "fake-bin", "docker"), respond({ ok: false, data: null, error: { message: "Bad SQL.", hint: "Fix it.", diagnostics: { token: "raw-secret" } } }));
    const failed = query();
    assert.equal(failed.status, 1);
    assert.deepEqual(JSON.parse(failed.stdout), { ok: false, data: null, error: { message: "Bad SQL.", hint: "Fix it." } });

    await writeFile(path.join(dir, "fake-bin", "docker"), respond({ ok: true, data: { jobs: [] }, error: null }));
    assert.match(JSON.parse(query().stdout).error.message, /invalid response/);

    await writeFile(path.join(dir, "fake-bin", "docker"), respond({ ok: false, data: null, error: { message: "Unsupported Sporades runtime action.", hint: "Upgrade the Sporades CLI and generated Bundle together." } }));
    const oldBundle = JSON.parse(query().stdout);
    assert.equal(oldBundle.error.code, "HOSTED_BUNDLE_UPGRADE_REQUIRED");
    assert.match(oldBundle.error.hint, /sporades host push --restart --host live/);

    await writeFile(path.join(dir, "fake-bin", "docker"), respond({}, "false"));
    assert.match(JSON.parse(query().stdout).error.hint, /sporades host start notes --host live/);

    await writeFile(path.join(dir, "fake-bin", "ssh"), `#!/bin/sh
IFS= read -r input || exit 9
echo '{"ok":false,"data":null,"error":{"message":"Unsupported Host helper action.","hint":"old"}}'
`);
    const oldHelper = JSON.parse(query().stdout);
    assert.equal(oldHelper.error.code, "HOST_HELPER_UPGRADE_REQUIRED");
    assert.match(oldHelper.error.hint, /sporades host upgrade --host live/);
    assert.doesNotMatch(await readFile(dockerLog, "utf8"), /raw-secret/);
  });
});

test("the Host helper accepts only the exact database inspection request", async () => {
  const base = { host: { alias: "live", domain: "example.test", scheme: "https", remoteRoot: "/srv/sporades" }, capsule: { subname: "notes" } };
  for (const request of [
    { action: "db.query", ...base },
    { action: "db.query", ...base, db: { sql: 1 } },
    { action: "db.query", ...base, db: { sql: "SELECT 1", extra: 1 } },
    { action: "db.query", ...base, db: { sql: `SELECT '${"x".repeat(20 * 1024)}'` } },
    { action: "db.query", ...base, db: { sql: `SELECT '${"\\".repeat(9 * 1024)}'` } },
    { action: "db.list", ...base, db: { sql: "SELECT 1" } },
    { action: "db.dump", ...base, capsule: { subname: "notes", extra: true } },
  ]) {
    const result = spawnSync(process.execPath, [helper], { input: `${JSON.stringify(request)}\n`, encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } });
    assert.equal(JSON.parse(result.stdout).error.message, "Invalid Hosted database inspection request.", JSON.stringify(request).slice(0, 120));
  }
});

test("sporades host db validates its arguments before contacting the Host", async () => {
  await withTempDir(async (dir) => {
    const host = await installFakeHost(dir, { dockerScript: "#!/bin/sh\nexit 9\n" });
    const cases = [
      [["host", "db"], /Unknown host db command/],
      [["host", "db", "drop"], /Unknown host db command/],
      [["host", "db", "query"], /Missing SQL query/],
      [["host", "db", "list", "extra"], /Too many positional arguments/],
      [["host", "db", "query", `SELECT '${"x".repeat(20 * 1024)}'`, "--subname", "notes"], /too large/],
      [["host", "db", "query", "DELETE FROM notes", "--subname", "notes"], /read-only|Only read-only/i],
      [["host", "db", "list"], /No Hosted Capsule binding found/],
    ];
    for (const [args, message] of cases) {
      const result = run([...args, "--json"], dir, host.env);
      assert.equal(result.status, 1, args.join(" ").slice(0, 80));
      assert.match(JSON.parse(result.stdout).error.message, message, args.join(" ").slice(0, 80));
    }
    assert.deepEqual(await host.requests(), []);
  });
});
