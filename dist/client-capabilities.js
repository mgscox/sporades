export const CLIENT_TEMPLATES = ["blank", "todo", "guestbook", "photo-library", "campfire"];
export const CLIENT_CAPABILITIES = Object.freeze([
    { framework: "vanilla", toolchain: "esbuild", default: true },
    { framework: "react", toolchain: "esbuild", default: true }, { framework: "react", toolchain: "vite", default: false },
    { framework: "preact", toolchain: "esbuild", default: true }, { framework: "preact", toolchain: "vite", default: false },
    { framework: "vue", toolchain: "vite", default: true }, { framework: "svelte", toolchain: "vite", default: true },
    { framework: "solid", toolchain: "vite", default: true }, { framework: "lit", toolchain: "vite", default: true },
    { framework: "inferno", toolchain: "esbuild", default: true }, { framework: "inferno", toolchain: "vite", default: false },
]);
export const CLIENT_FRAMEWORKS = [...new Set(CLIENT_CAPABILITIES.map(({ framework }) => framework))];
export const CLIENT_TOOLCHAINS = [...new Set(CLIENT_CAPABILITIES.map(({ toolchain }) => toolchain))];
export function supportsClientCapability(framework, toolchain) { return CLIENT_CAPABILITIES.some((cell) => cell.framework === framework && cell.toolchain === toolchain); }
export function defaultClientToolchain(framework) { return CLIENT_CAPABILITIES.find((cell) => cell.framework === framework && cell.default)?.toolchain ?? null; }
//# sourceMappingURL=client-capabilities.js.map