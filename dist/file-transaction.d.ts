export type FileTransactionOperation = {
    phase: "validate" | "inspect" | "stage" | "commit" | "rollback" | "cleanup";
    action: string;
    label: string;
    targetPath: string;
    artifactPath?: string;
};
export type FileTransactionOperationExecutor = <Result>(operation: FileTransactionOperation, action: () => Promise<Result>) => Promise<Result>;
export type FileReplacement = {
    path: string;
    label: string;
    contents: string | Uint8Array;
};
export declare function replaceFilesAtomically(replacements: FileReplacement[], options?: {
    execute?: FileTransactionOperationExecutor;
}): Promise<void>;
//# sourceMappingURL=file-transaction.d.ts.map