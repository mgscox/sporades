type RecordLike = Record<string, any>;
export declare function multipartParts(request: AsyncIterable<Uint8Array>, boundaryText: string, maxWireBytes: number, maxPartBytes: number): AsyncGenerator<{
    rawHeaders: string;
    body: Buffer<ArrayBuffer>;
}, void, unknown>;
/** Parse only after endpoint credential admission. The bounded body is never exposed as an ordinary endpoint body. */
export declare function stageMultipartIngress(database: RecordLike, endpoint: RecordLike, request: any, endpointRequest: RecordLike, actor: RecordLike, admittedAuthority?: RecordLike): Promise<{
    body: null;
    bodyBytes: Readonly<{
        byteLength: 0;
        length: 0;
        at(): undefined;
        toUint8Array(): Uint8Array<ArrayBuffer>;
        [Symbol.iterator](): Generator<never, void, unknown>;
    }>;
    multipart: Readonly<{
        files: readonly any[];
        fields: Readonly<RecordLike>;
    }>;
    __ingressRequestKey: string;
    __ingressAuthority: RecordLike | Readonly<{
        kind: string;
        actorId: string;
        ownerId: string;
    }>;
}>;
export declare function validateMultipartIngressPolicy(policy: RecordLike): RecordLike;
export declare function createEndpointIngressApi(database: RecordLike, endpoint: RecordLike, endpointRequest: RecordLike, context: RecordLike): {
    claim(lease: RecordLike, options: RecordLike): Promise<{
        id: any;
        bucket: any;
        size: number;
        type: any;
        name: any;
        path: any;
        version: any;
    }>;
    status(statusRequestKey: string, partKey: string): Promise<{
        state: "missing";
        file?: undefined;
        lease?: undefined;
    } | {
        state: "complete";
        file: {
            id: any;
            bucket: any;
            size: number;
            type: any;
            name: any;
            path: any;
            version: any;
        };
        lease?: undefined;
    } | {
        state: "leased";
        lease: Readonly<{
            leaseId: any;
            partId: any;
            fieldName: any;
            name: any;
            type: any;
            declaredSize: null;
            size: any;
            expiresAt: any;
        }>;
        file?: undefined;
    }>;
};
/** Database and object storage cannot share a transaction: publish Map state only after SQL commits. */
export declare function finalizeEndpointIngressClaims(context: RecordLike, committed: boolean): void;
/** Retire one deterministic bounded batch. Object deletion precedes the token-fenced receipt delete. */
export declare function sweepExpiredFileIngress(database: RecordLike, options?: RecordLike): Promise<Readonly<{
    scanned: 0;
    cleaned: readonly never[];
    failures: readonly {
        code: string;
    }[];
}> | Readonly<{
    scanned: number;
    cleaned: readonly RecordLike[];
    failures: readonly RecordLike[];
}>>;
export {};
//# sourceMappingURL=file-ingress-runtime.d.ts.map