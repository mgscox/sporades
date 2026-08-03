import type { BinaryLike, KeyLike } from "node:crypto";
export type SealedServerEnvPaths = {
    root: string;
    envelope: string;
    privateKey: string;
    publicKey: string;
    hosts: string;
};
export type SealedServerEnvKeyPair = {
    publicKey: string;
    privateKey: string;
    publicKeyFingerprint: string;
};
export type SealedServerEnvEntry = {
    encryptedKey: string;
    iv: string;
    tag: string;
    ciphertext: string;
};
export type SealedServerEnvEnvelope = {
    version: number;
    keyAlgorithm: string;
    valueAlgorithm: string;
    publicKeyFingerprint: string;
    sealedAt: string;
    metadata: Record<string, unknown>;
    entries: Record<string, SealedServerEnvEntry>;
};
export type SealedServerEnvSummary = {
    configured: boolean;
    keyCount: number;
    publicKeyFingerprint: string | null;
    envelopePath: string | null;
    privateKeyPath: string | null;
};
type PublicEncryptionKey = KeyLike;
type PrivateEncryptionKey = KeyLike;
export declare function sealedServerEnvPaths(projectDir: string): SealedServerEnvPaths;
export declare function ensureSealedServerEnvKeyPair(paths?: SealedServerEnvPaths): Promise<SealedServerEnvKeyPair>;
export declare function readKeyPair(paths: Pick<SealedServerEnvPaths, "privateKey" | "publicKey">): Promise<SealedServerEnvKeyPair | null>;
export declare function sealServerEnv(values: Record<string, unknown>, publicKey: PublicEncryptionKey, metadata?: Record<string, unknown>): SealedServerEnvEnvelope;
export declare function unsealServerEnv(envelope: unknown, privateKey: PrivateEncryptionKey): Record<string, string>;
export declare function readSealedServerEnv(paths: Pick<SealedServerEnvPaths, "envelope">): Promise<SealedServerEnvEnvelope | null>;
export declare function writeSealedServerEnv(paths: {
    root: string;
    envelope: string;
}, envelope: SealedServerEnvEnvelope): Promise<void>;
export declare function withSealedServerEnvMutationLock<Result>(paths: Pick<SealedServerEnvPaths, "root">, mutate: () => Promise<Result>): Promise<Result>;
export declare function envelopeSummary(envelope: SealedServerEnvEnvelope | null, paths?: Pick<SealedServerEnvPaths, "envelope" | "privateKey"> | null): SealedServerEnvSummary;
export declare function exportedEnvelope(envelope: unknown): SealedServerEnvEnvelope & {
    exportedAt: string;
};
export declare function fingerprintPublicKey(publicKey: BinaryLike | PublicEncryptionKey): string;
export {};
//# sourceMappingURL=sealed-server-env.d.ts.map