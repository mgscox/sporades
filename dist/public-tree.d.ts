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
    lease: {
        path: string;
        token: string;
    };
};
type PublicFile = {
    path: string;
    contents: string | Uint8Array;
};
type CleanupFault = (event: "before-remove", entryPath: string) => void;
export declare function createPublicTree(buildDir: string, files: ReadonlyArray<PublicFile>, options?: {
    cleanupFault?: CleanupFault;
}): Promise<{
    root: string;
    assets: Map<string, PublicAsset>;
    lease: {
        path: string;
        token: string;
    };
}>;
export declare function discardPublicTree(tree: PublicTree): Promise<void>;
export declare function releasePublicTreeLease(tree: PublicTree): Promise<void>;
export declare function validatePublicTree(root: string): Promise<{
    fileCount: number;
    totalBytes: number;
}>;
export declare function validatePublicFiles(files: ReadonlyArray<PublicFile>): {
    fileCount: number;
    totalBytes: number;
};
export declare function cleanupPublicTrees(buildDir: string, options?: {
    keepRoots?: string[];
    maxCompleted?: number;
    fault?: CleanupFault;
}): Promise<void>;
export declare function readPublicAsset(tree: PublicTree, rawPathname: string): Promise<PublicAsset | null>;
export {};
//# sourceMappingURL=public-tree.d.ts.map