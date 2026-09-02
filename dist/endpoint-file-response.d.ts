type LooseRecord = Record<string, any>;
type AttachmentResponseDetails = Readonly<{
    fileId: string;
    version: string;
    filename: string;
}>;
export declare function createEndpointFileResponseApi(ingressApi: LooseRecord, enabled: boolean): Readonly<{
    files: Readonly<{
        attachment(reference: LooseRecord, options: LooseRecord): Readonly<{}>;
    } | {
        attachment?: undefined;
    }>;
    sealCommittedResult(value: unknown): unknown;
}>;
export declare function consumeSealedEndpointFileAttachment(value: unknown): AttachmentResponseDetails | null;
export declare function markGuardedAttachmentHttpResponse(response: object): void;
export declare function isGuardedAttachmentHttpResponse(response: unknown): boolean;
export declare function safePresentationFilename(value: unknown): string | null;
export declare function attachmentContentDisposition(filename: string): string;
export {};
//# sourceMappingURL=endpoint-file-response.d.ts.map