import type { FileHandle } from "node:fs/promises";
export type DeployFile = {
    path: string;
    update: "replace" | "preserve";
};
export type PreservedSeed = {
    root: string;
    path: string;
    storagePath?: string;
    dev: number;
    ino: number;
    sha256: string;
};
export type BuiltDeployFile = DeployFile & {
    contents: Buffer;
};
export declare function resolveDeployFiles(value: unknown): DeployFile[];
export declare function preservedDeployFilePath(root: string, relative: string): string;
export declare function assertPreservedDeployFile(root: string, relative: string): Promise<string>;
export declare function buildDeployFiles(projectDir: string, value: unknown): Promise<BuiltDeployFile[]>;
export declare function deployFileMounts(files: DeployFile[], releaseRoot: string, preservedRoot: string): {
    host: string;
    container: string;
    mode: string;
}[];
export declare function beginPreservedFileAttempt(preservedRoot: string, release: string, needed: boolean): Promise<string | undefined>;
export declare function finishPreservedFileAttempt(journal?: string): Promise<void>;
export declare function preparePreservedFiles(files: DeployFile[], releaseRoot: string, preservedRoot: string, owner?: (handle: FileHandle, target: string, stats: Awaited<ReturnType<FileHandle["stat"]>>) => Promise<void>, created?: PreservedSeed[], journal?: string): Promise<void>;
export declare function rollbackPreservedFiles(created: PreservedSeed[], hooks?: {
    beforeClaim?: (target: string) => Promise<void>;
}): Promise<void>;
export declare function rethrowAfterDeployCleanup(error: unknown, cleanups: Array<() => Promise<unknown>>): Promise<never>;
export declare function localPreservedFileAccessArgs(file: string, localUser: string, runtimeUser: string, image: string, mode?: number, expected?: {
    dev: number;
    ino: number;
}): string[];
export declare function removeDeployFileSnapshot(runtimeDir: string, snapshot: unknown): Promise<void>;
//# sourceMappingURL=deploy-files.d.ts.map