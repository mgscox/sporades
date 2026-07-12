export const CLIENT_TEMPLATES = deepFreeze(["blank", "todo", "guestbook", "photo-library", "campfire"]);
const frameworkDefinitions = deepFreeze([
    { framework: "vanilla", label: "Vanilla TypeScript", build: { entry: "index.ts", loader: "ts", jsxImportSource: null, jsxRuntimeImport: null }, toolchains: ["esbuild"] },
    { framework: "react", label: "React", build: { entry: "index.tsx", loader: "tsx", jsxImportSource: "react", jsxRuntimeImport: "react/jsx-runtime" }, toolchains: ["esbuild", "vite"] },
    { framework: "preact", label: "Preact", build: { entry: "index.tsx", loader: "tsx", jsxImportSource: "preact", jsxRuntimeImport: "preact/jsx-runtime" }, toolchains: ["esbuild", "vite"] },
    { framework: "inferno", label: "Inferno", build: { entry: "index.tsx", loader: "tsx", jsxImportSource: null, jsxRuntimeImport: null, jsxFactory: "createElement" }, toolchains: ["esbuild", "vite"] },
    { framework: "lit", label: "Lit", build: { entry: "index.ts", loader: "ts", jsxImportSource: null, jsxRuntimeImport: null }, toolchains: ["vite"] },
    { framework: "solid", label: "SolidJS", build: { entry: "index.tsx", loader: "tsx", jsxImportSource: "solid-js", jsxRuntimeImport: "solid-js/jsx-runtime" }, toolchains: ["vite"] },
    { framework: "vue", label: "Vue", build: { entry: "index.ts", loader: "ts", jsxImportSource: null, jsxRuntimeImport: null }, toolchains: ["vite"] },
    { framework: "svelte", label: "Svelte", build: { entry: "index.ts", loader: "ts", jsxImportSource: null, jsxRuntimeImport: null }, toolchains: ["vite"] },
]);
export const CLIENT_CAPABILITIES = deepFreeze(frameworkDefinitions.flatMap((definition) => definition.toolchains.map((toolchain, index) => ({
    framework: definition.framework,
    label: definition.label,
    toolchain,
    default: index === 0,
    templates: CLIENT_TEMPLATES,
    build: definition.build,
}))));
export const CLIENT_FRAMEWORKS = deepFreeze(frameworkDefinitions.map(({ framework }) => framework));
export const CLIENT_TOOLCHAINS = deepFreeze(["esbuild", "vite"]);
export function isClientFramework(value) {
    return CLIENT_FRAMEWORKS.some((framework) => framework === value);
}
export function isClientToolchain(value) {
    return CLIENT_TOOLCHAINS.some((toolchain) => toolchain === value);
}
export function clientFrameworkCapability(framework) {
    if (!isClientFramework(framework))
        return null;
    const cell = CLIENT_CAPABILITIES.find((candidate) => candidate.framework === framework);
    return deepFreeze({ framework: cell.framework, label: cell.label, build: cell.build, templates: cell.templates });
}
export function clientCapability(framework, toolchain) {
    return CLIENT_CAPABILITIES.find((cell) => cell.framework === framework && cell.toolchain === toolchain) ?? null;
}
export function supportsClientCapability(framework, toolchain) {
    return clientCapability(framework, toolchain) !== null;
}
export function defaultClientToolchain(framework) {
    return CLIENT_CAPABILITIES.find((cell) => cell.framework === framework && cell.default)?.toolchain ?? null;
}
export function resolveClientCapability(framework = "react", toolchain) {
    const resolvedFramework = framework ?? "react";
    const resolvedToolchain = toolchain ?? defaultClientToolchain(resolvedFramework);
    return clientCapability(resolvedFramework, resolvedToolchain);
}
export function clientCapabilityError(framework, toolchain) {
    const message = `Unsupported client framework/toolchain combination: ${framework}/${toolchain}`;
    if (framework === "vanilla" && toolchain === "vite")
        return { message, hint: "Use React or Preact with Vite, or keep Vanilla TypeScript on esbuild." };
    const definition = clientFrameworkCapability(framework);
    if (definition && defaultClientToolchain(framework) === "vite")
        return { message, hint: `Use ${definition.label} with Vite.` };
    return { message, hint: "Choose an admitted pair from the client capability matrix in docs/user-guide.md." };
}
export const CLIENT_FRAMEWORK_HINT = `Use one of: ${CLIENT_FRAMEWORKS.filter((framework) => framework !== "vanilla").join(", ")}, vanilla.`;
export const CLIENT_TOOLCHAIN_HINT = `Use one of: ${CLIENT_TOOLCHAINS.join(", ")}.`;
function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}
//# sourceMappingURL=client-capabilities.js.map