export declare const PUBLIC_TREE_LIMITS: {
    readonly files: 512;
    readonly fileBytes: number;
    readonly totalBytes: number;
    readonly pathBytes: 240;
};
type PublicAsset = {
    body: Buffer;
    contentType: string;
    relativePath: string;
    html: boolean;
};
export declare function replacePublicTree(buildDir: string, files: ReadonlyArray<{
    path: string;
    contents: string | Uint8Array;
}>): Promise<string>;
export declare function validatePublicTree(root: string): Promise<{
    fileCount: number;
    totalBytes: number;
}>;
export declare function readPublicAsset(root: string, rawPathname: string): Promise<PublicAsset | null>;
export {};
//# sourceMappingURL=public-tree.d.ts.map