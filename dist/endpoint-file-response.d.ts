type LooseRecord = Record<string, any>;
type AttachmentResponseDetails = Readonly<{
    fileId: string;
    version: string;
    filename: string;
}>;
export declare function createEndpointFileResponseApi(ingressApi: LooseRecord): Readonly<{
    attachment(reference: LooseRecord, options: LooseRecord): Readonly<{}>;
}>;
export declare function endpointFileAttachmentDetails(value: unknown): AttachmentResponseDetails | null;
export declare function safePresentationFilename(value: unknown): string | null;
export declare function attachmentContentDisposition(filename: string): string;
export {};
//# sourceMappingURL=endpoint-file-response.d.ts.map