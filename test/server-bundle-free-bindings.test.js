import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { MIGRATED_RUNTIME_MODULE_FILES, createServerBundleSource } from "../dist/templates/server-bundle-template.js";

// The generated server bundle is not compiled from a module graph. It is assembled by writing out
// `fn.toString()` for every entry in `SERVER_RUNTIME_SOURCE_FUNCTIONS` next to a constant preamble,
// so a runtime function travels into the bundle as its own source text and nothing it closes over
// travels with it. A function that references a name outside that list becomes a free binding in
// the emitted file: legal JavaScript, a clean build, and a `ReferenceError` the first time a
// deployed Capsule executes that path.
//
// Nothing in the ordinary test suite sees this. Tests import the runtime functions from `dist/`,
// where every one of those references resolves to a real module binding, so the emitted bundle is
// the only place the gap exists and executing the path is the only way to find it. Four bindings
// shipped that way for some time — `validateReadOnlyInspectionSql`, `setEmailPassword`,
// `markAsyncAclHelperRead`, `resolveAclStorageFileReference` — each reachable from a deployed
// Capsule, each invisible to a green suite.
//
// This file removes the class rather than those four. It assembles the bundle the same way the
// Bundle pipeline does, resolves every identifier in it against the scopes the bundle itself
// declares plus the globals a Capsule actually runs with, and fails on anything left over.
//
// The resolver is TypeScript's own checker. A correct answer here needs real scope resolution —
// hoisting, shadowing, destructuring, catch parameters, closures over 12,000 lines — and
// `typescript` is already a declared dependency that `npm run build` and `pretest` both run, so
// this costs no new supply-chain surface. Its "Cannot find name" diagnostics are exactly the
// question being asked.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// A path inside the repository so that `types: ["node"]` resolves upward to `node_modules/@types`
// the way it does for any other file here. The file is served from memory and never written.
const BUNDLE_PROBE_PATH = path.join(REPO_ROOT, "__server-bundle-scope-probe__.mjs");

const COMPILER_OPTIONS = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  // The language plus Node's globals, and nothing else. No DOM library: a runtime function that
  // reached for a browser global would be exactly as undefined in a Hosted Capsule as one that
  // reached for a name nobody declared, and this check should say so.
  lib: ["lib.esnext.d.ts"],
  types: ["node"],
  skipLibCheck: true,
  strict: false,
};

// The three ways the checker reports that an identifier resolved to no binding in any enclosing
// scope. 2304 is the bare form, 2552 the same finding with a spelling suggestion attached, and
// 18004 the shorthand-property form (`{ handler }` with no `handler` in scope). Each puts the
// unresolved name first in single quotes.
const UNRESOLVED_IDENTIFIER_CODES = new Set([2304, 2552, 18004]);

// The check itself, as a function over source text rather than over the bundle, so that its own
// failure can be exercised below against source that deliberately contains one.
function unresolvedIdentifiers(source) {
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const readSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getCurrentDirectory = () => REPO_ROOT;
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === BUNDLE_PROBE_PATH
      ? ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.JS)
      : readSourceFile(fileName, languageVersion, ...rest);
  host.fileExists = (fileName) => fileName === BUNDLE_PROBE_PATH || fileExists(fileName);
  host.readFile = (fileName) => (fileName === BUNDLE_PROBE_PATH ? source : readFile(fileName));

  const program = ts.createProgram([BUNDLE_PROBE_PATH], COMPILER_OPTIONS, host);
  const sourceFile = program.getSourceFile(BUNDLE_PROBE_PATH);
  assert.ok(sourceFile, "the bundle source was not handed to the checker");

  const lines = new Map();
  for (const diagnostic of program.getSemanticDiagnostics(sourceFile)) {
    if (!UNRESOLVED_IDENTIFIER_CODES.has(diagnostic.code)) continue;
    const [, name] = /'([^']+)'/.exec(ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")) ?? [];
    if (!name) continue;
    const { line } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    lines.set(name, [...(lines.get(name) ?? []), line + 1]);
  }
  return [...lines]
    .map(([name, at]) => ({ name, lines: at.sort((left, right) => left - right) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

// The report the next person to see this fail will be reading, most likely mid-refactor. It names
// the identifiers plainly and says where the definition has to be added.
function describeUnresolvedIdentifiers(unresolved) {
  return [
    "The generated server bundle references identifiers it does not define. Each one is a",
    "`ReferenceError` the first time a deployed Capsule executes the path that reaches it, and no",
    "adapter test will see it, because tests import these functions from `dist/` where the same",
    "references resolve.",
    "",
    ...unresolved.map(({ name, lines }) => {
      const rest = lines.length > 1 ? ` and ${lines.length - 1} more reference${lines.length > 2 ? "s" : ""}` : "";
      return `  ${name} — emitted bundle line ${lines[0]}${rest}`;
    }),
    "",
    "A runtime function is emitted into the bundle as its own source text, so everything it",
    "references has to be emitted alongside it. Add each name to SERVER_RUNTIME_SOURCE_FUNCTIONS in",
    "src/server-runtime-source.ts, or, if it is a module-level constant rather than a function, to",
    "the constant preamble in src/templates/server-bundle-template.ts.",
  ].join("\n");
}

// The bundle the Bundle pipeline assembles, built through the same entry point. The Capsule inputs
// are minimal on purpose: the app's own server source travels as an opaque string and a base64
// data URL, so what is under test here is the runtime the pipeline wraps around them.
function generatedServerBundle() {
  return createServerBundleSource({
    config: { name: "scope-probe", deploy: { port: 4000 } },
    serverEnv: {},
    serverSource: "",
    serverModuleSource: "export default {};",
  });
}

test("the resolver reports a free binding and stays quiet about resolvable ones", () => {
  // Guard the measurement before trusting it. A resolver that had lost its Node globals, or that
  // had stopped seeing the file at all, would report either everything or nothing — and reporting
  // nothing is indistinguishable from a clean bundle. This settles both directions on source small
  // enough to read: every name below resolves except `neverDeclaredHelper`.
  const resolvable = [
    'import { createHash } from "node:crypto";',
    "const declared = 1;",
    "export function emitted(rows) {",
    "  const { first, ...rest } = rows;",
    "  try { return createHash('sha256').update(String(first ?? declared)).digest('hex'); }",
    "  catch (error) { return process.env.HOME ?? Buffer.from(String(error)).toString('base64') + rest; }",
    "}",
    "export function alsoEmitted() { return emitted([]) + globalThis.structuredClone(1) + setTimeout(() => 0, 1); }",
  ].join("\n");

  assert.deepEqual(unresolvedIdentifiers(resolvable), []);

  const withFreeBinding = `${resolvable}\nexport function reachesNothing() { return neverDeclaredHelper(1); }\n`;
  assert.deepEqual(unresolvedIdentifiers(withFreeBinding), [{ name: "neverDeclaredHelper", lines: [9] }]);
});

test("every identifier the generated server bundle references is defined within it", () => {
  const bundle = generatedServerBundle();

  // Guard the measurement again, on the real input this time: an empty or truncated bundle would
  // satisfy the assertion below without checking anything.
  assert.ok(bundle.length > 100_000, `expected the generated server bundle, saw ${bundle.length} bytes`);
  assert.match(bundle, /\bfunction openDevDatabase\b/, "the generated server bundle does not contain the runtime functions");

  assert.deepEqual(unresolvedIdentifiers(bundle), [], describeUnresolvedIdentifiers(unresolvedIdentifiers(bundle)));
});

// ---------------------------------------------------------------------------------------------
// The half of this class the check above structurally cannot see, and the batch that found out.
//
// Everything above builds the bundle from `dist/`, because that is what the suite imports. The CLI
// that people actually run is `bin/sporades.js`, which is the whole of `src/` bundled by esbuild
// into one scope — and esbuild renames a binding when two modules in that scope declare the same
// top-level name. Rename one that `server-runtime-source.ts` imports, and every still-registered
// runtime function travels into the emitted bundle as source text calling the *renamed* name, while
// the bundle's hand-written preamble still imports the original.
//
// That is a free binding in the shipped artifact that no build and no `dist/`-based check can see.
// It shipped: batch 2's mail module opened with `const randomUUID = () => crypto.randomUUID()`,
// which collided with `server-runtime-source.ts`'s `import { randomUUID } from "node:crypto"`,
// esbuild renamed the import to `randomUUID2` inside `bin/`, and fourteen container tests failed
// with `randomUUID2 is not defined` out of a deployed Capsule while every check in this file passed.
//
// So the collision is refused at its source rather than the rename detected at its destination. A
// migrated module may not declare a top-level name that `server-runtime-source.ts` also binds —
// except where the two names are *the same binding*, which is two cases rather than one:
//
//   - the monolith imports the name *from* the module being checked (`createMailRuntime`), and
//   - both of them import the name from the same third module.
//
// The second arrived with batch 3 and is the reason this reads origins rather than only names.
// `commandError` lives in `runtime-errors.js`; `auth-runtime.ts` imports it and so does
// `server-runtime-source.ts`, and esbuild resolves both to the one declaration in `bin/` with
// nothing to rename. Refusing that would have forced the auth domain to reach its error constructor
// through some other spelling for a hazard that does not exist — the same shape as ADR-0041's
// "any external at all" rule turning out to be one kind too broad.
//
// The narrowing is safe only because a *declaration* is still refused whatever its name: batch 2's
// `const randomUUID = () => crypto.randomUUID()` has no origin, so it is not the same binding as the
// monolith's `import { randomUUID } from "node:crypto"` and still fails here by name.
function topLevelBindings(source, label) {
  const parsed = ts.createSourceFile(label, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const declared = new Set();
  const importedFrom = new Map();
  for (const node of parsed.statements) {
    if (ts.isImportDeclaration(node)) {
      const from = node.moduleSpecifier.text;
      const names = [];
      const clause = node.importClause;
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) names.push(element.name.text);
      }
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name.text);
      for (const name of names) {
        declared.add(name);
        importedFrom.set(name, from);
      }
      continue;
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) declared.add(node.name.text);
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name)) declared.add(d.name.text);
    }
  }
  return { declared, importedFrom };
}

test("no migrated runtime module declares a name that would be renamed inside bin/", () => {
  const runtimeSource = readFileSync(new URL("../dist/server-runtime-source.js", import.meta.url), "utf8");
  const runtime = topLevelBindings(runtimeSource, "server-runtime-source.js");

  // Guard the measurement before trusting it. A parse that collected nothing would make the
  // assertion below pass by having no subjects, which is indistinguishable from a clean tree.
  assert.ok(runtime.declared.size > 200, `expected server-runtime-source's top-level bindings, saw ${runtime.declared.size}`);
  assert.ok(runtime.declared.has("randomUUID"), "server-runtime-source no longer imports randomUUID — this guard's worked example is stale");
  assert.ok(MIGRATED_RUNTIME_MODULE_FILES.length >= 2, "no migrated modules to check");

  const collisions = [];
  for (const file of MIGRATED_RUNTIME_MODULE_FILES) {
    const source = readFileSync(new URL(`../dist/${file}`, import.meta.url), "utf8");
    const { declared, importedFrom } = topLevelBindings(source, file);
    assert.ok(declared.size > 0, `expected the top-level bindings of dist/${file}, saw none`);
    for (const name of declared) {
      // Imported from this very module: one binding, renamed together, harmless.
      if (runtime.importedFrom.get(name) === `./${file}`) continue;
      // Imported by both of them from the same third module: also one binding. Every migrated module
      // sits beside `server-runtime-source.js` in `dist/`, so the two specifiers are comparable as
      // written; `undefined === undefined` is not a match, because a name neither of them imports is
      // a declaration on at least one side and that is the case being refused.
      const origin = importedFrom.get(name);
      if (origin !== undefined && runtime.importedFrom.get(name) === origin) continue;
      if (runtime.declared.has(name)) collisions.push(`${file} declares ${name}`);
    }
  }

  assert.deepEqual(
    collisions,
    [],
    "a migrated runtime module declares a top-level name that server-runtime-source.ts also binds. Inside bin/sporades.js both land in one esbuild scope, so one is renamed — and every emitted runtime function then references the renamed name while the bundle preamble imports the original, which is a ReferenceError in a deployed Capsule that no dist/-based check can see. Rename the one in the migrated module.",
  );
});

test("the check reports a runtime function that references something the bundle does not define", () => {
  // The failure this file exists for, exercised against the real bundle rather than a fixture. The
  // appended function is shaped like the four that shipped: an ordinary runtime function calling an
  // ordinary helper that simply never reached the emitted list.
  const injected = [
    generatedServerBundle(),
    "function runtimeFunctionThatWasNotAccompanied(sql) {",
    "  return helperThatNeverReachedTheEmittedList(sql);",
    "}",
    "",
  ].join("\n");

  const unresolved = unresolvedIdentifiers(injected);
  assert.deepEqual(unresolved.map(({ name }) => name), ["helperThatNeverReachedTheEmittedList"]);

  const report = describeUnresolvedIdentifiers(unresolved);
  assert.match(report, /helperThatNeverReachedTheEmittedList — emitted bundle line \d+/);
  assert.match(report, /SERVER_RUNTIME_SOURCE_FUNCTIONS/);
});
