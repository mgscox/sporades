import { isBuiltin } from "node:module";
import path from "node:path";
import { buildSync } from "esbuild";
import * as inspectionSql from "../inspection-sql.js";
import * as logIndexGuard from "../log-index-guard.js";
import * as mailConfig from "../mail-config.js";
import * as mailRuntime from "../mail-runtime.js";
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
    { file: "mail-config.js", loaded: mailConfig },
    { file: "mail-runtime.js", loaded: mailRuntime },
];
// The same list as file names, for guards that have to read the modules off disk rather than call
// them. Exported so that `test/server-bundle-free-bindings.test.js` cannot go out of step with what
// is actually carried — the one thing this migration keeps proving is that a second, hand-kept copy
// of this list is how a guard quietly stops covering a domain.
export const MIGRATED_RUNTIME_MODULE_FILES = MIGRATED_RUNTIME_MODULES.map(({ file }) => file);
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
// Mail configurations the carried copy of `mail-config` and the running one must judge the same way.
// Six are refused and four admitted, for the same reason the statement probe above is split both
// ways: a carried `validateMailConfig` replaced by one that returns its input unchanged answers
// every admitted case correctly and is caught only by a refused one, and one that refuses
// everything is caught only by an admitted one.
//
// The refused half is drawn from what this validator exists to stop rather than from what is merely
// malformed — credentials offered over a plaintext or opportunistically-encrypted hop, a Server env
// reference reaching into the reserved `SPORADES_` namespace, a header-splitting sender, and a TLS
// mode that is not one of the four. Those are the limbs whose loss would be silent.
export const MIGRATED_MODULE_MAIL_CONFIG_SKEW_PROBE = [
    undefined,
    { smtp: { vendor: "generic", host: "smtp.example.com", port: 587, tls: { mode: "required-starttls" }, auth: { method: "PLAIN", usernameEnv: "SMTP_USERNAME", passwordEnv: "SMTP_PASSWORD" } } },
    { smtp: { vendor: "generic", host: "smtp.example.com", port: 465, tls: { mode: "implicit", rejectUnauthorized: false, servername: "mail.example.com" }, auth: { method: "LOGIN", usernameEnv: "U", passwordEnv: "P" }, defaultFrom: "a@example.com", connectionTimeoutMs: 5000, socketTimeoutMs: 30000 } },
    { smtp: { vendor: "generic", host: "127.0.0.1", port: 25, tls: { mode: "disabled" }, auth: { method: "none" } } },
    { smtp: { vendor: "generic", host: "smtp.example.com", port: 25, tls: { mode: "opportunistic" }, auth: { method: "PLAIN", usernameEnv: "U", passwordEnv: "P" } } },
    { smtp: { vendor: "generic", host: "smtp.example.com", port: 25, tls: { mode: "disabled" }, auth: { method: "PLAIN", usernameEnv: "U", passwordEnv: "P" } } },
    { smtp: { vendor: "generic", host: "smtp.example.com", port: 587, tls: { mode: "required-starttls" }, auth: { method: "PLAIN", usernameEnv: "SPORADES_SECRET", passwordEnv: "P" } } },
    { smtp: { vendor: "generic", host: "smtp.example.com", port: 587, tls: { mode: "starttls" }, auth: { method: "none" } } },
    { smtp: { vendor: "generic", host: "smtp.example.com", port: 587, tls: { mode: "required-starttls" }, auth: { method: "none" }, defaultFrom: "a@example.com\r\nBcc: b@example.com" } },
    { smtp: { vendor: "generic", host: "smtp.example.com", port: 0, tls: { mode: "required-starttls" }, auth: { method: "none" } } },
];
// Messages the carried copy of `mail-runtime` and the running one must assemble into identical MIME.
// This domain's header folding, RFC 2047 encoding, base64 wrapping and Mailgun JSON folding are all
// private to that module, and `buildSmtpMessage` is the only exported name that reaches them — so a
// probe that did not call it could not see any of the four change. The shapes below are chosen to
// reach one limb each.
//
// What this probe does *not* reach is the rest of the domain: the SMTP conversation, the transport's
// error normalization, and the message and provider normalizers upstream of it. Those need a socket
// or an exported entry point, and stating the gap is better than implying the probe covers a domain
// it covers one half of. `test/mail.test.js` is what covers the rest, against `dist/`.
//
// Every message pins `messageId` and carries exactly one body. Both are deliberate:
// `buildSmtpMessage` mints a `randomUUID()` for an absent Message-ID and another for the multipart
// boundary, and two bodies are what make it multipart — so either would make the two copies disagree
// on every build for no reason. The `Date` header is generated the same way and cannot be pinned at
// all, so the comparison below strips it.
export const MIGRATED_MODULE_MAIL_MESSAGE_SKEW_PROBE = [
    { from: { email: "a@example.com" }, to: [{ email: "b@example.com" }], cc: [], subject: "Plain", messageId: "<1@sporades.local>", textBody: "hello" },
    { from: { email: "a@example.com", name: "Ada Lovelace" }, to: [{ email: "b@example.com", name: "Bob" }], cc: [{ email: "c@example.com" }], replyTo: { email: "r@example.com" }, subject: "Uberändert — café naïve 🚀", messageId: "<2@sporades.local>", htmlBody: "<p>hi</p>" },
    { from: { email: "a@example.com", name: 'Quote "me", back\\slash' }, to: [{ email: "b@example.com" }], cc: [], subject: "x".repeat(200), messageId: "<3@sporades.local>", textBody: "body" },
    // The Mailgun value is two tokens rather than one long one on purpose: `foldMailgunJsonHeader`
    // refuses any single JSON token over 997 characters, so a 1,200-character value would exercise
    // that refusal instead of the folding this message is here to compare. Two 400-character values
    // put the header past SMTP's 998-character line limit while leaving every token foldable.
    { from: { email: "a@example.com" }, to: [{ email: "b@example.com" }], cc: [], subject: "Provider headers", messageId: "<4@sporades.local>", textBody: "body", providerHeaders: [{ name: "X-PM-Tag", value: "welcome" }, { name: "X-Mailgun-Variables", value: `{"a":"${"v".repeat(400)}","b":"${"w".repeat(400)}"}`, json: true }, { name: "X-Verbatim", value: "kept as-is" }] },
    { from: { email: "a@example.com" }, to: [{ email: "b@example.com" }, { email: "c@example.com" }, { email: "d@example.com" }], cc: [], subject: "Folding a long recipient list across the SMTP line limit for good measure", messageId: "<5@sporades.local>", textBody: "z".repeat(300) },
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
    "validateMailConfig",
    "buildSmtpMessage",
];
// What a probed call answered, as one comparable string, whether it returned or threw. The mail
// limbs need this and the inspection ones do not: `validateReadOnlyInspectionSql` reports a refusal
// by returning `{ ok: false }`, while `validateMailConfig` reports one by throwing, and a comparison
// that let the throw escape would fail the build with the validator's own message and no indication
// that two copies of a module were being compared. The error's `code` and `message` are part of the
// answer, so a carried copy that refuses the right configurations for the wrong reason is a
// disagreement rather than a match.
function probedAnswer(call) {
    try {
        return { returned: call() };
    }
    catch (error) {
        return { threw: { code: error?.code ?? null, message: String(error?.message ?? error) } };
    }
}
// What the two copies of the migrated modules answer, as comparable text. The inspection gate over
// the statement probe, then the log-index guard over the same statements and over the row probe —
// the guard reads rows as well as SQL, and a check that only asked about SQL could not see half of
// it go missing. Then the mail domain, which answers a question in a different shape again: a
// configuration is judged by throwing rather than by returning a verdict, and a message is answered
// with the MIME text it assembles.
//
// Every migrated module needs a limb here or it is carried without being compared, which is the
// state this whole check exists to make unreachable. A batch that adds a module to
// `MIGRATED_RUNTIME_MODULES` and nothing to this function has bought the export-surface check and
// none of the behavioural one.
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
        ...MIGRATED_MODULE_MAIL_CONFIG_SKEW_PROBE.map((config) => JSON.stringify([config, probedAnswer(() => module.validateMailConfig(config))])),
        // The `Date` header is `new Date().toUTCString()` and cannot be pinned from outside, so the two
        // copies are compared without it. Stripped rather than tolerated: a comparison that ignored any
        // line beginning `Date:` would also ignore one a skewed copy had emitted wrongly, and dropping
        // exactly one line keeps the rest of the message — every folded header, every encoded word, the
        // base64 body — under comparison.
        ...MIGRATED_MODULE_MAIL_MESSAGE_SKEW_PROBE.map((message) => JSON.stringify([
            message.messageId,
            probedAnswer(() => {
                const mime = module.buildSmtpMessage(message);
                return typeof mime === "string"
                    ? mime.split("\r\n").filter((line) => !line.startsWith("Date: ")).join("\r\n")
                    : mime;
            }),
        ])),
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
    // this block must resolve nothing at runtime that the image cannot supply. Asked of esbuild's
    // metafile rather than of the text, because this is exactly where the property stops holding by
    // construction: the moment a migrated module imports something outside this list, `format: "iife"`
    // emits a `require(…)` for it and the Capsule dies at boot rather than at build.
    //
    // **One kind of external is allowed, and only because it is not lowered.** A *static* import — of a
    // package or of a builtin, it makes no difference — becomes `__require("node:crypto")`, which
    // throws `Dynamic require of "node:crypto" is not supported` on the first line of a bundle that is
    // an ES module. That was executed, not assumed, and it is why the mail domain reaches the Web
    // Crypto global instead of importing `randomUUID`. A *dynamic* `import(…)` is different in kind:
    // esbuild emits it verbatim, so `await import("node:tls")` survives into the block as itself and a
    // deployed Capsule resolves it exactly as it resolves the bundle's own top-level
    // `import … from "node:crypto"`. The mail transport has opened its TLS and TCP sockets that way
    // since long before any of this, through the same text, and refusing it here would have forced
    // that one function to stay behind in the monolith for a reason that does not exist.
    //
    // So the rule is narrower than "no externals" and stricter than the module-graph builder's: a
    // dynamic import of a Node builtin, and nothing else. A dynamic import of a *package* is still
    // refused — it survives verbatim too, and then finds no `node_modules` in the image.
    //
    // ADR-0041 named this as the untested case; batch 2 is where it was executed. `isBuiltin` rather
    // than a `node:` prefix test, matching `createServerBundleModuleSource`: an unprefixed `tls`
    // resolves in the container exactly as well as `node:tls` does.
    const unresolved = Object.values(result.metafile.outputs)
        .flatMap((entry) => entry.imports)
        .filter((entry) => entry.external && !(entry.kind === "dynamic-import" && isBuiltin(entry.path)))
        .map((entry) => entry.path);
    if (unresolved.length > 0) {
        throw bundleTemplateError(`Server bundle failed: the migrated runtime modules would resolve ${[...new Set(unresolved)].sort().join(", ")} at runtime.`, "A migrated runtime module may import another migrated module, or a Node builtin through a dynamic `import(…)`. A static import of anything outside the migrated set becomes a `require(…)` the bundle cannot execute: add the dependency to MIGRATED_RUNTIME_MODULES, or inline what it needs.");
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
        throw bundleTemplateError(
        // Not "the read-only inspection surface" any more. That is what the probe was when the only
        // migrated modules were the inspection gate and the log-index guard, and it became wrong the
        // moment a mail disagreement started reporting itself under an inspection heading.
        `Server bundle failed: the migrated runtime modules in ${distDir} answer the skew probe differently `
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