export declare const PUBLIC_TREE_LIMITS: {
    readonly files: 512;
    readonly fileBytes: number;
    readonly totalBytes: number;
    readonly pathBytes: 240;
};
export type PublicTreeFileClaim = {
    path: string;
    size: number;
};
export type PublicTreeFileSetResult = {
    ok: true;
    fileCount: number;
    totalBytes: number;
} | {
    ok: false;
    reason: "path" | "collision" | "files" | "total-bytes" | "index";
} | {
    ok: false;
    reason: "file-bytes";
    path: string;
};
export declare function normalizePublicTreePath(value: string): string | null;
export declare function publicTreePathFromRequest(rawPathname: string): string | null;
export declare function validatePublicTreeFileSet(files: ReadonlyArray<PublicTreeFileClaim>): PublicTreeFileSetResult;
//# sourceMappingURL=public-tree-contract.d.ts.map