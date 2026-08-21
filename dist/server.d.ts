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
    default(defaultValue: string | null): FieldDefinition<string | null> & {
        kind: "Reference";
        targetTable: string;
    };
};
export type TableDefinition<Fields extends UnknownRecord = UnknownRecord> = {
    kind: "table";
    fields: Fields;
    aclRules?: unknown;
    uniqueConstraints?: readonly (readonly string[])[];
    acl(rules: unknown): TableDefinition<Fields>;
    unique(...fields: [keyof Fields & string, ...(keyof Fields & string)[]]): TableDefinition<Fields>;
};
export type CapsuleTableDefinition<Fields extends UnknownRecord> = Omit<TableDefinition<Fields>, "acl" | "unique"> & {
    acl(rules: unknown): CapsuleTableDefinition<Fields>;
    unique(...fields: [keyof Fields & string, ...(keyof Fields & string)[]]): CapsuleTableDefinition<Fields>;
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
/** Declare the single provider-neutral email-event subscription for a Capsule. */
export declare function emailEvent<const HandlerType extends Handler>(handler: HandlerType): EmailEventDefinition<HandlerType>;
/** Declare the single verified Stripe-event subscription for a Capsule. */
export declare function stripeEvent<const HandlerType extends Handler>(handler: HandlerType): StripeEventDefinition<HandlerType>;
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
export declare function String(): FieldBuilder<unknown>;
export declare function Boolean(): FieldBuilder<unknown>;
export declare function Number(): FieldBuilder<unknown>;
export declare function Date(): FieldBuilder<unknown>;
export declare function Json(): FieldBuilder<unknown>;
export declare function Reference(targetTable: string): ReferenceFieldBuilder;
export declare function serverRuntimeModuleSource(): string;
export {};
//# sourceMappingURL=server.d.ts.map