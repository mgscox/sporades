type LooseRecord = Record<string, any>;
type RuntimeEnv = Record<string, string | undefined>;
export declare function createMailRuntime(mailConfig: any, serverEnv: RuntimeEnv, options?: LooseRecord): {
    enabled: boolean;
    send(input: any): Promise<{
        messageId: string;
        accepted: any;
        rejected: any;
    }>;
    close(): any;
};
export declare function mailJsonSize(value: any): number;
export declare function createMailTransport(smtp: any): {
    send(message: any): Promise<{
        messageId: any;
        accepted: any[];
        rejected: any[];
    }>;
    close(): void;
};
export declare function connectSmtpSocket(smtp: any): Promise<any>;
export declare function buildSmtpMessage(message: any): string;
export {};
//# sourceMappingURL=mail-runtime.d.ts.map