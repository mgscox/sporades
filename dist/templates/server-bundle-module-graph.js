import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The module the boot program reads its per-build values from. Substituted for the virtual
// specifier `sporades:server-bundle-inputs`, which nothing else resolves, so a build where this
// substitution did not happen fails rather than producing a Capsule with an empty config.
function createBundleInputsModule(options) {
    const capsuleModuleDataUrl = `data:text/javascript;base64,${Buffer.from(options.serverModuleSource, "utf8").toString("base64")}`;
    return [
        `export const sporadesConfig = ${JSON.stringify(options.config, null, 2)};`,
        `export const sporadesServerEnv = ${JSON.stringify(options.serverEnv, null, 2)};`,
        `export const sporadesSealedServerEnv = ${JSON.stringify(options.sealedServerEnv ?? { enabled: false }, null, 2)};`,
        `export const sporadesServerSource = ${JSON.stringify(options.serverSource)};`,
        `export const sporadesCapsuleModuleUrl = ${JSON.stringify(capsuleModuleDataUrl)};`,
    ].join("\n");
}
function bundleModuleGraphError(message, hint) {
    return Object.assign(new Error(message), { hint });
}
// Builds the deployed Capsule's server bundle from an ordinary module graph.
//
// This is the same program `createServerBundleSource` produces, resolved by esbuild from real
// imports instead of assembled from `fn.toString()` next to a hand-written constant preamble. Both
// builders exist: the emitted-list one is still the artifact that ships, and this one is here to be
// shown equivalent to it first.
//
// The graph is rooted at the compiled entry in `dist/`, not at the TypeScript source, because a
// published Sporades CLI ships `dist/` and not `src/`. esbuild is a direct dependency and already
// builds the Capsule module and the client pipeline, so nothing new is required at bundle time.
//
// There is a real self-containment requirement behind the original `toString()` approach, and it is
// the one thing about that approach that must survive: a deployed Capsule cannot resolve a bare
// specifier at runtime. `Dockerfile.base` is `node:22-alpine` with no install step and no
// `node_modules` anywhere, its `CMD` is `node /app/server.mjs`, and the release mounts only
// `server.mjs`, `sporades.json` and the public tree into `/app`, read-only — see
// `bundle-pipeline.ts`'s container mounts and `cli/host-helper-release-files.ts`. That is why the
// Capsule module travels as a base64 `data:` URL instead of as a second file.
//
// It is a self-containment requirement and not a `toString()` requirement: bundling satisfies it
// just as completely, provided the output imports nothing but builtins. The guard below is what
// makes that a property of the build rather than of anyone's memory. No other constraint was found
// — the bundle is written once and read only as an opaque file, nothing inspects its text, no size
// limit applies to it, and the one-shot action path depends on the Capsule module staying
// unevaluated rather than on how the runtime got there.
export async function createServerBundleModuleSource(options) {
    const { build } = await import("esbuild");
    const entryPath = fileURLToPath(new URL("./server-bundle-entry.js", import.meta.url));
    const entrySource = await readFile(entryPath, "utf8");
    const inputsModule = createBundleInputsModule(options);
    let result;
    try {
        result = await build({
            bundle: true,
            format: "esm",
            platform: "node",
            target: "node22",
            write: false,
            metafile: true,
            logLevel: "silent",
            stdin: {
                contents: options.epilogue ? `${entrySource}\n${options.epilogue}\n` : entrySource,
                sourcefile: entryPath,
                resolveDir: path.dirname(entryPath),
                loader: "js",
            },
            plugins: [
                {
                    name: "sporades-server-bundle-inputs",
                    setup(pluginBuild) {
                        pluginBuild.onResolve({ filter: /^sporades:server-bundle-inputs$/ }, () => ({
                            path: "sporades:server-bundle-inputs",
                            namespace: "sporades-bundle-inputs",
                        }));
                        pluginBuild.onLoad({ filter: /.*/, namespace: "sporades-bundle-inputs" }, () => ({
                            loader: "js",
                            contents: inputsModule,
                        }));
                    },
                },
            ],
        });
    }
    catch (error) {
        const message = error?.errors?.map((entry) => entry.text).join("; ") || error?.message || String(error);
        throw bundleModuleGraphError(`Server bundle failed: ${message}`, "Report this: the Sporades runtime module graph did not build.");
    }
    const output = result.outputFiles?.[0];
    if (!output) {
        throw bundleModuleGraphError("Server bundle failed: esbuild returned no output.", "Report this: the Sporades runtime module graph produced no bundle.");
    }
    // A deployed Capsule runs `node /app/server.mjs` with `server.mjs` mounted read-only into an
    // image that carries no `node_modules`, so the bundle can import nothing but Node's own builtins.
    // Asked of esbuild's metafile rather than of the output text: this is the constraint the
    // `toString()` mechanism satisfied by construction, and it has to keep holding by construction
    // here too rather than by anyone remembering it. `isBuiltin` rather than a `node:` prefix test,
    // because an unprefixed `fs` resolves in the container exactly as well as `node:fs` does; `data:`
    // alongside it because a data URL carries its own bytes and reaches no filesystem, which is how
    // the Capsule module itself travels.
    const unresolved = Object.values(result.metafile.outputs)
        .flatMap((entry) => entry.imports)
        .filter((entry) => entry.external && !isBuiltin(entry.path) && !entry.path.startsWith("data:"))
        .map((entry) => entry.path);
    if (unresolved.length > 0) {
        throw bundleModuleGraphError(`Server bundle failed: the bundle would import ${[...new Set(unresolved)].sort().join(", ")} at runtime.`, "A deployed Capsule has no node_modules. Every dependency must be inlined into the bundle.");
    }
    return output.text;
}
//# sourceMappingURL=server-bundle-module-graph.js.map