/** Runtime-owned report-uri used by `security.csp.reportTo: "observability"`. */
export declare const CSP_REPORT_PATH = "/__sporades/csp-report";
/** Shared startup/CLI validation for opt-in HTTP hardening. Never echo configured values. */
export declare function validateHttpHardening(security?: Record<string, any>, observability?: Record<string, any>): void;
export declare function hstsHeader(hsts: Record<string, any>): string;
/** Shared by runtime and CLI inspection so both describe the same report destination. */
export declare function cspReportDirectives(csp: Record<string, any>): {
    "report-uri": any[];
} | {
    "report-uri"?: undefined;
};
//# sourceMappingURL=http-security-config.d.ts.map