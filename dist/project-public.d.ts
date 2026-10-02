type PublicFile = {
    path: string;
    contents: string | Uint8Array;
};
/** Merge explicitly public source files into the candidate, never the active tree. */
export declare function mergeProjectPublicFiles(projectDir: string, generated: readonly PublicFile[]): Promise<PublicFile[]>;
export {};
//# sourceMappingURL=project-public.d.ts.map