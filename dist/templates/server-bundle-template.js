import path from "node:path";
import { buildSync } from "esbuild";
import * as inspectionSql from "../inspection-sql.js";
import * as logIndexGuard from "../log-index-guard.js";
import { resolveSporadesPackageRoot } from "../package-root.js";
import { ACL_HELPER_STATE, EMAIL_SIGN_IN_FAILURE_LIMIT, EMAIL_SIGN_IN_THROTTLE_FIELD, EMAIL_SIGN_IN_THROTTLE_MAX_ENTRIES, EMAIL_SIGN_IN_THROTTLE_WINDOW_MS, PASSWORD_RESET_DEFAULT_PATH, PASSWORD_RESET_DEFAULT_TTL_MS, PASSWORD_RESET_MAIL_JOB, PASSWORD_RESET_MAX_OUTSTANDING_PER_EMAIL, PASSWORD_RESET_MAX_TTL_MS, PASSWORD_RESET_MIN_TTL_MS, PASSWORD_RESET_THROTTLE_FIELD, PRIVILEGED_AUDIT_ACTOR_KINDS, PRIVILEGED_AUDIT_OUTCOMES, PRIVILEGED_AUDIT_SCHEMA, PRIVILEGED_AUTH_USER_ID, RESERVED_JOB_NAME_PREFIX, SERVER_RUNTIME_SOURCE_FUNCTIONS, } from "../server-runtime-source.js";
import { PUBLIC_TREE_LIMITS, normalizePublicTreePath, publicTreePathFromRequest } from "../public-tree-contract.js";
// How a runtime module constant is written into the bundle preamble. Values travel as their own
// serialization so the runtime source's declaration stays the only place the value is written.
// A `Symbol` has no serialization, so it is reconstructed from its description: the result is a
// different Symbol than the runtime module's, which is safe for the one Symbol here because the
// bundle's only writer and only reader of that key both resolve the name to the preamble's own
// declaration, and the objects it keys never cross between a bundled Capsule and this process.
function serializeRuntimeConstant(value) {
    if (typeof value === "symbol")
        return `Symbol(${JSON.stringify(value.description)})`;
    if (value instanceof Set)
        return `new Set(${JSON.stringify([...value])})`;
    return JSON.stringify(value);
}
const MIGRATED_MODULES_NAMESPACE = "__sporadesMigratedRuntimeModules";
// Every region that has left `server-runtime-source.ts` and now travels into the emitted-list bundle
// as its own compiled text rather than as `fn.toString()` over a list of its functions (ADR-0041).
// A batch that migrates a domain adds its module here and nowhere else in this file.
//
// `file` is read from `dist/`; `loaded` is the copy this process is running, which is a *different*
// copy while the CLI ships as `bin/sporades.js`. The two are compared below.
const MIGRATED_RUNTIME_MODULES = [
    { file: "inspection-sql.js", loaded: inspectionSql },
    { file: "log-index-guard.js", loaded: logIndexGuard },
];
// Statements the carried copies of the migrated modules and the loaded ones must agree about,
// checked at every bundle build. Half are refused by the inspection gate and half admitted, and the
// refused half is what gives the check its teeth: a carried copy whose validator had been replaced
// by one that admits everything answers `ok` for all of them.
//
// The shapes are the ones ADR-0038 records as having defeated this gate — a bare destructive verb, a
// second statement, a nested block comment, the composed line comment, a verb inside a dollar quote,
// a PRAGMA assignment, whitespace no engine has, and text the wire cannot carry — so a carried copy
// that differs in any limb this project has actually got wrong is caught rather than shipped.
//
// The last three exist for the log-index guard, the second module carried here, which answers a
// different question over the same text. A probe that could not reach a `sporades_log_events`
// reference, a dotted and quoted spelling of one, or a `sqlite_schema` query would compare a skewed
// copy of that module as clean — the same "reports clean for the wrong reason" failure ADR-0038
// records the sweep corpus making three times.
export const MIGRATED_MODULE_SKEW_PROBE = [
    "DROP TABLE t",
    "TRUNCATE TABLE t",
    "SELECT 1 AS s; DROP TABLE t",
    "/*/* */ SELECT 1 */ TRUNCATE TABLE t",
    "SELECT 1 AS s --x\r/*y\n; DROP TABLE t --*/ AS z",
    "SELECT $$a; DROP TABLE t$$ AS s",
    "PRAGMA journal_mode = WAL",
    "SELECT\u00a01 AS a",
    "SELECT 1 AS s\u0000",
    "SELECT 1",
    "SELECT * FROM posts;",
    "PRAGMA table_info(posts)",
    "WITH recent AS (SELECT 1 AS s) SELECT * FROM recent",
    "SELECT id FROM posts WHERE title = 'it''s fine' -- why\r\n;",
    "SELECT * FROM sporades_log_events",
    "SELECT * FROM main . \"sporades_log_events\"",
    "SELECT name FROM sqlite_schema",
];
// Rows the carried copy of the log-index guard and the loaded one must classify the same way. The
// guard's second limb reads result rows rather than SQL, so the statement probe above cannot reach
// it at all: a carried copy that had lost the row filter would answer every statement above
// identically and still hand an operator the log-index table's name out of a deployed Capsule.
export const MIGRATED_MODULE_ROW_SKEW_PROBE = [
    [{ name: "sporades_log_events" }, "SELECT name FROM sqlite_schema"],
    [{ tbl_name: "sporades_log_events" }, "SELECT tbl_name FROM sqlite_master"],
    [{ sql: "CREATE TABLE sporades_log_events (id TEXT)" }, "SELECT sql FROM sqlite_schema"],
    [{ note: "mentions sporades_log_events in passing" }, "SELECT note FROM sqlite_schema"],
    [{ note: "mentions sporades_log_events in passing" }, "SELECT note FROM posts"],
    [{ name: "posts" }, "SELECT name FROM sqlite_schema"],
    [{}, ""],
];
function bundleTemplateError(message, hint) {
    return Object.assign(new Error(message), { hint });
}
// The carried block, evaluated so it can be questioned rather than only pattern-matched.
//
// The input is this build's own output, produced two lines earlier from files inside the Sporades
// package — not Capsule code and not anything a Capsule author supplies. Evaluating it costs one
// `new Function` and runs the modules' top level, which builds three `Set`s and declares functions.
function evaluateMigratedModulesBlock(code) {
    try {
        return new Function(`${code}\nreturn ${MIGRATED_MODULES_NAMESPACE};`)();
    }
    catch (error) {
        throw bundleTemplateError(`Server bundle failed: the migrated runtime modules did not evaluate: ${error?.message ?? error}`, "A file under dist/ is truncated or corrupt. Run `npm run build`, or reinstall the Sporades CLI.");
    }
}
// The names the comparison below calls, so it can say what is missing instead of dying on it. A
// probe that names a function no listed module exports is otherwise a bare `TypeError` out of the
// middle of a bundle build — which is how it first failed, when the two lists were deliberately put
// out of step while testing something else. The probe and `MIGRATED_RUNTIME_MODULES` have to move
// together, and this is where that is said.
const MIGRATED_MODULE_PROBE_NAMES = [
    "validateReadOnlyInspectionSql",
    "sqlWithoutTrailingTerminator",
    "targetsInternalLogIndexTable",
    "readSqlTableReference",
    "isInternalLogIndexMetadataRow",
];
// What the two copies of the migrated modules answer, as comparable text. The inspection gate over
// the statement probe, then the log-index guard over the same statements and over the row probe —
// the guard reads rows as well as SQL, and a check that only asked about SQL could not see half of
// it go missing.
function describeMigratedModuleAnswers(module) {
    const absent = MIGRATED_MODULE_PROBE_NAMES.filter((name) => typeof module[name] !== "function");
    if (absent.length > 0) {
        throw bundleTemplateError(`Server bundle failed: the migrated runtime modules do not supply ${absent.join(", ")}, which the skew probe compares.`, "MIGRATED_RUNTIME_MODULES and MIGRATED_MODULE_PROBE_NAMES in server-bundle-template.ts are out of step. A module listed for carrying must still export what the probe asks it.");
    }
    return [
        ...MIGRATED_MODULE_SKEW_PROBE.map((sql) => JSON.stringify([
            sql,
            module.validateReadOnlyInspectionSql(sql),
            module.sqlWithoutTrailingTerminator(sql),
            module.targetsInternalLogIndexTable(sql),
            module.readSqlTableReference(sql, 0),
        ])),
        ...MIGRATED_MODULE_ROW_SKEW_PROBE.map(([row, sql]) => JSON.stringify([row, sql, module.isInternalLogIndexMetadataRow(row, sql)])),
    ];
}
// Every region that has left the monolith, carried into the bundle as those modules' own compiled
// text rather than as `fn.toString()` over a list of their functions.
//
// **Why a migrated region is carried differently.** A stringified function reaches the bundle without
// anything it closes over, so under the emitted-list mechanism a helper had to be registered in
// `SERVER_RUNTIME_SOURCE_FUNCTIONS` to survive — and the inspection gate paid for that in five
// duplicated copies of one set of comment and quoting rules, four independent reviews and five
// rounds of fixes (ADR-0038). Carrying a module whole removes the registration step for that
// region: a private helper travels because it is in the file, not because someone remembered it.
// ADR-0041 records the decision. Everything that has not migrated still travels through the list.
//
// The modules are compiled to an IIFE by esbuild rather than concatenated with their `export`
// keywords stripped, and the reason is privacy rather than safety. Concatenation would be *loud* if
// it collided: the generated bundle is an ES module — it imports `node:crypto` and uses top-level
// `await` — and a duplicate top-level `function` or `const` there is a load-time `SyntaxError`, which
// is exactly what a duplicate entry in the emitted list produces and why none is left there. What
// concatenation would cost is the thing this whole change is for: every one of these modules' private
// helpers would land at the bundle's top level, reachable from 500-odd runtime functions, so
// "private" would stop meaning anything at the point it started to matter. Inside the IIFE it does.
// Not stripping `export` keywords out of generated JavaScript by hand is the second reason.
//
// **`build`, not `transformSync`, and this is the batch that forced the change.** ADR-0041 proved
// the carrier for one module that imports nothing, and named the boundary: `transformSync` is a
// format conversion of one file and resolves nothing, so given a module with an import of its own it
// emits a `require(…)` into the IIFE and the Capsule dies at boot with "Cannot determine intended
// module format". `log-index-guard` imports the inspection gate's tokenizer, so it is the first
// region to cross that line. Every later batch will cross it too — the domains left in the monolith
// call each other.
//
// **One block for all of them, rather than one block each**, and the reason is that bundling each
// module separately would inline `inspection-sql` into every block that imports it. Two copies of
// the one tokenizer inside the shipped artifact cannot drift — they come from the same file in the
// same build — but ADR-0038's whole subject is that the duplication *itself* is the defect
// generator, and an artifact that contradicts it teaches the next reader the wrong thing. Bundled
// together there is one copy of each module, whatever imports what.
//
// `buildSync` rather than `build`, so `createServerBundleSource` stays synchronous; every caller and
// three test files expect that. The cost ADR-0041 measured for `transformSync` applies here too: the
// esbuild binary runs out of process and the first call in a process pays for the spawn.
function migratedRuntimeModulesSource() {
    return migratedRuntimeModulesBlockFrom(path.join(resolveSporadesPackageRoot(), "dist"));
}
// The block, and the checks that decide whether the copies it was built from are the copies this
// process is running. Takes the directory rather than reading a fixed one, so that a test can drive
// it against a deliberately skewed tree without touching the tree the suite is running out of.
//
// A directory and not the file contents, which is what this took before it bundled: `buildSync`
// accepts no plugins, so there is no way to hand esbuild an in-memory module graph. Handing it a
// directory is also the more faithful seam — a skewed copy is now resolved by the same import the
// real build resolves, so a skew that breaks the import between two migrated modules fails here for
// the same reason it would fail in a release.
export function migratedRuntimeModulesBlockFrom(distDir) {
    // One synthetic entry re-exporting each migrated module, so the block's export surface is their
    // union and esbuild resolves the imports between them exactly once.
    const entry = MIGRATED_RUNTIME_MODULES.map(({ file }) => `export * from ${JSON.stringify(`./${file}`)};`).join("\n");
    let result;
    try {
        result = buildSync({
            bundle: true,
            format: "iife",
            globalName: MIGRATED_MODULES_NAMESPACE,
            platform: "node",
            target: "node22",
            write: false,
            metafile: true,
            logLevel: "silent",
            // esbuild labels every inlined module with its path relative to the working directory, and
            // those labels are comments in the text that ships. Pinned to the directory being read so a
            // Capsule bundle carries `inspection-sql.js` rather than whoever's absolute home directory the
            // CLI was invoked from, and so the same inputs build identically on two machines.
            absWorkingDir: distDir,
            stdin: {
                contents: entry,
                sourcefile: path.join(distDir, "__sporades-migrated-runtime-modules__.js"),
                resolveDir: distDir,
                loader: "js",
            },
        });
    }
    catch (error) {
        // A file that will not parse or an import that will not resolve — a truncated write and a
        // half-updated `dist/` are the ordinary ways to get each. esbuild's own error names the position,
        // and it is worth nothing to a person without the hint beside it.
        throw bundleTemplateError(`Server bundle failed: the migrated runtime modules in ${distDir} did not build: ${error?.errors?.map((entry) => entry.text).join("; ") || error?.message || String(error)}`, "A file under dist/ is truncated or corrupt. Run `npm run build`, or reinstall the Sporades CLI.");
    }
    // ADR-0040: a deployed Capsule runs `node /app/server.mjs` in an image with no `node_modules`, so
    // this block must resolve nothing at runtime. Asked of esbuild's metafile rather than of the text,
    // because this is exactly where the property stops holding by construction: the moment a migrated
    // module imports something outside this list, `format: "iife"` emits a `require(…)` for it and the
    // Capsule dies at boot rather than at build. A builtin is no better than a package here — the
    // block is spliced into an ES module, where `require` is not defined at all.
    const unresolved = Object.values(result.metafile.outputs)
        .flatMap((entry) => entry.imports)
        .filter((entry) => entry.external)
        .map((entry) => entry.path);
    if (unresolved.length > 0) {
        throw bundleTemplateError(`Server bundle failed: the migrated runtime modules would resolve ${[...new Set(unresolved)].sort().join(", ")} at runtime.`, "A migrated runtime module may only import another migrated module. Add the dependency to MIGRATED_RUNTIME_MODULES, or inline what it needs.");
    }
    const code = result.outputFiles?.[0]?.text;
    if (!code) {
        throw bundleTemplateError("Server bundle failed: esbuild produced no text for the migrated runtime modules.", "Report this: the Sporades migrated runtime modules produced no output.");
    }
    // **Two copies of these modules exist while the CLI is a bundle, and they are checked against each
    // other here.** `bin/sporades.js` is built by esbuild from `src/`, so the namespaces imported at
    // the top of this file are copies inlined into `bin/`, while the text just built comes from
    // `dist/` on disk. Running from `dist/` there is one copy and the question does not arise; running
    // from `bin/` a tree whose `dist/` and `bin/` came from different builds would ship the `dist/`
    // gate inside a Capsule while every other runtime function in that same Capsule came from `bin/`.
    //
    // Nothing in `scripts/` compares those for freshness — `check-generated-bin.mjs` checks the
    // shebang, the generated header and the absence of `../src/` imports, and an earlier version of
    // this comment claimed a freshness check it does not perform. So the comparison is made here,
    // against the copy that will actually be carried rather than against the files it came from.
    const carried = evaluateMigratedModulesBlock(code);
    // The names the rest of the bundle resolves against, taken from the carried namespace itself. A
    // name that the block does not export cannot be destructured from it, so "declared here, absent
    // there" is not a state this can reach. Written out by hand instead, a misspelling would declare a
    // binding that is simply `undefined` at runtime, which the free-binding guard resolves exactly as
    // cleanly as a correct one.
    const exported = Object.keys(carried).sort();
    const loaded = [...new Set(MIGRATED_RUNTIME_MODULES.flatMap(({ loaded: module }) => Object.keys(module)))].sort();
    if (exported.join(",") !== loaded.join(",")) {
        const missing = loaded.filter((name) => !exported.includes(name));
        const extra = exported.filter((name) => !loaded.includes(name));
        throw bundleTemplateError(`Server bundle failed: the migrated runtime modules in ${distDir} export a different set of names than the running CLI's copies of them`
            + `${missing.length ? `; missing ${missing.join(", ")}` : ""}${extra.length ? `; unexpected ${extra.join(", ")}` : ""}.`, "dist/ and bin/ are from different builds. Run `npm run build`, or reinstall the Sporades CLI.");
    }
    // And the same names are not enough, because the shape that matters most keeps them: a carried copy
    // whose validator body had been replaced would export exactly this list and admit everything. So
    // the two copies are asked the same questions and must answer identically.
    //
    // This is a probe, not a proof, and the difference is worth stating rather than leaving to be
    // discovered: two copies that agree on the export surface and on every question below still ship,
    // however else they differ. What it does close is the case that is otherwise silent.
    const loadedModule = Object.assign({}, ...MIGRATED_RUNTIME_MODULES.map(({ loaded: module }) => ({ ...module })));
    const carriedAnswers = describeMigratedModuleAnswers(carried);
    const loadedAnswers = describeMigratedModuleAnswers(loadedModule);
    const disagreement = carriedAnswers.findIndex((answer, index) => answer !== loadedAnswers[index]);
    if (disagreement >= 0) {
        throw bundleTemplateError(`Server bundle failed: the migrated runtime modules in ${distDir} answer the read-only inspection surface differently `
            + `than the running CLI's copies of them, starting at ${carriedAnswers[disagreement]}.`, "dist/ and bin/ are from different builds. Run `npm run build`, or reinstall the Sporades CLI.");
    }
    return `${code}\nconst { ${exported.join(", ")} } = ${MIGRATED_MODULES_NAMESPACE};`;
}
export function createServerBundleSource({ config, serverEnv, sealedServerEnv = { enabled: false }, serverSource, serverModuleSource }) {
    const runtimeFunctions = SERVER_RUNTIME_SOURCE_FUNCTIONS
        .map((fn) => fn.toString())
        .join("\n\n");
    const publicTreeContract = [
        `const PUBLIC_TREE_LIMITS = ${JSON.stringify(PUBLIC_TREE_LIMITS)};`,
        normalizePublicTreePath.toString(),
        publicTreePathFromRequest.toString(),
    ].join("\n\n");
    // The read-only inspection gate's three keyword tables used to be serialized into a preamble here,
    // because a runtime function reaches the bundle as its own source text and a module-level binding
    // it closes over does not follow. They are declarations inside `migratedModules` now, and the
    // gate's own functions close over them there exactly as they do in `dist/`, so serializing them
    // again would declare each name twice. They are still reachable by name at the bundle's top level
    // through the destructuring that block ends with, which is what the constant probe in
    // `test/server-bundle-module-graph.test.js` reads them through. A migrated domain's own constants
    // travel the same way, which is why nothing was added to the preamble below when the log-index
    // guard moved.
    const migratedModules = migratedRuntimeModulesSource();
    // The runtime's module-level constants, for the same reason as the keyword tables above: a
    // runtime function reaches the bundle as its own source text and a module-level binding it closes
    // over does not follow. Each is serialized from the runtime source's own declaration rather than
    // restated here, so a threshold is written in exactly one place and changing it there changes
    // what a deployed Capsule enforces. Several of these are security thresholds, and a restated copy
    // that drifted would be silent — the free-binding guard resolves names, and a wrong value
    // resolves exactly as cleanly as a right one.
    const runtimeConstants = [
        ["PRIVILEGED_AUTH_USER_ID", PRIVILEGED_AUTH_USER_ID],
        ["EMAIL_SIGN_IN_FAILURE_LIMIT", EMAIL_SIGN_IN_FAILURE_LIMIT],
        ["EMAIL_SIGN_IN_THROTTLE_WINDOW_MS", EMAIL_SIGN_IN_THROTTLE_WINDOW_MS],
        ["EMAIL_SIGN_IN_THROTTLE_MAX_ENTRIES", EMAIL_SIGN_IN_THROTTLE_MAX_ENTRIES],
        ["EMAIL_SIGN_IN_THROTTLE_FIELD", EMAIL_SIGN_IN_THROTTLE_FIELD],
        ["PASSWORD_RESET_THROTTLE_FIELD", PASSWORD_RESET_THROTTLE_FIELD],
        ["PASSWORD_RESET_DEFAULT_PATH", PASSWORD_RESET_DEFAULT_PATH],
        ["PASSWORD_RESET_DEFAULT_TTL_MS", PASSWORD_RESET_DEFAULT_TTL_MS],
        ["PASSWORD_RESET_MIN_TTL_MS", PASSWORD_RESET_MIN_TTL_MS],
        ["PASSWORD_RESET_MAX_TTL_MS", PASSWORD_RESET_MAX_TTL_MS],
        ["PASSWORD_RESET_MAX_OUTSTANDING_PER_EMAIL", PASSWORD_RESET_MAX_OUTSTANDING_PER_EMAIL],
        ["RESERVED_JOB_NAME_PREFIX", RESERVED_JOB_NAME_PREFIX],
        ["PASSWORD_RESET_MAIL_JOB", PASSWORD_RESET_MAIL_JOB],
        ["PRIVILEGED_AUDIT_SCHEMA", PRIVILEGED_AUDIT_SCHEMA],
        ["PRIVILEGED_AUDIT_ACTOR_KINDS", PRIVILEGED_AUDIT_ACTOR_KINDS],
        ["PRIVILEGED_AUDIT_OUTCOMES", PRIVILEGED_AUDIT_OUTCOMES],
        ["ACL_HELPER_STATE", ACL_HELPER_STATE],
    ]
        .map(([name, value]) => `const ${name} = ${serializeRuntimeConstant(value)};`)
        .join("\n");
    const serverModuleDataUrl = `data:text/javascript;base64,${Buffer.from(serverModuleSource, "utf8").toString("base64")}`;
    return `// Sporades server bundle
import { createDecipheriv, createHash, createHash as createHash2, createHmac, createPrivateKey, privateDecrypt, randomBytes, randomBytes as randomBytes2, randomUUID, scryptSync, sign, timingSafeEqual, verify } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readFileSync as readFileSync2 } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

export const sporadesConfig = ${JSON.stringify(config, null, 2)};
export const sporadesServerEnv = ${JSON.stringify(serverEnv, null, 2)};
export const sporadesSealedServerEnv = ${JSON.stringify(sealedServerEnv, null, 2)};
export const sporadesServerSource = ${JSON.stringify(serverSource)};
const sporadesActionIndex = process.argv.indexOf("--sporades-action");
const sporadesAction = sporadesActionIndex < 0 ? null : process.argv[sporadesActionIndex + 1];
const sporadesCapsuleModule = sporadesAction ? null : await import(${JSON.stringify(serverModuleDataUrl)});
const sporadesCapsuleDefinition = sporadesCapsuleModule?.default ?? null;
${runtimeConstants}
${migratedModules}
${runtimeFunctions}
${publicTreeContract}

const port = Number(process.env.PORT ?? sporadesConfig.deploy?.port ?? 4000);
const databasePath = process.env.SPORADES_DATABASE_PATH ?? path.join(process.cwd(), "data", "data.db");
const runtimeConfig = {
  ...sporadesConfig,
  __sporadesSession: process.env.SPORADES_SECURITY_SESSION ?? sporadesConfig.__sporadesSession,
  __sporadesPublicOrigin: process.env.SPORADES_PUBLIC_ORIGIN ?? sporadesConfig.__sporadesPublicOrigin,
};
const runtimeServerEnv = await readRuntimeServerEnv(sporadesServerEnv, sporadesSealedServerEnv);
const runtimeServiceEnv = readRuntimeServiceEnv();
if (sporadesAction) {
  if (!['jobs.inspect', 'schedules.inspect'].includes(sporadesAction)) {
    process.stdout.write(JSON.stringify({ ok: false, data: null, error: { message: "Unsupported Sporades runtime action.", hint: "Upgrade the Sporades CLI and generated Bundle together." } }) + "\\n");
    process.exit(1);
  }
  const adapter = await createRuntimeInspectionAdapter(databasePath, runtimeServiceEnv, runtimeConfig);
  try {
    const items = adapter ? await (sporadesAction === 'jobs.inspect' ? inspectRuntimeJobs(adapter) : inspectRuntimeSchedules(adapter)) : [];
    const key = sporadesAction === 'jobs.inspect' ? 'jobs' : 'schedules';
    process.stdout.write(JSON.stringify({ ok: true, data: { capsule: { name: sporadesConfig.name }, [key]: items }, error: null }) + "\\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, data: null, error: { code: error.code ?? (sporadesAction === 'jobs.inspect' ? "JOB_INSPECTION_FAILED" : "SCHEDULE_INSPECTION_FAILED"), message: error.message, hint: error.hint, ...(error.jobId ? { jobId: error.jobId, field: error.field } : {}), ...(error.scheduleName ? { scheduleName: error.scheduleName, field: error.field } : {}) } }) + "\\n");
    process.exitCode = 1;
  } finally { await adapter?.close(); }
  process.exit();
}
const database = await openDevDatabase(databasePath, sporadesServerSource, runtimeServerEnv, runtimeConfig, sporadesCapsuleDefinition, {
  serviceEnv: runtimeServiceEnv,
});
await database.init();
database.log.emit({
  category: "platform",
  event: "runtime.started",
  level: "info",
  message: "Capsule runtime started",
  data: { diagnostics: database.runtimeDiagnostics },
  release: process.env.SPORADES_RELEASE_ID ? { id: process.env.SPORADES_RELEASE_ID } : null,
});
const websocketHub = createWebSocketHub(() => database);
const runtimePublicRoot = resolveRuntimePublicRoot();

const server = createServer(async (request, response) => {
  try {
    if (prepareHttpSecurity(database, request, response)) {
      return;
    }

    if (await routeRuntimeHealth(database, request, response)) {
      return;
    }

    if (await routeSporadesAuth(database, request, response)) {
      return;
    }

    if (await handleFileHttpRoute(database, request, response, websocketHub)) {
      return;
    }

    if (await routeEndpoint(database, request, response)) {
      return;
    }

    if (await routePublicAsset(request, response, runtimePublicRoot, websocketHub)) {
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    writeUnhandledHttpError(database, request, response, error);
  }
});

server.on("upgrade", (request, socket) => {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  if (requestUrl.pathname !== "/__sporades/ws") {
    socket.destroy();
    return;
  }
  websocketHub.accept(request, socket);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "0.0.0.0", resolve);
});

let shutdownStarted = false;
const shutdown = async () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  websocketHub.disconnectAll();
  await database.shutdown();
  server.close(() => {
    database.close();
    process.exit(0);
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function resolveRuntimePublicRoot() {
  const mounted = path.join(process.cwd(), "public");
  if (process.cwd() === "/app") return mounted;
  return resolveActiveRuntimePublicRoot() ?? mounted;
}

function resolveActiveRuntimePublicRoot() {
  try {
    const treesDir = path.join(process.cwd(), ".sporades", "build", ".public-trees");
    const treesStats = lstatSync(treesDir);
    const referencePath = path.join(treesDir, "active.json");
    const referenceStats = lstatSync(referencePath);
    const tree = JSON.parse(readFileSync(path.join(treesDir, "active.json"), "utf8"))?.tree;
    if (!/^[1-9][0-9]*-[0-9]{10,}-[a-f0-9]{8,}$/.test(tree)) return null;
    const candidate = path.join(treesDir, tree);
    const candidateStats = lstatSync(candidate);
    const indexStats = lstatSync(path.join(candidate, "index.html"));
    if (
      treesStats.isDirectory() && !treesStats.isSymbolicLink()
      && referenceStats.isFile() && !referenceStats.isSymbolicLink()
      && candidateStats.isDirectory() && !candidateStats.isSymbolicLink()
      && indexStats.isFile() && !indexStats.isSymbolicLink()
    ) return candidate;
  } catch {}
  return null;
}

async function routePublicAsset(request, response, publicRoot, hub) {
  const rawPathname = String(request.url ?? "/").split("?", 1)[0];
  const relativePath = publicTreePathFromRequest(rawPathname);
  if (relativePath === null) return false;
  const filePath = path.join(publicRoot, ...relativePath.split("/"));
  const stats = await lstat(filePath).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) return false;
  const body = await readFile(filePath);
  const html = relativePath === "index.html";
  response.writeHead(200, { "content-type": publicContentType(relativePath) });
  response.end(html ? injectPageConnectionToken(body.toString("utf8"), hub.createConnectionToken()) : body);
  return true;
}

function publicContentType(relativePath) {
  switch (path.extname(relativePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": case ".map": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

async function readRuntimeServerEnv(fallbackEnv, sealed) {
  let env;
  if (!sealed?.enabled) {
    env = fallbackEnv;
  } else {
    const envelopePath = process.env.SPORADES_SEALED_SERVER_ENV_PATH ?? path.join(process.cwd(), ".sporades", "sealed-server-env", "server-env.sealed.json");
    const privateKeyPath = process.env.SPORADES_SEALED_SERVER_ENV_PRIVATE_KEY_PATH ?? path.join(process.cwd(), ".sporades", "sealed-server-env", "server-env.private.pem");
    const [envelopeRaw, privateKey] = await Promise.all([readFile(envelopePath, "utf8"), readFile(privateKeyPath, "utf8")]);
    env = unsealRuntimeServerEnv(JSON.parse(envelopeRaw), privateKey);
  }
  return env;
}

function readRuntimeServiceEnv() {
  const keys = [
    "SPORADES_SERVICE_DATABASE_ENGINE",
    "SPORADES_SERVICE_DATABASE_URL",
    "SPORADES_SERVICE_DATABASE_AUTH_TOKEN",
    "SPORADES_SERVICE_STORAGE_ENGINE",
    "SPORADES_SERVICE_STORAGE_ENDPOINT",
    "SPORADES_SERVICE_STORAGE_ACCESS_KEY",
    "SPORADES_SERVICE_STORAGE_SECRET_KEY",
    "SPORADES_SERVICE_STORAGE_BUCKET",
    "SPORADES_SERVICE_STORAGE_REGION",
    "SPORADES_SERVICE_STORAGE_NAMESPACE",
  ];
  return Object.fromEntries(keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}

function unsealRuntimeServerEnv(envelope, privateKey) {
  const values = {};
  for (const [key, entry] of Object.entries(envelope.entries ?? {})) {
    const dataKey = privateDecrypt(privateKey, Buffer.from(entry.encryptedKey, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(entry.iv, "base64"));
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    values[key] = Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
  return values;
}
`;
}
//# sourceMappingURL=server-bundle-template.js.map