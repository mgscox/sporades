import type { IncomingMessage, ServerResponse } from "node:http";
type RecordValue = Record<string, any>;
/** Configuration contains env names only; resolved provider credentials stay server-side. */
export declare function validateObservabilityConfig(config: RecordValue): void;
export declare function createRuntimeObservability(config?: RecordValue, env?: RecordValue): {
    enabled: boolean;
    clientErrors: boolean;
    analytics: boolean;
    capture(error: any, surface: string, address?: string | null): void;
    /** Values arrive already reduced by `cspViolations`; no document, sample, policy or client address is sent. */
    captureCspViolation(violation: CspViolation): void;
    close(): void;
    flush(): Promise<void>;
    collect(input: RecordValue, origin: string, request: IncomingMessage, database: RecordValue): Promise<void>;
    enter: () => boolean;
    leave(): void;
};
export declare function routeCollection(database: RecordValue, request: IncomingMessage, response: ServerResponse): Promise<boolean>;
type CspViolation = {
    directive: string;
    blocked: string;
    disposition?: "enforce" | "report";
};
export {};
//# sourceMappingURL=observability-runtime.d.ts.map