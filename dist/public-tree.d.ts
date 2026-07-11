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
export type PublicTreeConsumer = {
    consumer: string;
    tree: string;
    identity: string;
    token: string;
    createdAt: number;
};
export type PublicTreeConsumerExpectation = {
    token: string;
    identity: string;
} | null;
type PublicFile = {
    path: string;
    contents: string | Uint8Array;
};
type CleanupFault = (event: "before-remove", entryPath: string) => void;
type ProcessIdentityExec = (file: string, args: readonly string[], options: {
    env: NodeJS.ProcessEnv;
}) => Promise<{
    stdout: string;
}>;
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
export declare function readPublicTreeConsumer(buildDir: string, consumer: string): Promise<PublicTreeConsumer | null>;
export declare function writePublicTreeConsumer(buildDir: string, consumer: string, treeRoot: string, identity: string, expectedCurrent: PublicTreeConsumerExpectation): Promise<PublicTreeConsumer>;
export declare function restorePublicTreeConsumer(buildDir: string, consumer: string, record: PublicTreeConsumer | null, expectedCurrent: PublicTreeConsumerExpectation): Promise<void>;
export declare function removePublicTreeConsumer(buildDir: string, consumer: string, expectedCurrent: PublicTreeConsumerExpectation): Promise<void>;
export declare function validatePublicTree(root: string): Promise<{
    fileCount: number;
    totalBytes: number;
    paths: string[];
}>;
export declare function summarizePublicTree(root: string): Promise<{
    htmlEntry: string;
    fileCount: number;
    totalBytes: number;
    paths: string[];
    truncated: boolean;
}>;
export declare function validateActivePublicTreeReference(treesDir: string, raw: string): Promise<string>;
export declare function validatePublicFiles(files: ReadonlyArray<PublicFile>): {
    fileCount: number;
    totalBytes: number;
};
export declare function cleanupPublicTrees(buildDir: string, options?: {
    keepRoots?: string[];
    maxCompleted?: number;
    fault?: CleanupFault;
    now?: () => number;
}): Promise<void>;
export declare function readPublicAsset(tree: PublicTree, rawPathname: string): Promise<PublicAsset | null>;
export declare function publishOwnerHeartbeat(recordPath: string, token: string, heartbeatAt: number, options?: {
    afterTempWrite?: () => void | Promise<void>;
}): Promise<void>;
export declare function getProcessStartIdentity(pid: number, options?: {
    platform?: NodeJS.Platform;
    execFile?: ProcessIdentityExec;
}): Promise<string | null>;
export {};
//# sourceMappingURL=public-tree.d.ts.map