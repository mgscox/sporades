export type FieldKind = "String" | "Boolean" | "Number" | "Date" | "Json" | "Reference";
export type UnknownRecord = Record<string, unknown>;
export type Handler<Args extends unknown[] = unknown[], Result = unknown> = (...args: Args) => Result | Promise<Result>;
export type CapsuleDefinition = UnknownRecord & {
    name: string;
};
export type Capsule<Definition extends CapsuleDefinition = CapsuleDefinition> = Definition & {
    kind: "capsule";
};
export type EndpointOptions = {
    method: string;
    path: string;
};
export type EndpointDefinition<HandlerType extends Handler = Handler> = {
    kind: "endpoint";
    options: EndpointOptions;
    handler: HandlerType;
};
export type HandlerDefinition<Kind extends "query" | "mutation" | "message", HandlerType extends Handler = Handler> = {
    kind: Kind;
    handler: HandlerType;
};
export type FieldDefinition<Value = unknown> = {
    kind: FieldKind;
    defaultValue?: Value;
};
export type FieldBuilder<Value = unknown> = {
    kind: FieldKind;
    default(defaultValue: Value): FieldDefinition<Value>;
};
export type ReferenceFieldBuilder = {
    kind: "Reference";
    targetTable: string;
    default(defaultValue: string | null): FieldDefinition<string | null> & {
        kind: "Reference";
        targetTable: string;
    };
};
export type TableDefinition<Fields extends UnknownRecord = UnknownRecord> = {
    kind: "table";
    fields: Fields;
    aclRules?: unknown;
    acl(rules: unknown): TableDefinition<Fields>;
};
export type AuthContext = {
    userId: string;
    displayName: string;
    email: string | null;
    picture: string | null;
    isAuthenticated: boolean;
    isGuest: boolean;
    provider: string;
};
export type RequireAuthOptions = {
    linked?: boolean;
};
export type RequireAuthContext = {
    auth: AuthContext;
    [key: string]: unknown;
};
export declare function requireAuth(context: RequireAuthContext, options?: RequireAuthOptions): AuthContext;
export declare function capsule<const Definition extends CapsuleDefinition>(definition: Definition): Capsule<Definition>;
export declare function endpoint<const HandlerType extends Handler>(options: EndpointOptions, handler: HandlerType): EndpointDefinition<HandlerType>;
export declare function query<const HandlerType extends Handler>(handler: HandlerType): HandlerDefinition<"query", HandlerType>;
export declare function mutation<const HandlerType extends Handler>(handler: HandlerType): HandlerDefinition<"mutation", HandlerType>;
export declare function message<const HandlerType extends Handler>(handler: HandlerType): HandlerDefinition<"message", HandlerType>;
export declare function table<const Fields extends UnknownRecord>(fields: Fields): TableDefinition<Fields>;
export declare function String(): FieldBuilder<unknown>;
export declare function Boolean(): FieldBuilder<unknown>;
export declare function Number(): FieldBuilder<unknown>;
export declare function Date(): FieldBuilder<unknown>;
export declare function Json(): FieldBuilder<unknown>;
export declare function Reference(targetTable: string): ReferenceFieldBuilder;
export declare function serverRuntimeModuleSource(): string;
//# sourceMappingURL=server.d.ts.map