/** Preserve runtime-owned app identity even when a callback context stays mutable. */
export declare function bindAppContext<Context extends object, App>(context: Context, app: App): Context & {
    readonly app: App;
};
/** Public link authority comes only from launch/project configuration, never HTTP headers. */
export declare function normalizePublicOrigin(value: unknown): string | null;
export declare function resolvePublicOrigin(config: any): string;
export declare function isLocalPublicOrigin(origin: string): boolean;
//# sourceMappingURL=public-origin.d.ts.map