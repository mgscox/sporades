type RecordLike = Record<string, any>;
export declare function isSupportedInspectionNodeVersion(version: string): boolean;
export declare function validatePdfIngress(bytes: Buffer, options?: RecordLike): Promise<boolean>;
export declare function isJavaScriptRawInputWithinBounds(text: string): boolean;
export declare function isJavaScriptParserInputWithinBounds(text: string): boolean;
export declare function hasExecutableJavaScriptSemantics(text: string): boolean;
export declare function hasExecutablePythonSemantics(text: string): boolean;
export declare function isCurrentClamavSignature(signature: RecordLike | null, now?: number): boolean;
export declare function initializeClamavRuntime(database: RecordLike): Promise<any>;
export declare function shutdownClamavRuntime(database: RecordLike): Promise<void>;
export declare function checkClamavRuntime(database: RecordLike): Promise<{
    ok: any;
}>;
export declare function multipartParts(request: AsyncIterable<Uint8Array>, boundaryText: string, maxWireBytes: number, maxPartBytes: number | {
    file: number;
    field: number;
}): AsyncGenerator<{
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
    inspection(lease: RecordLike): Promise<Readonly<{
        policyRevision: any;
        verdicts: any;
    }> | null>;
    status(statusRequestKey: string, partKey: string): Promise<{
        state: "missing";
        file?: undefined;
        lease?: undefined;
        retryable?: undefined;
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
        retryable?: undefined;
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
        retryable?: undefined;
    } | {
        state: "failed";
        retryable: boolean;
        file?: undefined;
        lease?: undefined;
    }>;
};
/** Database and object storage cannot share a transaction: publish Map state only after SQL commits. */
export declare function finalizeEndpointIngressClaims(context: RecordLike, committed: boolean): void;
/** Reset an interrupted delivery lease at startup; ordinary drains never steal live work. */
export declare function recoverIngressClaimAuditOutbox(database: RecordLike): Promise<boolean>;
/** Emit the fixed public audit only after its transaction has committed. */
export declare function drainIngressClaimAuditOutbox(database: RecordLike, options?: RecordLike): Promise<void>;
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