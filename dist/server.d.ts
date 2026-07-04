export declare function capsule(definition: any): any;
export declare function endpoint(options: any, handler: any): {
    kind: string;
    options: any;
    handler: any;
};
export declare function query(handler: any): {
    kind: string;
    handler: any;
};
export declare function mutation(handler: any): {
    kind: string;
    handler: any;
};
export declare function message(handler: any): {
    kind: string;
    handler: any;
};
export declare function table(fields: any): {
    aclRules?: any;
    kind: string;
    fields: any;
    acl(rules: any): /*elided*/ any;
};
export declare function String(): {
    kind: any;
    default(defaultValue: any): {
        kind: any;
        defaultValue: any;
    };
};
export declare function Boolean(): {
    kind: any;
    default(defaultValue: any): {
        kind: any;
        defaultValue: any;
    };
};
export declare function Number(): {
    kind: any;
    default(defaultValue: any): {
        kind: any;
        defaultValue: any;
    };
};
export declare function Date(): {
    kind: any;
    default(defaultValue: any): {
        kind: any;
        defaultValue: any;
    };
};
export declare function Json(): {
    kind: any;
    default(defaultValue: any): {
        kind: any;
        defaultValue: any;
    };
};
export declare function Reference(targetTable: any): {
    kind: string;
    targetTable: any;
    default(defaultValue: any): {
        kind: string;
        targetTable: any;
        defaultValue: any;
    };
};
export declare function serverRuntimeModuleSource(): string;
//# sourceMappingURL=server.d.ts.map