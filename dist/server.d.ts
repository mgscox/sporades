import type { EndpointBodyBytes as CanonicalEndpointBodyBytes, EndpointContext as CanonicalEndpointContext, EndpointFileAttachmentApi as CanonicalEndpointFileAttachmentApi, EndpointFileAttachmentContext as CanonicalEndpointFileAttachmentContext, EndpointFileAttachmentOptions as CanonicalEndpointFileAttachmentOptions, EndpointFileAttachmentReference as CanonicalEndpointFileAttachmentReference, EndpointFileAttachmentResponse as CanonicalEndpointFileAttachmentResponse, EndpointFileIngressApi as CanonicalEndpointFileIngressApi, EndpointFileIngressInspection as CanonicalEndpointFileIngressInspection, EndpointFileIngressLease as CanonicalEndpointFileIngressLease, EndpointFileMetadata as CanonicalEndpointFileMetadata, EndpointRequest as CanonicalEndpointRequest, FileIngressOptions as CanonicalFileIngressOptions, SchemaDefinition as CanonicalSchemaDefinition } from "../src/types/server.js";
export type FieldKind = "String" | "Boolean" | "Number" | "Date" | "Json" | "Reference";
export type UnknownRecord = Record<string, unknown>;
export type Handler<Args extends unknown[] = any[], Result = unknown> = (...args: Args) => Result | Promise<Result>;
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export type CapsuleDefinition = UnknownRecord & {
    name: string;
    accessKeys?: {
        scopes: readonly string[];
    };
};
export type Capsule<Definition extends CapsuleDefinition = CapsuleDefinition> = Definition & {
    kind: "capsule";
};
export type FileIngressInspection = Readonly<{
    policyRevision: string;
    maxVerdictAgeMs?: number;
    /** Runtime-owned inspector names; Capsule code cannot supply verdicts. */
    requiredInspectors: readonly ("content-policy-v1" | "clamav")[];
}>;
export type SchemaDefinition = CanonicalSchemaDefinition;
type EndpointFieldValue<Field> = Field extends FieldBuilder<infer Value> ? Value | null : Field extends FieldDefinition<infer Value> ? Value : Field extends ReferenceFieldBuilder | ReferenceFieldDefinition ? string | null : unknown;
type EndpointRow<Fields extends UnknownRecord> = {
    id: string;
    createdAt: string;
    updatedAt: string;
} & {
    [Key in keyof Fields]: EndpointFieldValue<Fields[Key]>;
};
export type ReadOnlyTableApi<Row extends UnknownRecord = UnknownRecord> = {
    where<FieldName extends keyof Row & string>(fieldName: FieldName, value: Row[FieldName]): ReadOnlyTableApi<Row>;
    orderBy(fieldName: keyof Row & string, direction?: "asc" | "desc" | "ASC" | "DESC"): ReadOnlyTableApi<Row>;
    limit(count: number): ReadOnlyTableApi<Row>;
    get(): Promise<Row | null>;
    all(): Promise<Row[]>;
};
export type ReadOnlyDatabaseFromSchema<Schema extends SchemaDefinition> = {
    [TableName in keyof Schema]: Schema[TableName] extends TableDefinition<infer Fields> ? ReadOnlyTableApi<EndpointRow<Fields>> : ReadOnlyTableApi;
};
export type FileIngressPrincipal = Readonly<{
    namespace: string;
    key: string;
}>;
export type FileIngressAdmissionRequest = Readonly<{
    method: string;
    path: string;
    headers: Readonly<Record<string, string>>;
    query: Readonly<Record<string, string>>;
}>;
export type FileIngressAdmissionDecision = Readonly<{
    allow: false;
} | {
    allow: true;
    principal: FileIngressPrincipal;
}>;
export type FileIngressAdmissionContext<Schema extends SchemaDefinition = SchemaDefinition> = Readonly<{
    db: ReadOnlyDatabaseFromSchema<Schema>;
    env: Readonly<Record<string, string | undefined>>;
    signal?: AbortSignal;
    request: FileIngressAdmissionRequest;
}>;
/** Shared immutable request head supplied to endpoint multipart admission. */
export type EndpointMultipartAdmissionRequest = FileIngressAdmissionRequest;
/** An authenticated, read-only policy context evaluated before a multipart endpoint reads its request body. */
export type EndpointMultipartAdmissionContext<Schema extends SchemaDefinition = SchemaDefinition> = Readonly<{
    auth: AuthContext;
    credential: CredentialProvenance;
    db: ReadOnlyDatabaseFromSchema<Schema>;
    env: Readonly<Record<string, string | undefined>>;
    signal?: AbortSignal;
    request: FileIngressAdmissionRequest;
}>;
/** The endpoint policy can only continue or reject this request; it cannot provide file claim authority. */
export type EndpointMultipartAdmissionDecision = Readonly<{
    allow: true;
} | {
    allow: false;
}>;
/** Runtime-owned bounds and stable identifiers for one endpoint multipart ingress request. */
export type EndpointMultipartIngressLimits = Readonly<{
    maxFiles: number;
    maxFileBytes: number;
    maxTotalFileBytes: number;
    maxFieldCount: number;
    maxFieldBytes: number;
    maxTotalFieldBytes: number;
    allowedMimeTypes?: readonly string[];
    allowedPathPrefixes: readonly string[];
    requestKeyHeader: string;
    partKeyHeader: string;
    requireStablePartKeys?: boolean;
    inspection?: FileIngressInspection;
}>;
/** Actor-owned ingress may apply a request-specific admission policy. */
export type EndpointActorMultipartIngressOptions<Schema extends SchemaDefinition = SchemaDefinition> = EndpointMultipartIngressLimits & Readonly<{
    claimAuthorities?: readonly ["actor"];
    admit?(ctx: EndpointMultipartAdmissionContext<Schema>, request: FileIngressAdmissionRequest): EndpointMultipartAdmissionDecision | Promise<EndpointMultipartAdmissionDecision>;
}>;
/** Capsule-principal ingress has its separate Capsule-level admission policy and cannot add actor admission. */
export type EndpointCapsulePrincipalMultipartIngressOptions = EndpointMultipartIngressLimits & Readonly<{
    claimAuthorities: readonly ["capsule-principal"];
    admit?: never;
}>;
/** One of the supported endpoint multipart ingress authority modes. */
export type EndpointMultipartIngressOptions<Schema extends SchemaDefinition = SchemaDefinition> = EndpointActorMultipartIngressOptions<Schema> | EndpointCapsulePrincipalMultipartIngressOptions;
export type EndpointOptions<Schema extends SchemaDefinition = SchemaDefinition> = {
    method: string;
    path: string;
    /** Explicitly delegates exact-version attachment authorization to this trusted endpoint handler. */
    response?: {
        fileAttachment: true;
    };
    /** Runtime-owned bounded multipart ingress for a trusted Custom endpoint. */
    body?: {
        multipart: EndpointMultipartIngressOptions<Schema>;
    };
};
/** Endpoint declaration that permits an opaque File attachment response. */
export type EndpointFileAttachmentOptionsDeclaration<Schema extends SchemaDefinition = SchemaDefinition> = EndpointOptions<Schema> & {
    response: {
        fileAttachment: true;
    };
};
export type EndpointBodyBytes = CanonicalEndpointBodyBytes;
export type EndpointRequest = CanonicalEndpointRequest;
export type EndpointFileIngressLease = CanonicalEndpointFileIngressLease;
export type EndpointFileIngressInspection = CanonicalEndpointFileIngressInspection;
export type EndpointFileMetadata = CanonicalEndpointFileMetadata;
export type FileIngressOptions = CanonicalFileIngressOptions;
export type EndpointFileAttachmentReference = CanonicalEndpointFileAttachmentReference;
export type EndpointFileAttachmentOptions = CanonicalEndpointFileAttachmentOptions;
export type EndpointFileAttachmentResponse = CanonicalEndpointFileAttachmentResponse;
export type EndpointFileIngressApi = CanonicalEndpointFileIngressApi;
export type EndpointFileAttachmentApi = CanonicalEndpointFileAttachmentApi;
export type EndpointContext<Schema extends SchemaDefinition = SchemaDefinition> = CanonicalEndpointContext<Schema>;
export type EndpointFileAttachmentContext<Schema extends SchemaDefinition = SchemaDefinition> = CanonicalEndpointFileAttachmentContext<Schema>;
export type EndpointHandler<Schema extends SchemaDefinition = SchemaDefinition, Result = unknown> = (ctx: EndpointContext<Schema>) => Result | Promise<Result>;
export type EndpointFileAttachmentHandler<Schema extends SchemaDefinition = SchemaDefinition, Result = unknown> = (ctx: EndpointFileAttachmentContext<Schema>) => Result | Promise<Result>;
declare const authGuardedHandlerBrand: unique symbol;
export type AuthGuardedHandler<HandlerType extends Handler> = HandlerType & {
    readonly [authGuardedHandlerBrand]: true;
};
export type EndpointDefinition<HandlerType extends Handler = Handler, Schema extends SchemaDefinition = SchemaDefinition> = {
    kind: "endpoint";
    options: EndpointOptions<Schema>;
    handler: HandlerType;
};
export type HandlerDefinition<Kind extends "query" | "mutation" | "message", HandlerType extends Handler = Handler> = {
    kind: Kind;
    handler: HandlerType;
};
export type JobDefinition<HandlerType extends Handler = Handler> = {
    kind: "job";
    handler: HandlerType;
};
export type EmailEventDefinition<HandlerType extends Handler = Handler> = {
    kind: "emailEvent";
    handler: HandlerType;
};
export type StripeEventDefinition<HandlerType extends Handler = Handler> = {
    kind: "stripeEvent";
    options?: undefined;
    handler: HandlerType;
};
export type AtomicStripeEventDefinition<HandlerType extends Handler = Handler> = {
    kind: "stripeEvent";
    options: Readonly<{
        consequence: "atomic";
    }>;
    handler: HandlerType;
};
/**
 * A server-only recurring Job declaration using numeric five-field cron.
 * Payloads must be JSON-safe; retry is the ordinary Job Queue retry policy.
 */
type ScheduleJsonValue = null | boolean | number | string | ScheduleJsonValue[] | {
    [key: string]: ScheduleJsonValue;
};
export type ScheduleDefinition = {
    expression: string;
    timezone?: string;
    job: string;
    retry?: {
        maxAttempts: number;
        delayMs?: number;
    };
    missedRun?: "skip" | "latest";
    enabled?: boolean;
} & ({
    payload?: ScheduleJsonValue;
    payloadVersion?: never;
} | {
    payload: SchedulePayloadFactory;
    /** Stable identity for the factory source and every captured/configured input. Change it when any of those inputs change. */
    payloadVersion?: string;
});
export type ScheduleOccurrence = Readonly<{
    scheduleName: string;
    scheduledFor: string;
}>;
/**
 * Calculates ordinary Job input for one occurrence. Factories are for dynamic
 * data population, may run more than once during recovery, and should avoid
 * state mutation. Explicit Privileged side effects must tolerate repetition.
 * Timeout cancellation is cooperative and cannot undo completed side effects.
 */
export type SchedulePayloadFactory = (occurrence: ScheduleOccurrence, ctx: Readonly<{
    signal: AbortSignal;
    privileged: unknown;
}>) => ScheduleJsonValue | Promise<ScheduleJsonValue>;
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
    default(defaultValue: string | null): ReferenceFieldDefinition;
};
export type ReferenceFieldDefinition = FieldDefinition<string | null> & {
    kind: "Reference";
    targetTable: string;
};
export type TableDefinition<Fields extends UnknownRecord = UnknownRecord> = {
    kind: "table";
    fields: Fields;
    aclRules?: any;
    uniqueConstraints?: readonly (readonly string[])[];
    acl(rules: any): TableDefinition<Fields>;
    unique(...fields: [keyof Fields & string, ...(keyof Fields & string)[]]): TableDefinition<Fields>;
};
export type CapsuleTableDefinition<Fields extends UnknownRecord> = Omit<TableDefinition<Fields>, "acl" | "unique"> & {
    acl(rules: unknown): CapsuleTableDefinition<Fields>;
    unique(...fields: [keyof Fields & string, ...(keyof Fields & string)[]]): CapsuleTableDefinition<Fields>;
};
export type AuthContext = {
    userId: string;
    /** Present only for non-human Service Users; absence preserves the legacy human/Anonymous shape. */
    userKind?: "service";
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
export type CredentialKind = "session" | "access-key";
export type SessionCredentialProvenance = Readonly<{
    kind: "session";
}>;
export type AccessKeyCredentialProvenance = Readonly<{
    kind: "access-key";
    id: string;
    name: string;
}>;
export type CredentialProvenance = SessionCredentialProvenance | AccessKeyCredentialProvenance;
export type DeclarativeRequireAuthOptions = {
    linked?: boolean;
    credentials?: readonly CredentialKind[];
    scopes?: readonly string[];
    reauthentication?: string;
};
export type RequireAuthContext = {
    auth: AuthContext;
    [key: string]: unknown;
};
export declare function requireUserAuth(context: RequireAuthContext, options?: RequireAuthOptions): AuthContext;
/** @deprecated Use requireUserAuth for the synchronous inline Session check. */
export declare function requireAuth(context: RequireAuthContext, options?: RequireAuthOptions): AuthContext;
export declare function requireAuth<HandlerType extends Handler>(handler: HandlerType): HandlerType;
export declare function requireAuth<HandlerType extends Handler>(options: DeclarativeRequireAuthOptions, handler: HandlerType): HandlerType;
export declare function capsule<const Definition extends CapsuleDefinition>(definition: Definition): Capsule<Definition>;
/** Define a Custom endpoint for HTTP integrations such as webhooks. */
export declare function endpoint<Schema extends SchemaDefinition = SchemaDefinition>(options: EndpointFileAttachmentOptionsDeclaration<Schema>, handler: EndpointFileAttachmentHandler<Schema>): EndpointDefinition<EndpointFileAttachmentHandler<Schema>, Schema>;
export declare function endpoint<Schema extends SchemaDefinition = SchemaDefinition>(options: EndpointOptions<Schema>, handler: EndpointHandler<Schema>): EndpointDefinition<EndpointHandler<Schema>, Schema>;
export declare function endpoint<Schema extends SchemaDefinition = SchemaDefinition, HandlerType extends Handler = Handler>(options: EndpointOptions<Schema>, handler: AuthGuardedHandler<HandlerType>): EndpointDefinition<AuthGuardedHandler<HandlerType>, Schema>;
/** Schema-bound endpoint declaration helper for callbacks that read the Capsule database before request-body handling. */
export type EndpointBuilder<Schema extends SchemaDefinition> = {
    (options: EndpointFileAttachmentOptionsDeclaration<Schema>, handler: EndpointFileAttachmentHandler<Schema>): EndpointDefinition<EndpointFileAttachmentHandler<Schema>, Schema>;
    (options: EndpointOptions<Schema>, handler: EndpointHandler<Schema>): EndpointDefinition<EndpointHandler<Schema>, Schema>;
    <HandlerType extends Handler>(options: EndpointOptions<Schema>, handler: AuthGuardedHandler<HandlerType>): EndpointDefinition<AuthGuardedHandler<HandlerType>, Schema>;
};
/** Bind a declared Capsule schema once when endpoint admission needs schema-aware read-only database typing. */
export declare function endpointFor<Schema extends SchemaDefinition>(schema: Schema): EndpointBuilder<Schema>;
/** Declare the single provider-neutral email-event subscription for a Capsule. */
export declare function emailEvent<const HandlerType extends Handler>(handler: HandlerType): EmailEventDefinition<HandlerType>;
/** Declare the single verified Stripe-event subscription for a Capsule. A declared Team Billing platform consequence commits before this compatible legacy handler runs. */
export declare function stripeEvent<const HandlerType extends Handler>(handler: HandlerType): StripeEventDefinition<HandlerType>;
/** Share one runtime-serialized transaction with any declared Team Billing platform consequence for the verified Event. */
export declare function stripeEvent<const HandlerType extends Handler>(options: {
    consequence: "atomic";
}, handler: HandlerType): AtomicStripeEventDefinition<HandlerType>;
export declare function query<const HandlerType extends Handler>(handler: HandlerType): HandlerDefinition<"query", HandlerType>;
export declare function mutation<const HandlerType extends Handler>(handler: HandlerType): HandlerDefinition<"mutation", HandlerType>;
export declare function message<const HandlerType extends Handler>(handler: HandlerType): HandlerDefinition<"message", HandlerType>;
/** Declare a named, server-only durable Job handler in `capsule({ jobs })`. */
export declare function job<const HandlerType extends Handler>(handler: HandlerType): JobDefinition<HandlerType>;
/**
 * Declare a named, server-only recurring Privileged Job in
 * `capsule({ schedules })`. The map key is its durable identity. Expressions use
 * numeric five-field cron; `missedRun` defaults to `skip` and `latest` catches
 * up at most one occurrence. Dynamic payload factories may supply a stable
 * `payloadVersion` that changes with their code or captured configuration;
 * omission preserves the weaker v0.8.5 source-text identity.
 * Scheduled Jobs retain Job Queue at-least-once attempt semantics.
 */
export declare function schedule<const Definition extends ScheduleDefinition>(definition: Definition): Definition & {
    kind: "schedule";
};
export declare function table<const Fields extends UnknownRecord>(fields: Fields): CapsuleTableDefinition<Fields>;
export declare function String(): FieldBuilder<string>;
export declare function Boolean(): FieldBuilder<boolean>;
export declare function Number(): FieldBuilder<number>;
export declare function Date(): FieldBuilder<string | globalThis.Date | null>;
export declare function Json<Value extends JsonValue = JsonValue>(): FieldBuilder<Value>;
export declare function Reference(targetTable: string): ReferenceFieldBuilder;
export declare function serverRuntimeModuleSource(): string;
export {};
//# sourceMappingURL=server.d.ts.map