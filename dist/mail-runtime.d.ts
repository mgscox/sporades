type LooseRecord = Record<string, any>;
type RuntimeEnv = Record<string, string | undefined>;
export declare function createMailRuntime(mailConfig: any, serverEnv: RuntimeEnv, options?: LooseRecord): {
    enabled: boolean;
    validateIntent: () => never;
    send(): Promise<void>;
    sendIntent(): Promise<void>;
    close(): void;
} | {
    enabled: boolean;
    validateIntent: (input: any) => {
        provider?: any;
        providerHeaders?: {
            name: string;
            value: string;
        }[] | undefined;
        htmlBody?: any;
        textBody?: any;
        subject: any;
        replyTo?: {
            name?: any;
            email: string;
        } | undefined;
        from: {
            name?: any;
            email: string;
        };
        to: {
            name?: any;
            email: string;
        }[];
        cc: {
            name?: any;
            email: string;
        }[];
        bcc: {
            name?: any;
            email: string;
        }[];
    };
    connectionTimeoutMs: any;
    socketTimeoutMs: any;
    send(input: any, deliveryLog?: any): Promise<{
        messageId: string;
        accepted: any;
        rejected: any;
    }>;
    sendIntent(input: any, stableMessageId: string, deliveryLog?: any): Promise<{
        messageId: string;
        accepted: any;
        rejected: any;
    }>;
    abortActiveDeliveries(): void;
    close(): any;
};
export declare function createMailTransport(smtp: any): {
    send(message: any, options?: any): Promise<{
        messageId: any;
        accepted: any[];
        rejected: any[];
    }>;
    close(): void;
};
export declare function connectSmtpSocket(smtp: any, onSocket?: (socket: any) => void): Promise<any>;
export declare function buildSmtpMessage(message: any): string;
export {};
//# sourceMappingURL=mail-runtime.d.ts.map