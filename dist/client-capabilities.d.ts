export declare const CLIENT_TEMPLATES: readonly ["blank", "todo", "guestbook", "photo-library", "campfire"];
export type ClientFrameworkName = "vanilla" | "react" | "preact" | "vue" | "svelte" | "solid" | "lit" | "inferno";
export type ClientToolchainName = "esbuild" | "vite";
export type ClientTemplateName = typeof CLIENT_TEMPLATES[number];
export type ClientBuildCapability = Readonly<{
    entry: "index.ts" | "index.tsx";
    loader: "ts" | "tsx";
    jsxImportSource: string | null;
    jsxRuntimeImport: string | null;
    jsxFactory?: string;
}>;
export type ClientCapability = Readonly<{
    framework: ClientFrameworkName;
    label: string;
    toolchain: ClientToolchainName;
    default: boolean;
    templates: readonly ClientTemplateName[];
    build: ClientBuildCapability;
}>;
export declare const CLIENT_CAPABILITIES: readonly ClientCapability[];
export declare const CLIENT_FRAMEWORKS: ("vanilla" | "react" | "preact" | "vue" | "svelte" | "solid" | "lit" | "inferno")[];
export declare const CLIENT_TOOLCHAINS: readonly ["esbuild", "vite"];
export declare function isClientFramework(value: unknown): value is ClientFrameworkName;
export declare function isClientToolchain(value: unknown): value is ClientToolchainName;
export declare function clientFrameworkCapability(framework: unknown): {
    framework: ClientFrameworkName;
    label: string;
    build: Readonly<{
        entry: "index.ts" | "index.tsx";
        loader: "ts" | "tsx";
        jsxImportSource: string | null;
        jsxRuntimeImport: string | null;
        jsxFactory?: string;
    }>;
    templates: readonly ("blank" | "todo" | "guestbook" | "photo-library" | "campfire")[];
} | null;
export declare function clientCapability(framework: unknown, toolchain: unknown): Readonly<{
    framework: ClientFrameworkName;
    label: string;
    toolchain: ClientToolchainName;
    default: boolean;
    templates: readonly ClientTemplateName[];
    build: ClientBuildCapability;
}> | null;
export declare function supportsClientCapability(framework: unknown, toolchain: unknown): boolean;
export declare function defaultClientToolchain(framework: unknown): ClientToolchainName | null;
export declare function resolveClientCapability(framework?: unknown, toolchain?: unknown): Readonly<{
    framework: ClientFrameworkName;
    label: string;
    toolchain: ClientToolchainName;
    default: boolean;
    templates: readonly ClientTemplateName[];
    build: ClientBuildCapability;
}> | null;
export declare function clientCapabilityError(framework: unknown, toolchain: unknown): {
    message: string;
    hint: string;
};
export declare const CLIENT_FRAMEWORK_HINT: string;
export declare const CLIENT_TOOLCHAIN_HINT: string;
//# sourceMappingURL=client-capabilities.d.ts.map