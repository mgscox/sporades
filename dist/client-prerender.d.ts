import type { ClientToolchainName } from "./client-capabilities.js";
export type ClientPrerenderFragment = Readonly<{
    name: string;
    module: string;
}>;
export declare function readClientPrerenderConfig(value: unknown, toolchain: ClientToolchainName): ClientPrerenderFragment[];
export declare function renderClientPrerenderFragment(projectRoot: string, fragment: ClientPrerenderFragment, projectRoots?: string[]): Promise<string>;
export declare function placeClientPrerenderFragment(html: string, fragment: ClientPrerenderFragment, rendered: string): string;
//# sourceMappingURL=client-prerender.d.ts.map