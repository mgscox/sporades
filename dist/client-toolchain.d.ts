export type ClientToolchainName = "esbuild" | "vite";
export type ClientToolchainDiagnostics = {
    framework: string;
    toolchain: ClientToolchainName;
    refresh: "none" | "full-page";
};
export type NormalizedClientFile = {
    path: string;
    contents: string | Uint8Array;
};
export type ClientToolchainOutput = {
    publicFiles: NormalizedClientFile[];
    legacyClientBundle: string | null;
    diagnostics: ClientToolchainDiagnostics;
};
type FrameworkBuildConfig = {
    framework: string;
    entry: string;
    loader: "ts" | "tsx";
    jsxImportSource: string | null;
    jsxRuntimeImport: string | null;
};
export declare function buildClientToolchain(options: {
    projectDir: string;
    frameworkConfig: FrameworkBuildConfig;
    toolchain: ClientToolchainName;
    clientSource: string;
    clientSourcePath: string;
    indexHtml: string;
    indexHtmlPath: string;
}): Promise<ClientToolchainOutput>;
export {};
//# sourceMappingURL=client-toolchain.d.ts.map