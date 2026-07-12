export declare const CLIENT_TEMPLATES: readonly ["blank", "todo", "guestbook", "photo-library", "campfire"];
export declare const CLIENT_CAPABILITIES: readonly [{
    readonly framework: "vanilla";
    readonly toolchain: "esbuild";
    readonly default: true;
}, {
    readonly framework: "react";
    readonly toolchain: "esbuild";
    readonly default: true;
}, {
    readonly framework: "react";
    readonly toolchain: "vite";
    readonly default: false;
}, {
    readonly framework: "preact";
    readonly toolchain: "esbuild";
    readonly default: true;
}, {
    readonly framework: "preact";
    readonly toolchain: "vite";
    readonly default: false;
}, {
    readonly framework: "vue";
    readonly toolchain: "vite";
    readonly default: true;
}, {
    readonly framework: "svelte";
    readonly toolchain: "vite";
    readonly default: true;
}, {
    readonly framework: "solid";
    readonly toolchain: "vite";
    readonly default: true;
}, {
    readonly framework: "lit";
    readonly toolchain: "vite";
    readonly default: true;
}, {
    readonly framework: "inferno";
    readonly toolchain: "esbuild";
    readonly default: true;
}, {
    readonly framework: "inferno";
    readonly toolchain: "vite";
    readonly default: false;
}];
export declare const CLIENT_FRAMEWORKS: ("vue" | "svelte" | "solid" | "inferno" | "preact" | "lit" | "react" | "vanilla")[];
export declare const CLIENT_TOOLCHAINS: ("esbuild" | "vite")[];
export declare function supportsClientCapability(framework: unknown, toolchain: unknown): boolean;
export declare function defaultClientToolchain(framework: unknown): "esbuild" | "vite" | null;
//# sourceMappingURL=client-capabilities.d.ts.map