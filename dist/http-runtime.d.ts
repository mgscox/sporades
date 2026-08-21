import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
type LooseRecord = Record<string, any>;
type RuntimeConfig = LooseRecord;
export type RuntimeSecurityPolicy = {
    cors: {
        sameOrigin: boolean;
        publicDev: boolean;
        allowedOrigins: string[];
        allowedOriginPatterns: string[];
        requireExplicitCrossOrigin: boolean;
        publicOrigin: string | null;
    };
    csp: {
        mode: string;
        header: string;
        directives: Record<string, string[] | string>;
    };
};
export type RuntimeRequestLike = {
    headers: IncomingHttpHeaders | LooseRecord;
    socket?: any;
};
export declare function readJsonRequest(request: IncomingMessage, limitSource?: LooseRecord | number | null): Promise<LooseRecord>;
export declare function readLimitedRequestBody(request: any, limitSource?: LooseRecord | number | null): Promise<Buffer<ArrayBuffer>>;
export declare function resolveHttpMaxBodyBytes(source?: LooseRecord | number | null): number;
export declare function writeUnhandledHttpError(database: LooseRecord, request: IncomingMessage, response: ServerResponse<IncomingMessage>, error: any): void;
export declare function emitHttpFailureLog(database: LooseRecord, request: IncomingMessage | LooseRecord, error: any, context?: LooseRecord): void;
export declare function prepareHttpSecurity(database: {
    securityPolicy?: RuntimeSecurityPolicy;
}, request: IncomingMessage, response: ServerResponse<IncomingMessage> & {
    req: IncomingMessage;
}): boolean;
export declare function resolveRuntimeSecurityPolicy(config?: RuntimeConfig): RuntimeSecurityPolicy;
export declare function injectPageConnectionToken(html: string, token: string): string;
export declare function websocketOriginAllowed(policy: RuntimeSecurityPolicy, request: RuntimeRequestLike): boolean;
export declare function normalizeOrigin(value: any): string | null;
export declare function resolveOAuthRequestOrigin(policy: LooseRecord, request: RuntimeRequestLike): string | null;
export declare function singleHttpHeader(value: any): string | null;
export declare function handleFileHttpRoute(database: LooseRecord, request: IncomingMessage, response: ServerResponse<IncomingMessage> & {
    req: IncomingMessage;
}, websocketHub?: any): Promise<boolean>;
export declare function routeRuntimeHealth(database: any, request: {
    url: string | URL;
    method: string;
    headers: {
        [x: string]: any;
    };
}, response: any): Promise<boolean>;
export declare function checkRuntimeSqlite(database: LooseRecord): Promise<any>;
export declare function writeEndpointResult(response: any, result: any, runtimeHeaders?: LooseRecord): void;
export declare function writeEndpointError(response: any, error: any): void;
export {};
//# sourceMappingURL=http-runtime.d.ts.map