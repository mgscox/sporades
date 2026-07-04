export declare function sealedServerEnvPaths(projectDir: any): {
    root: string;
    envelope: string;
    privateKey: string;
    publicKey: string;
    hosts: string;
};
export declare function ensureSealedServerEnvKeyPair(paths?: {
    root: string;
    envelope: string;
    privateKey: string;
    publicKey: string;
    hosts: string;
}): Promise<{
    publicKey: string;
    privateKey: string;
    publicKeyFingerprint: string;
}>;
export declare function readKeyPair(paths: any): Promise<{
    publicKey: string;
    privateKey: string;
    publicKeyFingerprint: string;
}>;
export declare function sealServerEnv(values: any, publicKey: any, metadata?: {}): {
    version: number;
    keyAlgorithm: string;
    valueAlgorithm: string;
    publicKeyFingerprint: string;
    sealedAt: string;
    metadata: {};
    entries: {};
};
export declare function unsealServerEnv(envelope: any, privateKey: any): {};
export declare function readSealedServerEnv(paths: any): Promise<any>;
export declare function writeSealedServerEnv(paths: any, envelope: any): Promise<void>;
export declare function envelopeSummary(envelope: any, paths?: any): {
    configured: boolean;
    keyCount: number;
    publicKeyFingerprint: any;
    envelopePath: any;
    privateKeyPath: any;
};
export declare function exportedEnvelope(envelope: any): any;
export declare function fingerprintPublicKey(publicKey: any): string;
//# sourceMappingURL=sealed-server-env.d.ts.map