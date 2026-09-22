import type { ClientToolchainName } from "./client-capabilities.js";
export type ClientPrerenderFragment = Readonly<{
    name: string;
    module: string;
}>;
export declare function readClientPrerenderConfig(value: unknown, toolchain: ClientToolchainName): ClientPrerenderFragment[];
export declare function renderClientPrerenderFragment(projectRoot: string, fragment: ClientPrerenderFragment, projectRoots?: string[], onDependency?: (file: string) => void): Promise<string>;
export declare function rendererTransformOutputLoader(loader: import("esbuild").Loader): "js" | "jsx";
export declare function placeClientPrerenderFragment(html: string, fragment: ClientPrerenderFragment, rendered: string): string;
export type ClientPrerenderWarning = Readonly<{
    code: "PRERENDER_DUPLICATE_PLACEMENT" | "PRERENDER_UNUSED_FRAGMENT" | "PRERENDER_UNKNOWN_MARKER";
    fragment: string;
    message: string;
}>;
export declare function validateClientPrerenderSourceHtml(html: string): void;
export declare function validateClientPrerenderOutputHtml(html: string, expectedBoundaries: readonly string[]): void;
export declare function placeClientPrerenderFragments(html: string, fragments: readonly {
    name: string;
    html: string;
}[]): {
    html: string;
    warnings: Readonly<{
        code: "PRERENDER_DUPLICATE_PLACEMENT" | "PRERENDER_UNUSED_FRAGMENT" | "PRERENDER_UNKNOWN_MARKER";
        fragment: string;
        message: string;
    }>[];
    placements: number;
    boundaries: string[];
};
//# sourceMappingURL=client-prerender.d.ts.map