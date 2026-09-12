import type { FileHandle } from "node:fs/promises";
export type DeployFile = {
    path: string;
    update: "replace" | "preserve";
};
export type BuiltDeployFile = DeployFile & {
    contents: Buffer;
};
export declare function resolveDeployFiles(value: unknown): DeployFile[];
export declare function assertDeployFile(root: string, relative: string): Promise<string>;
export declare function buildDeployFiles(projectDir: string, value: unknown): Promise<BuiltDeployFile[]>;
export declare function deployFileMounts(files: DeployFile[], releaseRoot: string, preservedRoot: string): {
    host: string;
    container: string;
    mode: string;
}[];
export declare function preparePreservedFiles(files: DeployFile[], releaseRoot: string, preservedRoot: string, owner?: string | ((handle: FileHandle, target: string, stats: Awaited<ReturnType<FileHandle["stat"]>>) => Promise<void>)): Promise<void>;
//# sourceMappingURL=deploy-files.d.ts.map