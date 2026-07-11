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
export type PublicTree = {
    root: string;
    assets: ReadonlyMap<string, PublicAsset>;
};
export declare function createPublicTree(buildDir: string, files: ReadonlyArray<{
    path: string;
    contents: string | Uint8Array;
}>): Promise<{
    root: string;
    assets: ReadonlyMap<string, PublicAsset>;
}>;
export declare function discardPublicTree(tree: PublicTree): Promise<void>;
export declare function validatePublicTree(root: string): Promise<{
    fileCount: number;
    totalBytes: number;
}>;
export declare function snapshotPublicTree(root: string): Promise<PublicTree>;
export declare function readPublicAsset(tree: PublicTree, rawPathname: string): Promise<PublicAsset | null>;
export {};
//# sourceMappingURL=public-tree.d.ts.map