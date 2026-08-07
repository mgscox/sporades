import { readFileSync } from "node:fs";
import path from "node:path";

import { transformSync } from "esbuild";

import * as inspectionSql from "../inspection-sql.js";
import { resolveSporadesPackageRoot } from "../package-root.js";
import {
  ACL_HELPER_STATE,
  EMAIL_SIGN_IN_FAILURE_LIMIT,
  EMAIL_SIGN_IN_THROTTLE_FIELD,
  EMAIL_SIGN_IN_THROTTLE_MAX_ENTRIES,
  EMAIL_SIGN_IN_THROTTLE_WINDOW_MS,
  PASSWORD_RESET_DEFAULT_PATH,
  PASSWORD_RESET_DEFAULT_TTL_MS,
  PASSWORD_RESET_MAIL_JOB,
  PASSWORD_RESET_MAX_OUTSTANDING_PER_EMAIL,
  PASSWORD_RESET_MAX_TTL_MS,
  PASSWORD_RESET_MIN_TTL_MS,
  PASSWORD_RESET_THROTTLE_FIELD,
  PRIVILEGED_AUDIT_ACTOR_KINDS,
  PRIVILEGED_AUDIT_OUTCOMES,
  PRIVILEGED_AUDIT_SCHEMA,
  PRIVILEGED_AUTH_USER_ID,
  RESERVED_JOB_NAME_PREFIX,
  SERVER_RUNTIME_SOURCE_FUNCTIONS,
} from "../server-runtime-source.js";
import { PUBLIC_TREE_LIMITS, normalizePublicTreePath, publicTreePathFromRequest } from "../public-tree-contract.js";

// How a runtime module constant is written into the bundle preamble. Values travel as their own
// serialization so the runtime source's declaration stays the only place the value is written.
// A `Symbol` has no serialization, so it is reconstructed from its description: the result is a
// different Symbol than the runtime module's, which is safe for the one Symbol here because the
// bundle's only writer and only reader of that key both resolve the name to the preamble's own
// declaration, and the objects it keys never cross between a bundled Capsule and this process.
function serializeRuntimeConstant(value: unknown): string {
  if (typeof value === "symbol") return `Symbol(${JSON.stringify(value.description)})`;
  if (value instanceof Set) return `new Set(${JSON.stringify([...value])})`;
  return JSON.stringify(value);
}

const INSPECTION_SQL_NAMESPACE = "__sporadesInspectionSql";

// Statements the carried copy of the inspection gate and the loaded one must agree about, checked at
// every bundle build. Half are refused by the gate and half admitted, and the refused half is what
// gives the check its teeth: a carried copy whose validator had been replaced by one that admits
// everything answers `ok` for all of them.
//
// The shapes are the ones ADR-0038 records as having defeated this gate — a bare destructive verb, a
// second statement, a nested block comment, the composed line comment, a verb inside a dollar quote,
// a PRAGMA assignment, whitespace no engine has, and text the wire cannot carry — so a carried copy
// that differs in any limb this project has actually got wrong is caught rather than shipped.
export const INSPECTION_SQL_SKEW_PROBE = [
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
];

function bundleTemplateError(message: string, hint: string) {
  return Object.assign(new Error(message), { hint });
}

// The carried block, evaluated so it can be questioned rather than only pattern-matched.
//
// The input is this build's own output, produced two lines earlier from a file inside the Sporades
// package — not Capsule code and not anything a Capsule author supplies. Evaluating it costs one
// `new Function` and runs the module's top level, which builds three `Set`s and declares functions.
function evaluateInspectionSqlBlock(code: string) {
  try {
    return new Function(`${code}\nreturn ${INSPECTION_SQL_NAMESPACE};`)();
  } catch (error: any) {
    throw bundleTemplateError(
      `Server bundle failed: the read-only inspection module did not evaluate: ${error?.message ?? error}`,
      "dist/inspection-sql.js is truncated or corrupt. Run `npm run build`, or reinstall the Sporades CLI.",
    );
  }
}

// What the two copies of the inspection gate answer, as comparable text.
function describeInspectionSqlAnswers(module: any) {
  return INSPECTION_SQL_SKEW_PROBE.map((sql) =>
    JSON.stringify([sql, module.validateReadOnlyInspectionSql(sql), module.sqlWithoutTrailingTerminator(sql)]),
  );
}

// The read-only inspection validator and its tokenizer, carried into the bundle as `inspection-sql`'s
// own compiled text rather than as `fn.toString()` over a list of its functions.
//
// **Why this one region is carried differently.** A stringified function reaches the bundle without
// anything it closes over, so under the emitted-list mechanism a helper had to be registered in
// `SERVER_RUNTIME_SOURCE_FUNCTIONS` to survive — and the inspection gate paid for that in five
// duplicated copies of one set of comment and quoting rules, four independent reviews and five
// rounds of fixes (ADR-0038). Carrying the module whole removes the registration step for that
// region: a private helper travels because it is in the file, not because someone remembered it.
// ADR-0041 records the decision. Nothing else has moved; every other runtime function still travels
// through the list.
//
// The module is compiled to an IIFE by esbuild rather than concatenated with its `export` keywords
// stripped, and the reason is privacy rather than safety. Concatenation would be *loud* if it
// collided: the generated bundle is an ES module — it imports `node:crypto` and uses top-level
// `await` — and a duplicate top-level `function` or `const` there is a load-time `SyntaxError`, which
// is exactly what a duplicate entry in the emitted list produces and why none is left there. What
// concatenation would cost is the thing this whole change is for: every one of this module's private
// helpers would land at the bundle's top level, reachable from 500-odd runtime functions, so
// "private" would stop meaning anything at the point it started to matter. Inside the IIFE it does.
// Not stripping `export` keywords out of generated JavaScript by hand is the second reason.
//
// `transformSync`, not `build`: this is a format conversion of one already-compiled file, so nothing
// is resolved and nothing is read except the file named below. `createServerBundleSource` is
// synchronous and every caller expects it to stay that way.
function inspectionSqlModuleSource() {
  const modulePath = path.join(resolveSporadesPackageRoot(), "dist", "inspection-sql.js");
  let compiled: string;
  try {
    compiled = readFileSync(modulePath, "utf8");
  } catch (error: any) {
    throw bundleTemplateError(
      `Server bundle failed: could not read ${modulePath}: ${error?.message ?? error}`,
      "Reinstall the Sporades CLI: its dist/ directory is missing or the install is incomplete.",
    );
  }
  return inspectionSqlBlockFrom(compiled, modulePath);
}

// The block, and the checks that decide whether the copy it was built from is the copy this process
// is running. Separated from the file read so that a test can drive it with a deliberately skewed
// copy without touching the tree the suite is running out of.
export function inspectionSqlBlockFrom(compiled: string, modulePath: string) {
  let code: string;
  try {
    ({ code } = transformSync(compiled, {
      loader: "js",
      format: "iife",
      globalName: INSPECTION_SQL_NAMESPACE,
      platform: "node",
      target: "node22",
    }));
  } catch (error: any) {
    // A file that will not parse — a truncated write is the ordinary way to get one. esbuild's own
    // error names the position, and it is worth nothing to a person without the file it came from.
    throw bundleTemplateError(
      `Server bundle failed: ${modulePath} did not parse: ${error?.errors?.map((entry: any) => entry.text).join("; ") || error?.message || String(error)}`,
      "dist/inspection-sql.js is truncated or corrupt. Run `npm run build`, or reinstall the Sporades CLI.",
    );
  }

  // **Two copies of this module exist while the CLI is a bundle, and they are checked against each
  // other here.** `bin/sporades.js` is built by esbuild from `src/`, so the `inspectionSql` imported
  // above is a copy inlined into `bin/`, while the text just read comes from `dist/` on disk. Running
  // from `dist/` there is one copy and the question does not arise; running from `bin/` a tree whose
  // `dist/` and `bin/` came from different builds would ship the `dist/` gate inside a Capsule while
  // every other runtime function in that same Capsule came from `bin/`.
  //
  // Nothing in `scripts/` compares those for freshness — `check-generated-bin.mjs` checks the
  // shebang, the generated header and the absence of `../src/` imports, and an earlier version of
  // this comment claimed a freshness check it does not perform. So the comparison is made here,
  // against the copy that will actually be carried rather than against the file it came from.
  const carried = evaluateInspectionSqlBlock(code);

  // The names the rest of the bundle resolves against, taken from the carried namespace itself. A
  // name that the block does not export cannot be destructured from it, so "declared here, absent
  // there" is not a state this can reach. Written out by hand instead, a misspelling would declare a
  // binding that is simply `undefined` at runtime, which the free-binding guard resolves exactly as
  // cleanly as a correct one.
  const exported = Object.keys(carried).sort();
  const loaded = Object.keys(inspectionSql).sort();
  if (exported.join(",") !== loaded.join(",")) {
    const missing = loaded.filter((name) => !exported.includes(name));
    const extra = exported.filter((name) => !loaded.includes(name));
    throw bundleTemplateError(
      `Server bundle failed: ${modulePath} exports a different set of names than the running CLI's copy of it`
        + `${missing.length ? `; missing ${missing.join(", ")}` : ""}${extra.length ? `; unexpected ${extra.join(", ")}` : ""}.`,
      "dist/ and bin/ are from different builds. Run `npm run build`, or reinstall the Sporades CLI.",
    );
  }

  // And the same names are not enough, because the shape that matters most keeps them: a carried copy
  // whose validator body had been replaced would export exactly this list and admit everything. So
  // the two copies are asked the same questions and must answer identically.
  //
  // This is a probe, not a proof, and the difference is worth stating rather than leaving to be
  // discovered: two copies that agree on the export surface and on every statement below still ship,
  // however else they differ. What it does close is the case that is otherwise silent.
  const carriedAnswers = describeInspectionSqlAnswers(carried);
  const loadedAnswers = describeInspectionSqlAnswers(inspectionSql);
  const disagreement = carriedAnswers.findIndex((answer, index) => answer !== loadedAnswers[index]);
  if (disagreement >= 0) {
    throw bundleTemplateError(
      `Server bundle failed: ${modulePath} answers the read-only inspection gate differently than the running CLI's copy of it, `
        + `starting at ${JSON.stringify(INSPECTION_SQL_SKEW_PROBE[disagreement])}.`,
      "dist/ and bin/ are from different builds. Run `npm run build`, or reinstall the Sporades CLI.",
    );
  }

  return `${code}\nconst { ${exported.join(", ")} } = ${INSPECTION_SQL_NAMESPACE};`;
}

export function createServerBundleSource({
  config, 
  serverEnv, 
  sealedServerEnv = { enabled: false }, 
  serverSource, 
  serverModuleSource 
}: {
  config: any;
  serverEnv: any;
  sealedServerEnv?: any;
  serverSource: string;
  serverModuleSource: string;
}) {
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
  // it closes over does not follow. They are declarations inside `inspectionSqlModule` now, and the
  // gate's own functions close over them there exactly as they do in `dist/`, so serializing them
  // again would declare each name twice. They are still reachable by name at the bundle's top level
  // through the destructuring that module block ends with, which is what the constant probe in
  // `test/server-bundle-module-graph.test.js` reads them through.
  const inspectionSqlModule = inspectionSqlModuleSource();
  // The runtime's module-level constants, for the same reason as the keyword tables above: a
  // runtime function reaches the bundle as its own source text and a module-level binding it closes
  // over does not follow. Each is serialized from the runtime source's own declaration rather than
  // restated here, so a threshold is written in exactly one place and changing it there changes
  // what a deployed Capsule enforces. Several of these are security thresholds, and a restated copy
  // that drifted would be silent — the free-binding guard resolves names, and a wrong value
  // resolves exactly as cleanly as a right one.
  const runtimeConstants = ([
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
  ] as [string, unknown][])
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
${inspectionSqlModule}
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
