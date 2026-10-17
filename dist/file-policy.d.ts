/** Opt-in Capsule-wide MIME policy. This is signature checking, not malware inspection. */
export declare function resolveFileAllowedMimeTypes(files: any): ReadonlySet<string> | null;
export declare function normalizeFileMimeType(type: unknown): string;
/** Called before creating pending state and again on the actual bytes, before storage publication. */
export declare function assertAllowedFileMimeType(allowed: ReadonlySet<string> | null | undefined, rawType: unknown, bytes?: Uint8Array): void;
//# sourceMappingURL=file-policy.d.ts.map