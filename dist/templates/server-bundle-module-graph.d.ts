export type ServerBundleModuleGraphOptions = {
    config: any;
    serverEnv: any;
    sealedServerEnv?: any;
    serverSource: string;
    serverModuleSource: string;
    epilogue?: string;
};
export declare function createServerBundleModuleSource(options: ServerBundleModuleGraphOptions): Promise<string>;
//# sourceMappingURL=server-bundle-module-graph.d.ts.map