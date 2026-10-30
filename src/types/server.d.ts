import type { StripeEnabledPaymentsConfig, VerifiedStripeEvent } from "./stripe.js";

export type FieldKind = "String" | "Boolean" | "Number" | "Date" | "Json" | "Reference";

/** JSON-compatible values accepted by Sporades `Json()` fields and preferences APIs. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type MaybePromise<Value> = Value | Promise<Value>;

declare const htmlBrand: unique symbol;
/** Immutable escaped HTML fragment. Mail accepts it directly; String(fragment) renders it elsewhere. */
export type Html = Readonly<{ [htmlBrand]: true; toString(): string }>;

/** Escapes &, <, >, double and single quotes for HTML text and quoted attributes. Nullish values become empty strings. */
export function escapeHtml(value: unknown): string;

/** Escapes interpolations, joins arrays without separators, and preserves nested Html fragments. Use only in text or quoted attributes. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html;
export namespace html {
  /** Explicit escaping opt-out for trusted Capsule HTML. Never pass user input. */
  function raw(trusted: string): Html;
}

/**
 * Builder returned by a Sporades field helper such as `String()` or `Boolean()`.
 *
 * Field builders describe app schema. Call `.default(...)` when a field should
 * be filled automatically during inserts that omit it.
 *
 * @example
 * ```ts
 * import { Boolean, String, table } from "sporades/server";
 *
 * const todos = table({
 *   text: String(),
 *   done: Boolean().default(false),
 * });
 * ```
 */
export type FieldBuilder<Value> = {
  kind: FieldKind;
  default(defaultValue: Value): FieldDefinition<Value>;
};

/** A field builder after a default value has been attached. */
export type FieldDefinition<Value> = {
  kind: FieldKind;
  defaultValue?: Value;
};

/**
 * Builder for a `Reference()` field.
 *
 * References store the row id of another Capsule table. The target table must
 * exist in the Capsule schema.
 */
export type ReferenceFieldBuilder = {
  kind: "Reference";
  targetTable: string;
  default(defaultValue: string | null): ReferenceFieldDefinition;
};

export type ReferenceFieldDefinition = {
  kind: "Reference";
  targetTable: string;
  defaultValue?: string | null;
};

export type AnyFieldDefinition =
  | FieldBuilder<unknown>
  | FieldDefinition<unknown>
  | ReferenceFieldBuilder
  | ReferenceFieldDefinition;

export type TableAclOperation = "read" | "write" | "insert" | "update" | "delete";

/**
 * File metadata shape exposed inside table ACL helpers.
 *
 * ACLs receive metadata, not uploaded file bytes. Use it to authorize access to
 * File references without coupling table rules to a storage backend.
 */
export type AclStorageFileMetadata = {
  id: string;
  path: string;
  bucket: string;
  owner: string;
  ownerId: string;
  status: string;
  size: number;
  type: string;
  name: string;
  originalName: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

/** Adapter-neutral ACL reads resolve synchronously on SQLite and asynchronously on remote database engines. Await them in portable ACL rules. */
export type AclDatabaseHelpers = {
  get(tableName: string, id: string): MaybePromise<Record<string, unknown> | null>;
  exists(tableName: string, id: string): MaybePromise<boolean>;
};

export type AclStorageHelpers = {
  get(resourceName: "files", reference: string): MaybePromise<AclStorageFileMetadata | null>;
  exists(resourceName: "files", reference: string): MaybePromise<boolean>;
};

/** Read-only Team decisions available while evaluating table and File ACL rules. */
export type AclTeamHelpers = {
  /** True when the current linked actor belongs to the explicitly identified Team. */
  isMember(teamId: string): MaybePromise<boolean>;
  /** True when the current linked actor is an admin of the explicitly identified Team. */
  isAdmin(teamId: string): MaybePromise<boolean>;
  /** True when the current linked actor holds this currently declared application role in the explicitly identified Team. */
  hasRole(teamId: string, role: string): MaybePromise<boolean>;
  /** True when the current linked actor holds any role in this non-empty, bounded (32 maximum) declared-role set for the explicitly identified Team. */
  hasAnyRole(teamId: string, roles: readonly string[]): MaybePromise<boolean>;
};

export type AclHelpers = {
  db: AclDatabaseHelpers;
  storage: AclStorageHelpers;
  teams: AclTeamHelpers;
};

/** Public, non-secret application identity available to server code. */
export type AppContext = Readonly<{ publicOrigin: string }>;

/**
 * Runtime context available while evaluating table ACL rules.
 *
 * This is an exact read-only security projection. Arbitrary fields added by
 * Capsule context middleware are intentionally not forwarded into ACL rules;
 * pass stable policy inputs through row data and use `ctx.acl` for runtime
 * decisions.
 */
export type TableAclContext = {
  readonly app: AppContext;
  auth: AuthContext;
  credential: CredentialProvenance;
  acl: AclHelpers;
};

/**
 * Input supplied to a table ACL rule.
 *
 * `previous` is populated for updates and deletes. `next` is populated for
 * inserts and updates. `row` contains the row being checked when the operation
 * naturally has a single row candidate.
 */
export type TableAclRuleInput<Row extends Record<string, unknown> = Record<string, unknown>> = {
  ctx: TableAclContext;
  operation: TableAclOperation;
  table: string;
  row?: Row | null;
  previous?: Row | null;
  next?: Row | null;
};

export type TableAclRule<Row extends Record<string, unknown> = Record<string, unknown>> = (
  input: TableAclRuleInput<Row>,
) => MaybePromise<boolean>;

/** File operations that a Capsule may deliberately share beyond the file owner. */
export type FileAclOperation = "read" | "publicUrl" | "delete";

/**
 * Read-only context available while evaluating a File ACL rule.
 *
 * Unlike a trusted Capsule handler this never exposes `ctx.teams`, `ctx.db`,
 * request state, or Privileged server role. Use `ctx.acl.teams` with an
 * explicit Team ID stored in the Capsule's own File-policy model.
 */
export type FileAclContext = {
  readonly app: AppContext;
  auth: AuthContext;
  credential: CredentialProvenance;
  acl: AclHelpers;
};

/** Stable File metadata supplied to a File ACL rule; it never includes bytes or storage credentials. */
export type FileAclRuleInput = {
  ctx: FileAclContext;
  operation: FileAclOperation;
  file: AclStorageFileMetadata;
};

export type FileAclRule = (input: FileAclRuleInput) => MaybePromise<boolean>;

/** Metadata supplied before an SDK upload URL is issued; name is the stored display filename, falling back to the normalized File path. */
export type FileUploadMetadata = Readonly<{ sizeBytes: number; mimeType: string; name: string }>;
/** Opt-in policy for SDK uploads and replacements; absence allows existing behavior. */
export type FileUploadAclRule = (ctx: FileAclContext, meta: FileUploadMetadata) => MaybePromise<boolean>;
/** Optional sharing rules plus an upload admission policy. Owner and public-URL revocation authority stay unchanged. */
export type FileAclRules = Partial<Record<FileAclOperation, FileAclRule>> & { upload?: FileUploadAclRule };

export type FileIngressPrincipal = Readonly<{ namespace: string; key: string }>;
/** Runtime-owned inspector names; Capsule code cannot supply verdicts. */
export type FileIngressInspection = Readonly<{ policyRevision: string; maxVerdictAgeMs?: number; requiredInspectors: readonly ("content-policy-v1" | "clamav")[] }>;
export type FileIngressAdmissionDecision = Readonly<{ allow: false } | { allow: true; principal: FileIngressPrincipal; allowFiles?: boolean }>;
export type FileIngressAdmissionRequest = Readonly<{ method: string; path: string; headers: Readonly<Record<string, string>>; query: Readonly<Record<string, string>> }>;
/** Shared immutable request head supplied to endpoint multipart admission. */
export type EndpointMultipartAdmissionRequest = FileIngressAdmissionRequest;
export type FileIngressAdmissionContext<Schema extends SchemaDefinition = SchemaDefinition> = Readonly<{ app: AppContext; db: ReadOnlyDatabaseFromSchema<Schema>; env: Readonly<Record<string, string | undefined>>; signal?: AbortSignal; request: FileIngressAdmissionRequest; rateLimit(key: string, options: RateLimitOptions): RateLimitResult }>;
/** An authenticated, read-only policy context evaluated before a multipart endpoint reads its request body. */
export type EndpointMultipartAdmissionContext<Schema extends SchemaDefinition = SchemaDefinition> = Readonly<{ app: AppContext; auth: AuthContext; credential: CredentialProvenance; db: ReadOnlyDatabaseFromSchema<Schema>; env: Readonly<Record<string, string | undefined>>; signal?: AbortSignal; request: FileIngressAdmissionRequest }>;
/** The endpoint policy may prohibit file parts before staging; it cannot widen limits or provide file claim authority. */
export type EndpointMultipartAdmissionDecision = Readonly<{ allow: true; allowFiles?: boolean } | { allow: false }>;
/** Runtime-owned bounds and stable identifiers for one endpoint multipart ingress request. File bytes use the smaller of maxFileBytes and files.maxSizeBytes. A malformed filename can be classified as a field; file allowances never raise maxFieldBytes. MULTIPART_LIMIT_EXCEEDED errors may include safe details: { partType: "file" | "field", limitKind, limit }. Byte limits report bytes; maxFiles and maxFieldCount report counts. */
export type EndpointMultipartIngressLimits = Readonly<{ maxFiles: number; maxFileBytes: number; maxTotalFileBytes: number; maxFieldCount: number; maxFieldBytes: number; maxTotalFieldBytes: number; allowedMimeTypes?: readonly string[]; allowedPathPrefixes: readonly string[]; requestKeyHeader: string; partKeyHeader: string; requireStablePartKeys?: boolean; inspection?: FileIngressInspection }>;
/** Actor-owned ingress may apply a request-specific admission policy. */
export type EndpointActorMultipartIngressOptions<Schema extends SchemaDefinition = SchemaDefinition> = EndpointMultipartIngressLimits & Readonly<{ claimAuthorities?: readonly ["actor"]; admit?(ctx: EndpointMultipartAdmissionContext<Schema>, request: FileIngressAdmissionRequest): MaybePromise<EndpointMultipartAdmissionDecision> }>;
/** Capsule-principal ingress has its separate Capsule-level admission policy and cannot add actor admission. */
export type EndpointCapsulePrincipalMultipartIngressOptions = EndpointMultipartIngressLimits & Readonly<{ claimAuthorities: readonly ["capsule-principal"]; admit?: never }>;
/** One of the supported endpoint multipart ingress authority modes. */
export type EndpointMultipartIngressOptions<Schema extends SchemaDefinition = SchemaDefinition> = EndpointActorMultipartIngressOptions<Schema> | EndpointCapsulePrincipalMultipartIngressOptions;
export type CapsuleFilesDefinition<Schema extends SchemaDefinition = SchemaDefinition> = {
  acl?: FileAclRules; accessKeys?: CapsuleFileAccessKeyPolicy;
  ingress?: { principalNamespaces: readonly string[]; admit(ctx: FileIngressAdmissionContext<Schema>, request: FileIngressAdmissionRequest): MaybePromise<FileIngressAdmissionDecision> };
};

/**
 * Per-operation table ACL rules.
 *
 * `write` is a convenience rule for all write operations. More specific rules
 * such as `insert`, `update`, or `delete` can be used when different ownership
 * checks are needed.
 */
export type TableAclRules<Row extends Record<string, unknown> = Record<string, unknown>> = Partial<
  Record<TableAclOperation, TableAclRule<Row>>
>;

/**
 * Opt-in table ACL presets. Both names return immutable read/write deny rules.
 * Ordinary reads are filtered and writes are denied; explicit server-owned
 * Privileged contexts retain their existing audited, callback-bound access.
 */
export const acl: Readonly<{
  privilegedOnly(): Readonly<{ read: () => boolean; write: () => boolean }>;
  /** Alias of privilegedOnly(). */
  denyAll(): Readonly<{ read: () => boolean; write: () => boolean }>;
}>;

/**
 * A Capsule table definition.
 *
 * Table definitions are declared in `capsule({ schema })`; Sporades adds
 * managed `id`, `createdAt`, and `updatedAt` fields to every stored row.
 *
 * @example
 * ```ts
 * const notes = table({
 *   body: String(),
 *   ownerId: String(),
 * }).acl({
 *   read: ({ row, ctx }) => row?.ownerId === ctx.auth.userId,
 *   write: ({ next, previous, ctx }) =>
 *     (next?.ownerId ?? previous?.ownerId) === ctx.auth.userId,
 * });
 * ```
 */
export type TableDefinition<Fields extends Record<string, AnyFieldDefinition> = Record<string, AnyFieldDefinition>> = {
  kind: "table";
  fields: Fields;
  aclRules?: TableAclRules;
  uniqueConstraints?: readonly (readonly string[])[];
  acl(rules: TableAclRules<RowFromFields<Fields>>): TableDefinition<Fields>;
  unique(...fields: [keyof Fields & string, ...(keyof Fields & string)[]]): TableDefinition<Fields>;
};

export type CapsuleTableDefinition<Fields extends Record<string, AnyFieldDefinition>> = Omit<TableDefinition<Fields>, "acl" | "unique"> & {
  acl(rules: TableAclRules<RowFromFields<Fields>>): CapsuleTableDefinition<Fields>;
  unique(...fields: [keyof Fields & string, ...(keyof Fields & string)[]]): CapsuleTableDefinition<Fields>;
};

export type SchemaDefinition = Record<string, TableDefinition<any>>;

/** Sporades-managed fields present on every table row. App code cannot set or update these directly. */
export type AutoFields = {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type FieldValue<Field> = Field extends FieldBuilder<infer Value>
  ? Value | null
  : Field extends FieldDefinition<infer Value>
    ? Value
    : Field extends ReferenceFieldBuilder | ReferenceFieldDefinition
      ? string | null
      : unknown;

export type RowFromFields<Fields extends Record<string, AnyFieldDefinition>> = AutoFields & {
  [Key in keyof Fields]: FieldValue<Fields[Key]>;
};

export type InsertValues<Row> = Partial<Omit<Row, keyof AutoFields>>;
export type UpdateValues<Row> = Partial<Omit<Row, keyof AutoFields>>;
export type OrderDirection = "asc" | "desc" | "ASC" | "DESC";

/**
 * Runtime table API exposed as `ctx.db.<tableName>` inside server handlers.
 *
 * Chain immutable `where`, `orderBy`, and `limit` builders, then `get` or `all`.
 * Await terminal operations: even SQLite can defer work behind a transaction.
 * Inserts/updates include auto fields; reads that outlive their handler fail closed.
 */
export type TableApi<Row extends Record<string, unknown> = Record<string, unknown>> = {
  insert(values: InsertValues<Row>): MaybePromise<Row>;
  /** Atomically insert, returning null only for the exactly named declared unique constraint. */
  insertOrIgnore(values: InsertValues<Row>, ...conflictFields: [keyof InsertValues<Row> & string, ...(keyof InsertValues<Row> & string)[]]): MaybePromise<Row | null>;
  update(id: string, values: UpdateValues<Row>): MaybePromise<Row | null>;
  delete(id: string): MaybePromise<boolean>;
  where<FieldName extends keyof Row & string>(fieldName: FieldName, value: Row[FieldName]): TableApi<Row>;
  orderBy(fieldName: keyof Row & string, direction?: OrderDirection): TableApi<Row>;
  limit(count: number): TableApi<Row>;
  get(): MaybePromise<Row | null>;
  all(): MaybePromise<Row[]>;
};
/** With operator telemetry enabled, internal statement/transaction spans explain HTTP request database time. No SQL, parameters or rows are exported; authoring and transaction semantics are unchanged. */
export type DatabaseFromSchema<Schema extends SchemaDefinition> = {
  [TableName in keyof Schema]: Schema[TableName] extends TableDefinition<infer Fields> ? TableApi<RowFromFields<Fields>> : TableApi;
};

export type ReadOnlyTableApi<Row extends Record<string, unknown> = Record<string, unknown>> = {
  where<FieldName extends keyof Row & string>(fieldName: FieldName, value: Row[FieldName]): ReadOnlyTableApi<Row>;
  orderBy(fieldName: keyof Row & string, direction?: OrderDirection): ReadOnlyTableApi<Row>;
  limit(count: number): ReadOnlyTableApi<Row>;
  get(): Promise<Row | null>;
  all(): Promise<Row[]>;
};

export type ReadOnlyDatabaseFromSchema<Schema extends SchemaDefinition> = {
  [TableName in keyof Schema]: Schema[TableName] extends TableDefinition<infer Fields> ? ReadOnlyTableApi<RowFromFields<Fields>> : ReadOnlyTableApi;
};

/**
 * Current Sporades user identity for a handler invocation.
 *
 * Every visitor has a real Anonymous session. `isAuthenticated` means the
 * request has a valid session; `isGuest` tells you whether that session is still
 * anonymous rather than linked to email, Google, or another provider.
 */
export type AuthContext = {
  /** Trusted Hosted request address; absent outside a trusted request. Never forwarding-header input. Excluded from durable resource receipt identity. */
  readonly clientAddress?: string;
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

export type SessionCredentialProvenance = Readonly<{ kind: "session" }>;
export type AccessKeyCredentialProvenance = Readonly<{ kind: "access-key"; id: string; name: string }>;
export type CredentialProvenance = SessionCredentialProvenance | AccessKeyCredentialProvenance;
export type CredentialKind = CredentialProvenance["kind"];

export type AccessKeyStatus = "active" | "expired" | "revoked";
export type AccessKeyRevocationCause = "owner" | "operator" | "password-reset" | "password-change" | "owner-unlinked" | "owner-deleted" | "service-user-administrator" | "service-user-disabled";

export type AccessKeySummary = {
  id: string;
  name: string;
  grants: string[];
  effectiveScopes: string[];
  status: AccessKeyStatus;
  createdAt: string;
  expiresAt: string | null;
  rotatedAt: string | null;
  revokedAt: string | null;
  revocationCause: AccessKeyRevocationCause | null;
  lastUsedAt: string | null;
  lifecycleRevision: number;
};

export type IssueAccessKeyInput = {
  name: string;
  grants?: string[];
  expiresAt?: string | null;
};

export type RotateAccessKeyOptions = {
  lifecycleRevision: number;
};

export type ListAccessKeysOptions = {
  cursor?: string;
  limit?: number;
  status?: AccessKeyStatus;
};

export type CurrentUserAccessKeysApi = {
  issue(input: IssueAccessKeyInput): Promise<{ accessKey: AccessKeySummary; token: string }>;
  rotate(id: string, options: RotateAccessKeyOptions): Promise<{ accessKey: AccessKeySummary; token: string }>;
  list(options?: ListAccessKeysOptions): Promise<{
    accessKeys: AccessKeySummary[];
    declaredScopes: string[];
    nextCursor: string | null;
    totalCount: number;
  }>;
  revoke(id: string): Promise<{ accessKey: AccessKeySummary }>;
  delete(id: string): Promise<{ id: string; deleted: true }>;
};

export type ServiceUserStatus = "active" | "disabled";
export type ServiceUserSummary = {
  id: string;
  displayName: string;
  status: ServiceUserStatus;
  createdAt: string;
  disabledAt: string | null;
};

export type CreateServiceUserInput = {
  displayName: string;
  /** Every service User starts with one independently named scoped credential. */
  accessKey: IssueAccessKeyInput;
};

declare const validatedLifecycleOperationBrand: unique symbol;
/** Opaque, transaction-bound lifecycle work reserved during initial Mutation dispatch. */
export type ValidatedLifecycleOperation<Result> = Readonly<{ readonly [validatedLifecycleOperationBrand]: Result }>;

export type LifecycleContinuationApi = {
  continue<Result, Output>(
    operation: ValidatedLifecycleOperation<Result>,
    continuation: (result: Result) => Output | Promise<Output>,
  ): Output;
  continue<Results extends readonly unknown[], Output>(
    operations: { [Index in keyof Results]: ValidatedLifecycleOperation<Results[Index]> },
    continuation: (results: Results) => Output | Promise<Output>,
  ): Output;
};

export type ServiceUsersApi = {
  create(input: CreateServiceUserInput): Promise<{ serviceUser: ServiceUserSummary; accessKey: AccessKeySummary; token: string }>;
  issueAccessKey(userId: string, input: IssueAccessKeyInput): Promise<{ serviceUser: ServiceUserSummary; accessKey: AccessKeySummary; token: string }>;
  rotateAccessKey(userId: string, accessKeyId: string, options: RotateAccessKeyOptions): Promise<{ serviceUser: ServiceUserSummary; accessKey: AccessKeySummary; token: string }>;
  listAccessKeys(userId: string, options?: ListAccessKeysOptions): Promise<{
    serviceUser: ServiceUserSummary;
    accessKeys: AccessKeySummary[];
    declaredScopes: string[];
    nextCursor: string | null;
    totalCount: number;
  }>;
  revokeAccessKey(userId: string, accessKeyId: string): Promise<{ serviceUser: ServiceUserSummary; accessKey: AccessKeySummary }>;
  disable(userId: string): Promise<{ serviceUser: ServiceUserSummary; revokedCount: number; accessKeys: AccessKeySummary[] }>;
  reserveCreate(input: CreateServiceUserInput): ValidatedLifecycleOperation<{ serviceUser: ServiceUserSummary; accessKey: AccessKeySummary; token: string }>;
  reserveIssueAccessKey(userId: string, input: IssueAccessKeyInput): ValidatedLifecycleOperation<{ serviceUser: ServiceUserSummary; accessKey: AccessKeySummary; token: string }>;
  reserveRotateAccessKey(userId: string, accessKeyId: string, options: RotateAccessKeyOptions): ValidatedLifecycleOperation<{ serviceUser: ServiceUserSummary; accessKey: AccessKeySummary; token: string }>;
  reserveListAccessKeys(userId: string, options?: ListAccessKeysOptions): ValidatedLifecycleOperation<{ serviceUser: ServiceUserSummary; accessKeys: AccessKeySummary[]; declaredScopes: string[]; nextCursor: string | null; totalCount: number }>;
  reserveRevokeAccessKey(userId: string, accessKeyId: string): ValidatedLifecycleOperation<{ serviceUser: ServiceUserSummary; accessKey: AccessKeySummary }>;
  reserveDisable(userId: string): ValidatedLifecycleOperation<{ serviceUser: ServiceUserSummary; revokedCount: number; accessKeys: AccessKeySummary[] }>;
};

export type PrivilegedAccessKeySummary = AccessKeySummary & { ownerUserId: string };

export type PrivilegedAccessKeysApi = {
  list(ownerUserId: string, options?: ListAccessKeysOptions): Promise<{
    accessKeys: PrivilegedAccessKeySummary[];
    declaredScopes: string[];
    nextCursor: string | null;
    totalCount: number;
  }>;
  inspect(id: string): Promise<{ accessKey: PrivilegedAccessKeySummary }>;
  revoke(id: string): Promise<{ accessKey: PrivilegedAccessKeySummary }>;
  revokeAll(ownerUserId: string): Promise<{ ownerUserId: string; revokedCount: number; accessKeys: PrivilegedAccessKeySummary[] }>;
  delete(id: string): Promise<{ id: string; ownerUserId: string; deleted: true }>;
};

export type RequireAuthOptions = {
  /** Require a linked account instead of allowing an Anonymous session. */
  linked?: boolean;
};

/** Logger captured by Sporades inspection surfaces. */
export type Logger = {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

/** One SMTP mailbox, optionally with a display name. */
export type MailAddress = string | { email: string; name?: string };

/**
 * Common provider-independent message shape accepted by `ctx.mail.send(...)`.
 *
 * `provider` is validated for the configured SMTP vendor and translated into
 * approved MIME headers. It is not an arbitrary provider API payload and
 * cannot override addressing, content, authentication, or transport settings.
 */
export type MailSendInput = {
  to: MailAddress | MailAddress[];
  cc?: MailAddress | MailAddress[];
  bcc?: MailAddress | MailAddress[];
  from?: MailAddress;
  replyTo?: MailAddress;
  subject: string;
  textBody?: string;
  htmlBody?: string | Html;
  /** Emits one standard Auto-Submitted header; omitted messages emit none. */
  autoSubmitted?: "no" | "auto-generated" | "auto-replied";
  provider?: JsonObject;
};

/**
 * Stable SMTP delivery result.
 *
 * Delivery is partial by recipient: any address the server rejects at RCPT
 * appears in `rejected`, the message is still delivered to everyone in
 * `accepted`, and the call resolves. It rejects only when no recipient was
 * accepted or the conversation itself failed — with `MAIL_REJECTED` when every
 * rejection was definitive (5xx) and `MAIL_CONNECTION_FAILED` when any was
 * transient (4xx greylisting, rate limiting, temporary unavailability), which a
 * later attempt may still deliver.
 */
export type MailSendResult = {
  messageId: string;
  accepted: string[];
  rejected: string[];
};

/**
 * Server-only runtime-owned SMTP delivery API.
 *
 * Available to trusted Capsule handlers, lifecycle hooks, middleware,
 * mutation hooks, Jobs, and active Privileged callbacks. It is intentionally
 * absent from browser, table ACL, and Schedule payload-factory contexts.
 */
export type MailApi = {
  /**
   * Whether the runtime can deliver mail. `false` when `mail.smtp` is omitted
   * from `sporades.json`, and when it is configured but its named credentials
   * are absent from Server env; the Capsule still starts in both cases and
   * every `send` rejects.
   */
  readonly enabled: boolean;
  send(message: MailSendInput): Promise<MailSendResult>;
};

/** OpenAI-compatible wire API selected by `sporades.json` `ai.api` or a per-call override. */
export type AiApiKind = "chat-completions" | "responses";

/** One conversation turn. System instructions travel separately in {@link AiChatInput.system}. */
export type AiMessage = { role: "user" | "assistant"; content: string };

/**
 * Per-call provider values. Each takes precedence over the project `ai` declaration and its Server
 * env key, including when `ai` is undeclared or `enabled: false`; omitted values fall back to the
 * declaration. The project key is sent only to the project base URL, so a different `baseUrl` needs
 * `apiKey`. `baseUrl` follows the same HTTPS rule as `ai.baseUrl`. `apiKey` is never logged.
 */
export type AiProviderOverride = {
  api?: AiApiKind;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
};

/**
 * Provider-neutral input accepted by `ctx.ai.chat(...)`. Unknown fields are an `AI_INVALID_REQUEST`.
 * At most 64 messages and 256 KiB of combined `system` and message content.
 */
export type AiChatInput = {
  messages: AiMessage[];
  system?: string;
  /** Upper bound on generated tokens, 1-131072. */
  maxTokens?: number;
  /** Whole-call deadline in milliseconds, 100-30000. Defaults to 2000. */
  timeoutMs?: number;
  /** 0-2. */
  temperature?: number;
  /**
   * JSON Schema object (at most 64 KiB) requested in strict structured-output mode. The response
   * text is parsed as JSON into `json`; Sporades does not validate it against the schema.
   */
  jsonSchema?: JsonObject;
  provider?: AiProviderOverride;
  /** Cancels the call with `AI_ABORTED`. A Job or Privileged `ctx.signal` is also honoured. */
  signal?: AbortSignal;
};

/** Token counts reported by the provider; `null` when it did not report one. */
export type AiUsage = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };

/** Closed failure codes. Messages are constant and never contain provider or prompt content. */
export type AiErrorCode =
  | "AI_UNCONFIGURED"
  | "AI_INVALID_REQUEST"
  | "AI_TIMEOUT"
  | "AI_ABORTED"
  | "AI_UPSTREAM_ERROR"
  | "AI_INVALID_RESPONSE";

/**
 * Result of `ctx.ai.chat(...)`. The call never rejects and never retries. `status` is present on
 * `AI_UPSTREAM_ERROR` when the provider answered with a non-2xx HTTP status.
 */
export type AiChatResult =
  | { ok: true; text: string; json?: JsonValue; usage: AiUsage; model: string }
  | { ok: false; code: AiErrorCode; message: string; status?: number };

/**
 * Server-only runtime-owned client for OpenAI-compatible endpoints (hosted providers, Ollama,
 * vLLM). Available to trusted Capsule handlers, lifecycle hooks, middleware, mutation hooks, Jobs,
 * and active Privileged callbacks; absent from browser, table ACL, and Schedule payload-factory
 * contexts. Prompt and response content is never logged; each call emits one `ai.call` metering
 * event with api, model, token usage, latency, and outcome.
 */
export type AiApi = {
  /**
   * Whether the project default is usable: an enabled `ai` block whose `keyEnv` Server env value is
   * set. It describes only the default. When `false`, a call with no `provider` override resolves
   * `AI_UNCONFIGURED`, but per-call `provider` values can still supply the missing base URL, model,
   * or key, even when `ai` is undeclared or `enabled: false`.
   */
  readonly enabled: boolean;
  chat(input: AiChatInput): Promise<AiChatResult>;
};

/**
 * Closed result of {@link ServerAuthApi.terminateHumanIdentity}. `terminated` is returned by the
 * committing first call; every later authorized call for the same user ID returns
 * `already-terminated`, including after restart and after the email is registered again.
 */
export type TerminateHumanIdentityResult = Readonly<{
  userId: string;
  status: "terminated" | "already-terminated";
}>;

/**
 * Server-only auth management API.
 *
 * Available to trusted Capsule handlers. Lets server code update email
 * credentials (e.g. for password reset flows) without direct access to the
 * internal auth database.
 */
export type ServerAuthApi = {
  /**
   * Atomically retire every Session and current Access key owned by one exact
   * existing human user. Available only during an authenticated Capsule
   * mutation transaction; never changes identity or app-owned authority.
   */
  revokeHumanSecurity(userId: string): Promise<{ userId: string; revokedSessionCount: number; revokedAccessKeyCount: number }>;
  reserveRevokeHumanSecurity(userId: string): ValidatedLifecycleOperation<{ userId: string; revokedSessionCount: number; revokedAccessKeyCount: number }>;
  /**
   * Terminally close one exact linked human in the Mutation transaction (ADR-0057), leaving a
   * non-authenticating tombstone. Deletes email credentials, Provider identities, Sessions, OAuth
   * attempts, Reset codes and preferences; retires current Access keys with cause `owner-deleted`.
   * Requires initial Mutation dispatch and a current authenticated human Session; caller/target
   * identity locks and the exact live Session fence remain held through commit. Other callers,
   * surfaces and target kinds fail with `HUMAN_IDENTITY_TERMINATION_DENIED`; any Team membership
   * fails with `HUMAN_IDENTITY_TERMINATION_BLOCKED`. The Capsule owns admin policy and reauthentication.
   */
  terminateHumanIdentity(userId: string): Promise<TerminateHumanIdentityResult>;
  /** Write-free, one-shot reservation of {@link terminateHumanIdentity} for `ctx.lifecycle.continue`. */
  reserveTerminateHumanIdentity(userId: string): ValidatedLifecycleOperation<TerminateHumanIdentityResult>;
  /**
   * Write-free, one-shot password-change reservation for `ctx.lifecycle.continue` in the owning
   * Mutation. Requires `requireAuth({ linked: true, credentials: ["session"],
   * reauthentication: "change-password" }, handler)` and a declared `change-password` purpose.
   * Rechecks the exact live human Session, credential ownership and current password under the
   * shared identity/credential fence. Passwords are strings of at most 1024 characters; the new
   * password requires at least 8. Input, authority and storage failures (including transaction entry/commit)
   * return opaque `PASSWORD_CHANGE_DENIED`; missing/expired proofs return `REAUTHENTICATION_REQUIRED`.
   * Execution updates the password and retires every Session, purpose proof, outstanding Reset
   * code and current human Access key with cause `password-change` in the Mutation transaction.
   * The continuation may stage app outbox rows and delivery Jobs in that same transaction; any
   * failure rolls everything back; Capsule continuation errors are preserved. Mail transport runs in a
   * Job after commit. Successful clients must sign in again. Preserves trusted `setEmailPassword`.
   */
  reserveChangeEmailPassword(email: string, currentPassword: string, newPassword: string): ValidatedLifecycleOperation<Readonly<{ ok: true }>>;
  /** Update the password for an existing email credential. Throws if the email is not registered. */
  setEmailPassword(email: string, newPassword: string): Promise<void>;
  /**
   * Issue a Reset code and deliver it over the runtime SMTP transport.
   *
   * Resolves identically for registered and unregistered emails. Ambiguous legacy or
   * same-millisecond generation evidence skips delivery; request a fresh link. Issuance serializes
   * with termination. Throws only if mail is unconfigured or email auth is disabled.
   */
  sendEmailPasswordResetLink(email: string, options?: PasswordResetMailOptions): Promise<void>;
  /**
   * Issue a Reset code and return its link without sending anything, for
   * Capsules that deliver through their own mail path.
   *
   * Unlike `sendEmailPasswordResetLink` this throws for an unregistered email,
   * because its whole purpose is to return a link. It is server-only: exposing
   * its result to an unauthenticated caller reintroduces account enumeration.
   */
  createEmailPasswordResetLink(email: string): Promise<PasswordResetLink>;
  /** Report which account a Reset code belongs to. Does not spend the code. */
  verifyPasswordResetCode(code: string): Promise<{ email: string }>;
  /**
   * Spend a Reset code and set the new password. Atomically revokes every
   * Session and current Access key for that user and does not create a new one.
   * After success, clears only this email's aggregate sign-in risk; caller,
   * trusted-address and process verification budgets remain in force.
   */
  confirmPasswordReset(code: string, newPassword: string): Promise<void>;
};

/** Safe current-user Team presentation; membership enumeration is not exposed here. */
export type TeamSummary = {
  id: string;
  name: string;
  role: "admin" | "member";
  applicationRoles: string[];
  memberCount: number;
};
/** Safe member presentation for an exact-Team administrator. */
export type TeamMemberSummary = {
  userId: string;
  displayName: string;
  picture: string | null;
  role: "admin" | "member";
  applicationRoles: string[];
};
export type TeamMembersListOptions = { cursor?: string; limit?: number };
export type TeamMembersListResult = { members: TeamMemberSummary[]; nextCursor?: string; totalCount: number };
/** Exact accepted-membership total for one Team the current linked user belongs to. */
export type TeamMemberCountResult = { totalCount: number };
export type TeamJoinLink = { id: string; email: string; createdAt: string; expiresAt: string };
/** Safe active Join-link metadata for userless Privileged inspection. Target email is admin-only. */
export type PrivilegedTeamJoinLink = { id: string; createdAt: string; expiresAt: string };
export type TeamJoinLinkInspection = { team: { id: string; name: string } | null; expiresAt: string | null; usable: boolean };
/** Safe post-auth Join-link check. It never consumes, reserves, or explains a capability. */
export type TeamJoinLinkValidation = { valid: boolean };
/** Atomic membership-scoped application-role reconciliation. Management role is never included. */
export type TeamApplicationRoleChanges = { add: string[]; remove: string[] };
export type TeamJoinAdmissionInput = { teamId: string; userId: string; currentMemberCount: number };
export type TeamJoinAdmissionDecision = { allow: boolean };
export type TeamJoinAdmissionContext<Schema extends SchemaDefinition = SchemaDefinition> = Pick<CapsuleContext<Schema>, "app" | "auth" | "env" | "log"> & {
  /** Transaction-bound app-table reads that bypass the joining user's ordinary row ACLs. Runtime tables and mutations are unavailable. */
  db: ReadOnlyDatabaseFromSchema<Schema>;
  /** Provider-free verified billing state for the exact Team whose Join is being admitted. */
  teamBilling: Pick<CurrentUserTeamBillingApi, "get">;
};
/** Additional-Team proposal after current actor checks, serialized with creation for that actor. The initial personal Team bypasses this policy. */
export type TeamCreateAdmissionInput = Readonly<{
  actorUserId: string;
  /** NFKC-normalized, whitespace-collapsed requested name, bounded to 80 UTF-8 bytes. */
  name: string;
  /** Live Teams created by the actor, including the initial personal Team and Teams they left. Excludes the candidate. */
  currentCreatedTeamCount: number;
}>;
/** Only an own data property `allow: true`, with no additional properties, permits creation. */
export type TeamCreateAdmissionDecision = { allow: boolean };
export type TeamCreateAdmissionContext<Schema extends SchemaDefinition = SchemaDefinition> = Readonly<{
  app: AppContext;
  auth: Readonly<AuthContext>;
  /** Transaction-bound cross-owner Capsule reads bypass row ACLs. No writes, runtime tables, provider operations, credentials or nested Privileged capability. Revoked on settle/abort/5-second budget expiry; failed or unfinished reads deny even if caught. */
  db: ReadOnlyDatabaseFromSchema<Schema>;
  signal: AbortSignal;
}>;
/** A destructive transition is proposed only after current Session, Team and final-admin checks under its lifecycle lock. */
export type TeamDestructivePolicyInput = Readonly<{
  teamId: string;
  actorUserId: string;
  operation: "demote" | "removeMember" | "leave" | "delete";
  /** Exact affected current membership; deletion currently requires the actor to be the sole member. */
  member: Readonly<{ userId: string; role: "admin" | "member" }>;
  /** Deletion affects every responsibility associated with teamId, regardless of its owner or holder. */
  scope: "member" | "team";
}>;
/** Only an own data property `allow: true`, with no additional properties, permits the write. */
export type TeamDestructivePolicyDecision = { allow: boolean };
export type TeamDestructivePolicyContext<Schema extends SchemaDefinition = SchemaDefinition> = Readonly<{
  app: AppContext;
  auth: Readonly<AuthContext>;
  /** Transaction-bound cross-owner Capsule reads bypass row ACLs. No writes, runtime tables, provider operations or nested Privileged capability. Revoked on settle/abort/5-second budget expiry; unreadable or unfinished reads deny even if caught. */
  db: ReadOnlyDatabaseFromSchema<Schema>;
  signal: AbortSignal;
}>;
/** Snapshot of one optional exact member, read after acquiring the lifecycle lock. No profiles or credentials. */
export type TeamLifecycleSnapshot = Readonly<{
  teamId: string;
  member: Readonly<{ userId: string; role: "admin" | "member" }> | null;
}>;

export type TeamBillingQuantityPolicy =
  | { kind: "fixed"; value: number }
  | { kind: "team-members"; minimum?: number };
export type TeamBillingProductDeclaration = {
  quantity: TeamBillingQuantityPolicy;
  stripe: {
    sandbox: { priceId: string; productId?: string; portalConfigurationId?: string };
    live: { priceId: string; productId?: string; portalConfigurationId?: string };
  };
};
export type TeamBillingOperation = "read" | "checkout" | "portal" | "plan-transition" | "erasure";
export type TeamBillingAuthorityInput = {
  teamId: string;
  teamRole: "admin" | "member";
  operation: TeamBillingOperation;
  productKey?: string;
};
export type TeamBillingAuthorityDecision = { allow: boolean };
/** Closed provider-identifier-free Team Billing truth available to Capsule policy. */
export type TeamBillingProjection =
  | { state: "inactive"; teamId: string }
  | { state: "pending"; teamId: string; operation: "checkout" | "portal" | "plan-transition" | "erasure" | "reconciliation"; productKey?: string; requestedAt: string }
  | { state: "active"; teamId: string; productKey: string; quantity: number; renewsAt: string }
  | { state: "cancelling"; teamId: string; productKey: string; quantity: number; endsAt: string }
  | { state: "past-due"; teamId: string; productKey: string; quantity: number; currentPeriodEnd: string }
  | { state: "cancelled"; teamId: string; productKey: string; quantity: number }
  | { state: "attention-required"; teamId: string; reason: "catalogue-mismatch" | "provider-state-ambiguous" };
export type CurrentUserTeamBillingApi = {
  /** Provider-free verified billing truth for app policy; requires current linked Team membership. */
  get(teamId: string): Promise<TeamBillingProjection>;
  /** Admits only the app's separate local deletion transaction after provider quiescence is durably proven. */
  admitLocalErasure(teamId: string): Promise<{ allowed: true }>;
};
export type TeamBillingAuthorityContext<Schema extends SchemaDefinition = SchemaDefinition> = Pick<CapsuleContext<Schema>, "app" | "auth" | "env" | "log"> & {
  /** Transaction-bound app-table reads. Runtime billing tables and mutations are unavailable. */
  db: ReadOnlyDatabaseFromSchema<Schema>;
  /** Transaction-bound exact accepted-member count for the Team under authority evaluation. */
  teams: Pick<PrivilegedTeamsApi, "countMembers">;
};
export type TeamBillingDefinition<Schema extends SchemaDefinition = SchemaDefinition> = {
  /** Exact allow-list of product keys and distinct Stripe sandbox/live Price bindings. */
  catalogue: Record<string, TeamBillingProductDeclaration>;
  /** Rechecked inside every operation transaction after current Team-admin admission. */
  authorize(ctx: TeamBillingAuthorityContext<Schema>, input: TeamBillingAuthorityInput): MaybePromise<TeamBillingAuthorityDecision>;
  /** Trusted same-origin Checkout returns. Omit to keep Checkout unavailable while retaining read-only billing state. */
  checkout?: {
    successPath: string;
    cancelPath: string;
    /** How long a validated Checkout URL may be returned to an authorized client; 60-1800 seconds, default 600. */
    continuationTtlSeconds?: number;
  };
  /** Trusted Customer Portal return. Every catalogue binding must also declare Product and explicit Portal configuration IDs. */
  portal?: {
    returnPath: string;
    /** How long a validated Portal URL may be returned to an authorized client; 60-1800 seconds, default 600. */
    continuationTtlSeconds?: number;
  };
};
export type CurrentUserTeamsApi = {
  /** Server-only: lock an administered Team through the existing mutation/endpoint transaction's commit or rollback. Call before any responsibility read/write; validate explicit recipient acceptance and the optional member's current admin role. Normal ctx.db ACLs remain in force. No network calls while locked. Refusal poisons the enclosing transaction. */
  lockLifecycle(teamId: string, memberUserId?: string): Promise<TeamLifecycleSnapshot>;
  list(): Promise<{ teams: TeamSummary[] }>;
  /** Creates a named Team and makes the current linked user its first admin. Linked users may belong to at most 25 Teams. Subject to the Capsule's atomic teams.admitCreate policy when declared. */
  create(name: string): Promise<{ team: TeamSummary }>;
  /** Renames an explicitly identified Team administered by the current user. */
  rename(teamId: string, name: string): Promise<{ team: TeamSummary }>;
  /** Lists a bounded safe membership directory for one Team the caller currently administers. */
  listMembers(teamId: string, options?: TeamMembersListOptions): Promise<TeamMembersListResult>;
  /** Returns only the exact accepted-membership total for one Team the current linked user belongs to. */
  countMembers(teamId: string): Promise<TeamMemberCountResult>;
  /** Atomically adds and removes declared application roles for a member of one administered Team. */
  updateApplicationRoles(teamId: string, userId: string, changes: TeamApplicationRoleChanges): Promise<{ updated: true }>;
  /** Creates an email-bound Join link and returns it without sending any message. The default lifetime is 86400 seconds; accepted integer lifetimes are 300 through 604800 seconds. */
  createJoinLink(teamId: string, email: string, options?: { ttlSeconds?: number }): Promise<{ id: string; link: string; createdAt: string; expiresAt: string }>;
  /** Lists active Join-link management metadata without recovering a capability. */
  listJoinLinks(teamId: string): Promise<{ links: TeamJoinLink[] }>;
  /** Idempotently revokes an unused Join link scoped to one administered Team. */
  revokeJoinLink(teamId: string, joinLinkId: string): Promise<{ revoked: true }>;
  /** Safely inspects a Join link without authentication or consumption. */
  inspectJoinLink(code: string): Promise<TeamJoinLinkInspection>;
  /** Checks whether the current linked user's attached emails match an active Join link without consuming it. */
  validateJoinLink(code: string): Promise<TeamJoinLinkValidation>;
  /** Redeems a current matching Join link atomically. New memberships are ordinary members with no application roles. */
  join(code: string): Promise<{ team: TeamSummary }>;
  /** Promotes an ordinary member in an explicitly identified Team the caller currently administers. */
  promote(teamId: string, userId: string): Promise<{ updated: true }>;
  /** Demotes an admin only when another committed Team admin remains. */
  demote(teamId: string, userId: string): Promise<{ updated: true }>;
  /** Removes another Team member; callers leave through leave(). */
  removeMember(teamId: string, userId: string): Promise<{ removed: true }>;
  /** Leaves an explicitly identified Team only while the caller is an ordinary member. */
  leave(teamId: string): Promise<{ left: true }>;
  /** Deletes a Team only when the caller is its sole remaining admin member. */
  delete(teamId: string): Promise<{ deleted: true }>;
};

/**
 * Read-only exact-Team inspection available only inside an active Privileged
 * callback. It carries no current-user membership or administration authority.
 * In-flight inspection rejects if the callback ends or its AbortSignal aborts
 * before the runtime can return a result.
 */
export type PrivilegedTeamsApi = {
  /** Retain an exact Team lifecycle lock in an already-active write transaction (including atomic Stripe consequences). This is inspection/serialization only: no user, membership mutation or admin authority. Nontransactional Jobs/Privileged callbacks and expired contexts fail closed. Pending acquisition/member reads that outlive the callback reject and roll back even when caught; successfully admitted locks remain held through outer commit. Call before responsibility reads/writes, without provider network calls. */
  lockLifecycle(teamId: string, memberUserId?: string): Promise<TeamLifecycleSnapshot>;
  /** Returns the exact accepted-membership total for an existing Team. */
  countMembers(teamId: string): Promise<TeamMemberCountResult>;
  /** Lists the existing safe member projection for an existing Team. */
  listMembers(teamId: string, options?: TeamMembersListOptions): Promise<TeamMembersListResult>;
  /** Lists active safe Join-link metadata without target email or a recoverable capability. */
  listJoinLinks(teamId: string): Promise<{ links: PrivilegedTeamJoinLink[] }>;
  /** Safely inspects a Join link without authentication or consumption. */
  inspectJoinLink(code: string): Promise<TeamJoinLinkInspection>;
};

export type PrivilegedTeamBillingQuarantine = Readonly<{
  teamId: string | null;
  associatedTeam: boolean;
  mode: "sandbox" | "live";
  eventType: string;
  occurredAt: string | null;
  reason: "catalogue-mismatch" | "provider-state-ambiguous";
}>;

export type PrivilegedTeamBillingApi = {
  /** Lists at most 100 provider-free quarantined observations, newest first. */
  listQuarantines(options?: { limit?: number }): Promise<{ quarantines: readonly PrivilegedTeamBillingQuarantine[] }>;
};

/** Copy overrides for the built-in password reset message. Each custom body should contain {{link}}. */
export type PasswordResetMailOptions = {
  subject?: string;
  /** Replaces {{link}} and {{expiresAt}} with the Reset URL and ISO expiry. Missing {{link}} logs a warning. */
  textBody?: string;
  /** Same placeholders, HTML-escaped for text or quoted attributes. Missing {{link}} logs a warning. */
  htmlBody?: string | Html;
};

/** A Reset code rendered as a link to the Capsule's own reset page. */
export type PasswordResetLink = {
  link: string;
  expiresAt: string;
};

export type MessageScope =
  | "currentUser"
  | "all"
  | {
      userId?: string;
      userIds?: string[];
    };

/**
 * App-message fan-out API available to server code.
 *
 * Message type names are app-defined and unprefixed. Sporades reserves and adds
 * its internal transport prefix. Client-origin messages always enter declared
 * server message handlers before any fan-out.
 */
export type MessageApi = {
  send(message: { type: string; data?: unknown; scope?: MessageScope }): number;
};

export type PrivilegedRunOptions = {
  /** Stable operation name emitted in Privileged audit events. */
  operation: string;
  /** Resource class touched by the privileged operation, such as `capsule-db` or `files`. */
  targetResourceKind?: string;
  /** Synchronous JSON-compatible metadata redacted before `started` audit emission. */
  metadata?: JsonObject;
  /** Optional caller-supplied cancellation signal propagated to the privileged callback. */
  signal?: AbortSignal;
};

export type PrivilegedFileError = {
  message: string;
  hint?: string;
};

export type PrivilegedResult<Data> =
  | {
      ok: true;
      data: Data;
      error: null;
    }
  | {
      ok: false;
      data?: null;
      error: PrivilegedFileError;
    };

export type PrivilegedFileMetadata = {
  id: string;
  name: string;
  type: string;
  size: number;
  path?: string;
  version?: string;
  url?: string;
  [key: string]: unknown;
};

export type PrivilegedOwnedFileMetadata = PrivilegedFileMetadata & {
  /** Runtime user ID that owns the File. Available only inside an active Privileged server callback. */
  ownerId: string;
};

export type PrivilegedPublicFileUrl = {
  id: string;
  fileId: string;
  url: string;
  expiresAt: string | null;
  revokedAt?: string | null;
  [key: string]: unknown;
};

/** Safe File metadata returned to Capsule server code. */
export type ServerFileMetadata = Readonly<{
  id: string;
  bucket: string;
  size: number;
  type: string;
  name: string;
  path: string;
  version: string;
}>;

/** User-scoped File operations available to trusted Capsule server code. */
export type CurrentUserFilesApi = {
  /** Delete a File owned by the current user or allowed by the Capsule's File delete ACL. */
  delete(fileReference: string): Promise<ServerFileMetadata>;
};

export type PrivilegedListedFileMetadata = PrivilegedOwnedFileMetadata & { createdAt: string; updatedAt: string };
export type PrivilegedFileListOptions = { createdBefore?: string | Date; cursor?: string | null };
export type PrivilegedFileListPage = { files: PrivilegedListedFileMetadata[]; cursor: string | null };
export type PrivilegedFileApi = {
  /** Up to 100 live uploaded Files, oldest first with ID tie-breaker. Cutoff is exclusive; cursor retains it. Only inside an active Privileged callback. */
  list(options?: PrivilegedFileListOptions): Promise<PrivilegedResult<PrivilegedFileListPage>>;
  /** Return a private runtime URL for one live Capsule File by id or absolute File path. */
  url(fileReference: string): Promise<PrivilegedResult<{ url: string; file: PrivilegedOwnedFileMetadata }>>;
  /** Create a public URL for one live Capsule File while preserving File runtime boundaries. */
  createPublicUrl(fileReference: string, options?: { expires?: string | Date; ttlSeconds?: number; noExpiry?: boolean }): Promise<PrivilegedResult<{ publicUrl: PrivilegedPublicFileUrl }>>;
  /** Delete one live Capsule File through the configured Capsule File storage adapter. */
  delete(fileReference: string): Promise<PrivilegedResult<{ file: PrivilegedFileMetadata }>>;
};

export type PrivilegedAuthContext = AuthContext & {
  userId: "__privileged__";
  displayName: "Privileged server role";
  email: null;
  picture: null;
  isAuthenticated: false;
  isGuest: false;
  provider: "privileged-server-role";
};

/**
 * Derived context passed only to a `ctx.privileged.run(...)` callback.
 *
 * It is a server-only, userless execution actor. It is not a Capsule role, app
 * admin, Sporades user, session, team member, service account, or browser
 * credential.
 * Arbitrary Capsule middleware fields are intentionally not inherited across
 * this boundary, including aliases and closures over lifecycle capabilities.
 */
export type PrivilegedContext<Schema extends SchemaDefinition = SchemaDefinition> = Omit<CapsuleContext<Schema>, "auth" | "credential" | "files" | "privileged" | "teams" | "accessKeys" | "serviceUsers" | "serverAuth" | "teamBilling" | "lifecycle"> & {
  auth: PrivilegedAuthContext;
  signal: AbortSignal;
  files: PrivilegedFileApi;
  jobs: JobApi;
  schedules: ScheduleInspectionApi;
  teams: PrivilegedTeamsApi;
  /** Bounded, read-only, provider-free inspection of Team Billing quarantine. */
  teamBilling: PrivilegedTeamBillingApi;
  /** Operator-only Access-key metadata and retirement. Never exposes issuance, rotation, or bearer secrets. */
  accessKeys: PrivilegedAccessKeysApi;
};

/**
 * Explicit server-only `ctx.privileged.run(...)` Privileged server role API.
 *
 * The runtime emits `started`, then `completed` or `errored`, then `finished`
 * Privileged audit events around each callback. Privilege is scoped to the
 * callback and becomes ineffective after the run finishes.
 */
export type PrivilegedApi<Schema extends SchemaDefinition = SchemaDefinition> = {
  run<Result>(
    options: PrivilegedRunOptions,
    callback: (ctx: PrivilegedContext<Schema>) => MaybePromise<Result>,
  ): Promise<Result>;
};

/** Exact declared app-table identity in the retained Capsule database. */
export type ResourceIdentity = Readonly<{ table: string; id: string }>;
export type ResourceRunOptions = Readonly<{ resource: ResourceIdentity; operationId: string; input: JsonValue }>;
export type ResourceStatusOptions = Readonly<{ resource: ResourceIdentity; operationId: string }>;
export type ResourceNotification = Readonly<{ id: string; to: readonly string[]; subject: string; text: string; html?: string }>;
export type ResourceNotificationRecipientStatus = Readonly<{
  recipient: string;
  state: "accepted" | "submitting" | "unknown" | "retry-wait" | "acknowledged" | "rejected";
  attemptCount: number;
  nextAttemptAt: string | null;
  lastOutcomeCategory: "acknowledged" | "rejected" | "unknown" | null;
}>;
export type ResourceNotificationIntentStatus = Readonly<{
  id: string;
  state: "pending" | "acknowledged" | "rejected";
  recipients: readonly ResourceNotificationRecipientStatus[];
}>;
export type ResourceScope<Schema extends SchemaDefinition = SchemaDefinition> = Readonly<{
  app: AppContext;
  db: DatabaseFromSchema<Schema>;
  jobs: Pick<JobApi, "enqueue">;
  log: Logger;
  signal: AbortSignal;
  /** Stages a durable notification in the owning resource transaction. No SMTP I/O occurs before commit. */
  notifications: { accept(input: ResourceNotification): Promise<{ id: string; state: "staged" }> };
}>;
export type ResourceStatus = { state: "absent" } | { state: "committed"; result: JsonValue; intentIds: string[]; intents?: ResourceNotificationIntentStatus[] };
/** Explicit v1 resource-scope support matrix. libSQL rejects before callback or status work. */
export type ResourceAdapterSupport = Readonly<{
  sqlite: "supported";
  postgres: "supported";
  libsql: "unsupported";
}>;
/** SQLite/PostgreSQL ordinary Jobs, Custom mutations, and Custom endpoints. libSQL is unsupported. */
export type ResourcesApi<Schema extends SchemaDefinition = SchemaDefinition> = Readonly<{
  run<Result extends JsonValue>(options: ResourceRunOptions, callback: (scope: ResourceScope<Schema>) => MaybePromise<Result>): Promise<Result>;
  status(options: ResourceStatusOptions): Promise<ResourceStatus>;
}>;

/** Trusted companion connections from the Capsule-owned Compose project; Dev uses loopback publication (including acknowledged bridge mode), Container uses managed service DNS, and acknowledged host mode uses the host port. Unsupported network modes fail before startup. Runtime env/port boundaries and credential custody are resolved during serialized service startup. Reset revokes generated credentials before state cleanup, including partial cleanup failures. Absent from ACL and browser contexts. */
export type CapsuleServices = Readonly<Record<string, Readonly<{ url: string; secrets: Readonly<Record<string, string>> }> | undefined>>;

/** Runtime-owned context passed to handlers, middleware and hooks. */
export type CapsuleContext<
  Schema extends SchemaDefinition = SchemaDefinition,
  Credential extends CredentialProvenance = CredentialProvenance,
> = {
  readonly app: AppContext;
  db: DatabaseFromSchema<Schema>;
  resources: ResourcesApi<Schema>;
  /** Shared across handlers; 10,000 LRU buckets, process-local, reset on restart; independent of transactions. */
  rateLimit(key: string, options: RateLimitOptions): RateLimitResult;
  auth: AuthContext;
  credential: Credential;
  readonly services: CapsuleServices;
  env: Record<string, string>;
  /** Normalized non-secret payment configuration. Secret values remain in `env` and are resolved only by the server integration. */
  payments: Readonly<{ stripe: Readonly<{ enabled: false }> | StripeEnabledPaymentsConfig }> | undefined;
  /** Cooperative cancellation is present for durable Job and Privileged execution. */
  signal?: AbortSignal;
  log: Logger;
  messages: MessageApi;
  /** User-scoped File operations using the current Auth and Credential context. */
  files: CurrentUserFilesApi;
  privileged: PrivilegedApi<Schema>;
  /** Server-only current-user durable Job Queue. */
  jobs: JobApi;
  /** Server-only SMTP delivery. Present even when mail is disabled. */
  mail: MailApi;
  /** Server-only OpenAI-compatible AI client. Present even when AI is dormant. */
  ai: AiApi;
  /** Server-only auth management (e.g. password reset). */
  serverAuth: ServerAuthApi;
  /** Runtime-owned current-user Teams with normal linked-user authorization. */
  teams: CurrentUserTeamsApi;
  /** Provider-free, transaction-bound Team Billing deletion admission. */
  teamBilling: CurrentUserTeamBillingApi;
  /** Runtime-owned Access keys issued and managed by the current linked Session owner. */
  accessKeys: CurrentUserAccessKeysApi;
  /** Transaction-composable lifecycle for non-human Users and their scoped credentials. Human Session only. */
  serviceUsers: ServiceUsersApi;
  /** Adopt reserved lifecycle work only after asynchronous app authorization and validation. */
  lifecycle: LifecycleContinuationApi;
};

/** Per-process fixed-window rate limit. Allowed calls return retryAfterMs: 0. */
export type RateLimitOptions = Readonly<{ limit: number; windowMs: number }>;
export type RateLimitResult = Readonly<{ ok: boolean; retryAfterMs: number }>;
/** Optional sporades.json auth.email.registration.throttle configuration; omission/false disables it. */
export type RegistrationThrottleConfig = false | { email?: RateLimitOptions; address?: RateLimitOptions };

/** Immutable exact bytes from one bounded Custom endpoint request-body read. */
export type EndpointBodyBytes = {
  readonly byteLength: number;
  readonly length: number;
  at(index: number): number | undefined;
  toUint8Array(): Uint8Array;
  [Symbol.iterator](): IterableIterator<number>;
};

/** Request details available only inside Custom endpoint handlers. */
export type EndpointRequest = {
  /** Canonical address authenticated by the Hosted proxy, otherwise undefined. */
  readonly clientAddress?: string;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
  readonly bodyBytes: EndpointBodyBytes;
  /** Completed, private ingress leases. Present only for an endpoint declaring multipart ingress. */
  readonly multipart?: { readonly files: readonly EndpointFileIngressLease[]; readonly fields: Readonly<Record<string, readonly string[]>> };
};

export type EndpointFileIngressLease = Readonly<{ leaseId: string; partId: string; fieldName: string; name: string; type: string; declaredSize: number | null; size: number; expiresAt: string }>;
/** Bounded audit evidence; it never contains bytes, storage paths, handles, or scanner topology. */
export type EndpointFileIngressInspection = Readonly<{ policyRevision: string; verdicts: readonly Readonly<{ inspector: string; outcome: "clean" | "rejected" | "inconclusive"; digest: string; size: number; version: string; engine: string; signatureVersion: string; inspectedAt: string }>[] }>;
export type EndpointFileMetadata = ServerFileMetadata;
export type FileIngressOptions = Readonly<{ path: string; name?: string; type?: string; authority?: { kind: "actor" } | ({ kind: "capsule-principal" } & FileIngressPrincipal) }>;
/** Exact immutable File identity accepted by endpoint attachment responses. */
export type EndpointFileAttachmentReference = Readonly<Pick<EndpointFileMetadata, "id" | "version">>;
/** A browser presentation name only; bytes, paths, streams, object keys, and credentials are never accepted. */
export type EndpointFileAttachmentOptions = Readonly<{ filename: string }>;
/** Runtime-created opaque endpoint result. It can only be returned from an endpoint handler. */
export type EndpointFileAttachmentResponse = object;
export type EndpointFileIngressApi = { claim(lease: EndpointFileIngressLease, options: FileIngressOptions): Promise<EndpointFileMetadata>; inspection(lease: EndpointFileIngressLease): Promise<EndpointFileIngressInspection | null>; status(requestKey: string, partKey: string): Promise<{ state: "missing" } | { state: "leased"; lease: EndpointFileIngressLease } | { state: "complete"; file: EndpointFileMetadata } | { state: "failed"; retryable: boolean }>; };
export type EndpointFileAttachmentApi = { attachment(file: EndpointFileAttachmentReference, options: EndpointFileAttachmentOptions): EndpointFileAttachmentResponse };

export type EndpointContext<
  Schema extends SchemaDefinition = SchemaDefinition,
  Credential extends CredentialProvenance = CredentialProvenance,
> = Omit<CapsuleContext<Schema, Credential>, "files" | "lifecycle"> & {
  request: EndpointRequest;
  /** Available only while handling a declared multipart ingress endpoint. */
  files: CurrentUserFilesApi & EndpointFileIngressApi;
  /** Present only after declared Capsule-principal pre-body admission. */
  readonly ingress?: Readonly<{ principal: FileIngressPrincipal }>;
};
export type EndpointFileAttachmentContext<Schema extends SchemaDefinition = SchemaDefinition> = Omit<EndpointContext<Schema>, "files"> & { files: CurrentUserFilesApi & EndpointFileIngressApi & EndpointFileAttachmentApi };

/** Provider-neutral lifecycle state reported by an outbound email provider. */
export type EmailEventKind =
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced"
  | "blocked"
  | "complained"
  | "unsubscribed"
  | "resubscribed"
  | "deferred";

/** One verified provider callback event. Raw provider JSON is never persisted by Sporades. */
export type VerifiedEmailEvent = {
  provider: string;
  kind: EmailEventKind;
  providerEventId: string;
  occurredAt: string;
  correlationId?: string;
  recipient?: string;
  raw: JsonValue;
};

/** Handler for a Capsule's single provider-neutral email-event subscription. */
export type EmailEventHandler<Schema extends SchemaDefinition = SchemaDefinition> = (
  ctx: PrivilegedContext<Schema>,
  event: VerifiedEmailEvent,
) => MaybePromise<void>;

/** Handler for a Capsule's single verified Stripe-event subscription. */
export type StripeEventHandler<Schema extends SchemaDefinition = SchemaDefinition> = (
  ctx: PrivilegedContext<Schema>,
  event: VerifiedStripeEvent,
) => MaybePromise<void>;

/** Narrow transaction-owned context for one atomic Stripe consequence. */
export type AtomicStripeConsequenceContext<Schema extends SchemaDefinition = SchemaDefinition> = Pick<
  PrivilegedContext<Schema>,
  "app" | "auth" | "signal" | "db" | "env" | "services" | "log" | "rateLimit"
> & {
  /** Jobs persist with the consequence and are dispatched only after commit. */
  jobs: Pick<JobApi, "enqueue">;
  /** Exact membership count and lifecycle serialization inside the consequence transaction. */
  teams: Pick<PrivilegedTeamsApi, "countMembers" | "lockLifecycle">;
};

/** Handler for one runtime-serialized, transaction-owned Stripe consequence. */
export type AtomicStripeEventHandler<Schema extends SchemaDefinition = SchemaDefinition> = (
  ctx: AtomicStripeConsequenceContext<Schema>,
  event: VerifiedStripeEvent,
) => MaybePromise<void>;

/** Handler for a named query exposed over the Sporades client transport. */
export type QueryHandler<
  Schema extends SchemaDefinition = SchemaDefinition,
  Args extends readonly JsonValue[] = readonly JsonValue[],
  Result = unknown,
> = (
  ctx: CapsuleContext<Schema>,
  ...args: Args
) => MaybePromise<Result>;

/** Handler for a named mutation exposed over the Sporades client transport. */
export type MutationHandler<
  Schema extends SchemaDefinition = SchemaDefinition,
  Args extends unknown[] = string[],
  Result = unknown,
> = (
  ctx: CapsuleContext<Schema>,
  ...args: Args
) => MaybePromise<Result>;

/**
 * Handler for a Custom endpoint.
 *
 * Use endpoints for integration paths such as webhooks. Queries and mutations
 * remain the primary Capsule data API.
 */
export type EndpointHandler<Schema extends SchemaDefinition = SchemaDefinition, Result = unknown> = (
  ctx: EndpointContext<Schema>,
) => MaybePromise<Result>;
export type EndpointFileAttachmentHandler<Schema extends SchemaDefinition = SchemaDefinition, Result = unknown> = (
  ctx: EndpointFileAttachmentContext<Schema>,
) => MaybePromise<Result>;

/** Public stateless handler context. General Capsule middleware is skipped. */
export type SessionlessEndpointContext = Readonly<{
  app: AppContext;
  readonly services: CapsuleServices;
  env: Readonly<Record<string, string>>;
  log: Logger;
  rateLimit(key: string, options: RateLimitOptions): RateLimitResult;
  signal?: AbortSignal;
  request: Omit<EndpointRequest, "multipart">;
}>;
/** An explicitly sessionless endpoint cannot carry a declarative Auth guard. */
export type SessionlessEndpointHandler<Result = unknown> = ((ctx: SessionlessEndpointContext) => MaybePromise<Result>) & { readonly [authGuardedHandlerBrand]?: never };
export type SessionlessEndpointOptions = {
  method: string;
  path: string;
  session: "none";
  body?: never;
  response?: never;
  mcp?: never;
};

/** Handler for a client-origin App message. */
export type MessageHandler<Schema extends SchemaDefinition = SchemaDefinition, Result = unknown> = (
  ctx: CapsuleContext<Schema>,
  data: unknown,
) => MaybePromise<Result>;

export type ContextKind = "query" | "mutation" | "endpoint" | "message";

/** Mutable context shape passed through middleware before the final handler runs. */
export type MiddlewareContext<Schema extends SchemaDefinition = SchemaDefinition> = CapsuleContext<Schema> &
  Partial<Pick<EndpointContext<Schema>, "request">> & {
    kind: ContextKind;
    [key: string]: unknown;
  };

export type ContextMiddleware<Schema extends SchemaDefinition = SchemaDefinition> = (
  ctx: MiddlewareContext<Schema>,
) => MaybePromise<MiddlewareContext<Schema> | void>;

/** Standard mutation result envelope used by runtime hooks. */
export type MutationResult<Result = unknown> = {
  ok: boolean;
  data?: Result | null;
  error?: { message: string; hint?: string } | null;
};

export type MutationHookEvent<Schema extends SchemaDefinition = SchemaDefinition, Result = unknown> = {
  name: string;
  args: unknown[];
  ctx: MiddlewareContext<Schema>;
  result?: MutationResult<Result>;
};

export type MutationHook<Schema extends SchemaDefinition = SchemaDefinition, Result = unknown> = (
  event: MutationHookEvent<Schema, Result>,
) => MaybePromise<void>;

/** Capsule lifecycle hooks around named mutations. */
export type CapsuleHooks<Schema extends SchemaDefinition = SchemaDefinition> = {
  init?: (ctx: Omit<CapsuleContext<Schema>, "credential" | "files">) => MaybePromise<void>;
  shutdown?: (ctx: Omit<CapsuleContext<Schema>, "credential" | "files">) => MaybePromise<void>;
  beforeMutation?: MutationHook<Schema>[];
  afterMutation?: MutationHook<Schema>[];
};

export type QueryDefinition<Handler = QueryHandler> = {
  kind: "query";
  handler: Handler;
};

export type MutationDefinition<Handler = MutationHandler> = {
  kind: "mutation";
  handler: Handler;
};

/** HTTP method/path options for a Custom endpoint. */
export type EndpointOptions<Schema extends SchemaDefinition = SchemaDefinition> = {
  method: string;
  path: string;
  session?: never;
  response?: { fileAttachment: true };
  body?: { multipart: EndpointMultipartIngressOptions<Schema> };
  /**
   * Expose this JSON endpoint as a tool on the key-guarded `/__sporades/mcp` bridge (ADR-0059).
   * Omitted means not exposed. The bridged request carries no caller credential, so the
   * handler applies its own authorization. Multipart and File attachment endpoints cannot opt in.
   */
  mcp?: true | { description?: string };
};
/** Endpoint declaration that permits an opaque File attachment response. */
export type EndpointFileAttachmentOptionsDeclaration<Schema extends SchemaDefinition = SchemaDefinition> = EndpointOptions<Schema> & { response: { fileAttachment: true } };

export type EndpointDefinition<Handler = EndpointHandler, Schema extends SchemaDefinition = SchemaDefinition> = {
  kind: "endpoint";
  options: EndpointOptions<Schema> | SessionlessEndpointOptions;
  handler: Handler;
};

export type EmailEventDefinition<Handler = EmailEventHandler> = {
  kind: "emailEvent";
  handler: Handler;
};

export type StripeEventDefinition<Handler = StripeEventHandler> = {
  kind: "stripeEvent";
  options?: undefined;
  handler: Handler;
};

export type AtomicStripeEventDefinition<Handler = AtomicStripeEventHandler> = {
  kind: "stripeEvent";
  options: Readonly<{ consequence: "atomic" }>;
  handler: Handler;
};

export type MessageDefinition<Handler = MessageHandler> = {
  kind: "message";
  handler: Handler;
};

/** Runtime-owned Job lifecycle state. Only `queued` is ready to run. */
export type JobStatus = "queued" | "delayed" | "running" | "succeeded" | "failed" | "cancelled";
/** Bounded server-only Job state returned from actor-scoped inspection. */
export type JobSummary = { id: string; handler: string; status: JobStatus; attempts: number };
/** Server-only state for a known Job, including provenance and execution actor. */
export type JobState = JobSummary & {
  enqueuedBy: { mode: "user"; userId: string; credential: CredentialProvenance } | { mode: "schedule"; scheduleName: string; scheduledFor: string };
  actor: { mode: "current-user"; userId: string } | { mode: "privileged-server-role" };
  result?: JsonValue;
  failure?: { code: string; message: string };
  attemptHistory?: Array<{ attempt: number; startedAt: string; outcome: string; completedAt: string; code?: string }>;
};
/**
 * Server-only runtime-owned Job Queue API.
 *
 * Current-user access is scoped to the captured execution actor. Privileged
 * access may inspect all Jobs when used explicitly through `ctx.privileged`.
 */
export type JobApi = {
  /** Availability and retry instants, including runtime claim leases, must remain within canonical four-digit UTC timestamps. Retry accepts only `maxAttempts` and optional `delayMs`. */
  enqueue(handler: string, payload: JsonValue, options?: { idempotencyKey?: string; availableAt?: string | Date; retry?: { maxAttempts: number; delayMs?: number } }): Promise<JobState>;
  cancel(id: string): Promise<JobState | null>;
  get(id: string): Promise<JobState | null>;
  list(options?: { limit?: number; cursor?: string }): Promise<{ jobs: JobSummary[]; nextCursor: string | null }>;
};
export type JobHandlerContext<Schema extends SchemaDefinition = SchemaDefinition> = CapsuleContext<Schema> | PrivilegedContext<Schema>;
export type JobDefinition<Handler = (ctx: JobHandlerContext, payload: JsonValue) => MaybePromise<JsonValue>> = { kind: "job"; handler: Handler };
export type ScheduleLatestOccurrence =
  | { scheduledFor: string; outcome: "enqueued"; jobId: string }
  | { scheduledFor: string; outcome: "payload-failed"; errorCode: string };
/** Bounded Privileged view of one currently declared Schedule. */
export type ScheduleSummary = {
  name: string;
  expression: string;
  timezone: string;
  missedRun: "skip" | "latest";
  enabled: boolean;
  nextOccurrence: string | null;
  latestOccurrence: ScheduleLatestOccurrence | null;
};
/** Server-only inspection available solely inside an active Privileged callback. */
export type ScheduleInspectionApi = {
  get(name: string): Promise<ScheduleSummary | null>;
  list(): Promise<ScheduleSummary[]>;
};
export type ScheduleOccurrence = Readonly<{ scheduleName: string; scheduledFor: string }>;
export type ScheduleContext<Schema extends SchemaDefinition = SchemaDefinition> = Readonly<{ app: AppContext; signal: AbortSignal; privileged: PrivilegedApi<Schema> }>;
/**
 * Calculates ordinary Job input for one occurrence. Factories are for dynamic
 * data population, may run more than once during recovery, and should avoid
 * state mutation. Explicit Privileged side effects must tolerate repetition.
 * Timeout cancellation is cooperative and cannot undo completed side effects.
 */
export type SchedulePayloadFactory<Schema extends SchemaDefinition = SchemaDefinition> = (occurrence: ScheduleOccurrence, ctx: ScheduleContext<Schema>) => MaybePromise<JsonValue>;
/**
 * A server-only recurring Job declaration using numeric five-field cron.
 * Payloads must be JSON-safe; retry is the ordinary Job Queue retry policy.
 */
export type ScheduleDefinition = {
  kind?: "schedule";
  expression: string;
  timezone?: string;
  job: string;
  retry?: { maxAttempts: number; delayMs?: number };
  enabled?: boolean;
  missedRun?: "skip" | "latest";
} & (
  | { payload?: JsonValue; payloadVersion?: never }
  | {
    payload: SchedulePayloadFactory;
    /** Stable identity for the factory source and every captured/configured input. Change it when any of those inputs change. */
    payloadVersion?: string;
  }
);

/**
 * Top-level Capsule definition passed to `capsule()`.
 *
 * The Capsule is the deployable unit: schema, server handlers, middleware, and
 * hooks bundled with the client, config, and runtime data boundary.
 * Optional project `public/` regular files join the normalized release tree for
 * esbuild and Vite, preserving paths and bytes as unauthenticated assets. XML
 * uses application/xml; charset=utf-8. Dev observes public changes; failed
 * candidates retain the last successful tree and rollback restores release bytes.
 * Scaffold HTML declares an empty data-URL favicon; replace its icon href with
 * /favicon.ico and add public/favicon.ico to supply a custom icon.
 * Public paths cannot collide with generated output or reserved __sporades routes,
 * including conservative case and Unicode aliases such as client.jſ/client.js.
 * The generated server serves Vite-style content-hashed `/assets/` files with
 * one-year public immutable caching; HTML is no-store and other public assets
 * require revalidation. See the Building the Client guide for the naming contract.
 */
export type CapsuleDefinition<Schema extends SchemaDefinition = SchemaDefinition> = {
  name: string;
  auth?: { registration?: RegistrationAdmission<Schema>; reauthentication?: { purposes: Record<string, { maxAgeSeconds: number }>; authorize?: (ctx: { readonly app: AppContext; db: ReadOnlyDatabaseFromSchema<Schema>; auth: AuthContext }, purpose: string) => MaybePromise<boolean> } };
  accessKeys?: { scopes: readonly string[] };
  schema?: Schema;
  queries?: Record<string, QueryDefinition<QueryHandler<Schema, any> | AuthGuardedHandler<(...args: any[]) => any>>>;
  mutations?: Record<string, MutationDefinition<MutationHandler<Schema, any[]> | AuthGuardedHandler<(...args: any[]) => any>>>;
  endpoints?: Record<string, EndpointDefinition<SessionlessEndpointHandler | EndpointHandler<Schema> | EndpointFileAttachmentHandler<Schema> | AuthGuardedHandler<(...args: any[]) => any>, Schema>>;
  emailEvents?: EmailEventDefinition<EmailEventHandler<Schema>>;
  stripeEvents?: StripeEventDefinition<StripeEventHandler<Schema>> | AtomicStripeEventDefinition<AtomicStripeEventHandler<Schema>>;
  messages?: Record<string, MessageDefinition<MessageHandler<Schema> | AuthGuardedHandler<(...args: any[]) => any>>>;
  jobs?: Record<string, JobDefinition<any>>;
  schedules?: Record<string, ScheduleDefinition>;
  /** Up to 32 Capsule-specific membership roles. Each must match `^[a-z][a-z0-9-]{0,31}$` (maximum 32 characters); `admin`, `member`, and `sporades-*` remain runtime-reserved. */
  teams?: {
    appRoles?: readonly string[];
    /** Opt-in atomic admission for additional-Team creation through SDK and ctx.teams. Omission preserves behavior; invalid declaration rejects startup. Explicit valid allow required; failures return opaque TEAM_POLICY_DENIED and poison the outer transaction even when caught. Initial personal-Team bootstrap bypasses this hook. */
    admitCreate?(ctx: TeamCreateAdmissionContext<Schema>, input: TeamCreateAdmissionInput): MaybePromise<TeamCreateAdmissionDecision>;
    /** Trusted admission policy invoked after Join-link validation and before a new membership is inserted in the same transaction. */
    admitJoin?(ctx: TeamJoinAdmissionContext<Schema>, input: TeamJoinAdmissionInput): MaybePromise<TeamJoinAdmissionDecision>;
    /** Opt-in atomic policy for every SDK and ctx.teams destructive path. Omission preserves 0.9.x behavior; invalid declaration rejects startup. Explicit valid allow required; failures are opaque TEAM_POLICY_DENIED and roll back app/runtime writes even when caught. All Capsule responsibility writers must take teams.lockLifecycle in the same transaction before reads/writes. */
    authorizeDestructive?(ctx: TeamDestructivePolicyContext<Schema>, input: TeamDestructivePolicyInput): MaybePromise<TeamDestructivePolicyDecision>;
  };
  /** Optional headless Team Billing control plane. Omission leaves billing dormant and creates no billing storage. */
  teamBilling?: TeamBillingDefinition<Schema>;
  /** Optional File ACL rules for deliberate non-owner access to normal File operations. File ownership and public-URL revocation remain with the File owner. */
  files?: CapsuleFilesDefinition<Schema>;
  /** Enable the client-only Journey tracker and define its TTL and automatic-capture ceiling. */
  journey?: { enabled: true; ttlSeconds?: number; capture?: { navigation?: boolean; focus?: boolean; interactions?: boolean } };
  /** Opt out of the implicit add/update table mutation entries that answer undeclared mutation names. Omission or `true` keeps the 0.9.x compatibility surface; `false` answers the ordinary unknown-mutation refusal for every name without a declared mutation, before any fallback write, mutation hook, or success effect. Declared mutations, server `ctx.db`, implicit table queries, table ACLs, and before/after mutation hooks keep their behavior; place business checks in declared mutations, table ACL rules, or a before-mutation hook. Not a substitute for declaring the check itself. Present values must be booleans and are rejected at authoring and startup otherwise. */
  implicitMutations?: boolean;
  middleware?: ContextMiddleware<Schema>[];
  hooks?: CapsuleHooks<Schema>;
};
export type RegistrationEvidence = Readonly<{ userId: string; provider: string; email: string | null; displayName: string; picture: string | null; kind: "email" | "oauth" | "local" }>;
export type RegistrationAdmission<Schema extends SchemaDefinition> = {
  admit(ctx: { readonly app: AppContext; db: ReadOnlyDatabaseFromSchema<Schema>; evidence: RegistrationEvidence; admission: unknown }): MaybePromise<{ allow: false } | { allow: true; state?: unknown }>;
  finalize(ctx: { readonly app: AppContext; db: DatabaseFromSchema<Schema>; evidence: RegistrationEvidence }, input: RegistrationEvidence & { state?: unknown }): MaybePromise<void>;
};

export type Capsule<Definition extends object = CapsuleDefinition> = Definition & {
  kind: "capsule";
};

/**
 * Register a Capsule with the Sporades server runtime.
 *
 * Call this once from the server entrypoint and export the result as default.
 * Sporades uses the definition to create tables, run additive schema
 * migrations, wire auth, register queries/mutations/endpoints/messages, and
 * start the runtime context.
 */
export function capsule<const Schema extends SchemaDefinition, const Definition extends CapsuleDefinition<NoInfer<Schema>>>(
  definition: Definition & { schema: Schema },
): Capsule<Definition>;
export function capsule<const Schema extends SchemaDefinition, const Definition extends CapsuleDefinition<Schema>>(
  definition: Definition & { schema?: Schema },
): Capsule<Definition>;

/** Synchronously require an authenticated user from an already-admitted context. */
export function requireUserAuth(ctx: { auth: AuthContext }, options?: RequireAuthOptions): AuthContext;
/** @deprecated Use requireUserAuth for the synchronous inline Session check. */
export function requireAuth(ctx: { auth: AuthContext }, options?: RequireAuthOptions): AuthContext;
export type DeclarativeRequireAuthOptions = {
  linked?: boolean;
  credentials?: readonly CredentialKind[];
  scopes?: readonly string[];
  /** Consume one current runtime-owned proof for this declared purpose in the mutation transaction. */
  reauthentication?: string;
};
/** @internal */
declare const authGuardedHandlerBrand: unique symbol;
/** Type-preserving result of a declarative Auth guard. Runtime admission metadata is private. */
export type AuthGuardedHandler<Handler extends (...args: any[]) => any> = Handler & {
  readonly [authGuardedHandlerBrand]: true;
};
/** Declaratively require an admitted credential before middleware and handler execution. */
export function requireAuth<Handler extends (...args: any[]) => any>(handler: Handler): AuthGuardedHandler<Handler>;
/** A single literal credential kind narrows ctx.credential in the guarded handler. */
export function requireAuth<
  const Kind extends CredentialKind,
  Handler extends (...args: any[]) => any,
>(
  options: DeclarativeRequireAuthOptions & { credentials: readonly [Kind] },
  handler: Handler extends (ctx: infer Context, ...args: infer Args) => infer Result
    ? (ctx: Omit<Context, "credential"> & {
        credential: Kind extends "session" ? SessionCredentialProvenance : AccessKeyCredentialProvenance;
      }, ...args: Args) => Result
    : never,
): AuthGuardedHandler<
  Handler extends (ctx: infer Context, ...args: infer Args) => infer Result
    ? (ctx: Omit<Context, "credential"> & {
        credential: Kind extends "session" ? SessionCredentialProvenance : AccessKeyCredentialProvenance;
      }, ...args: Args) => Result
    : never
>;
export function requireAuth<Handler extends (...args: any[]) => any>(
  options: DeclarativeRequireAuthOptions,
  handler: Handler,
): AuthGuardedHandler<Handler>;
/** Define a Custom endpoint for HTTP integrations such as webhooks. */
export function endpoint(options: SessionlessEndpointOptions, handler: SessionlessEndpointHandler): EndpointDefinition<SessionlessEndpointHandler>;
export function endpoint<Schema extends SchemaDefinition = SchemaDefinition>(options: EndpointFileAttachmentOptionsDeclaration<Schema>, handler: EndpointFileAttachmentHandler<Schema>): EndpointDefinition<EndpointFileAttachmentHandler<Schema>, Schema>;
export function endpoint<Schema extends SchemaDefinition = SchemaDefinition>(options: EndpointOptions<Schema>, handler: EndpointHandler<Schema>): EndpointDefinition<EndpointHandler<Schema>, Schema>;
export function endpoint<Schema extends SchemaDefinition = SchemaDefinition, Handler extends (...args: any[]) => any = (...args: any[]) => any>(options: EndpointOptions<Schema>, handler: AuthGuardedHandler<Handler>): EndpointDefinition<AuthGuardedHandler<Handler>, Schema>;
/** Schema-bound endpoint declaration helper for callbacks that read the Capsule database before request-body handling. */
export type EndpointBuilder<Schema extends SchemaDefinition> = {
  (options: SessionlessEndpointOptions, handler: SessionlessEndpointHandler): EndpointDefinition<SessionlessEndpointHandler, Schema>;
  (options: EndpointFileAttachmentOptionsDeclaration<Schema>, handler: EndpointFileAttachmentHandler<Schema>): EndpointDefinition<EndpointFileAttachmentHandler<Schema>, Schema>;
  (options: EndpointOptions<Schema>, handler: EndpointHandler<Schema>): EndpointDefinition<EndpointHandler<Schema>, Schema>;
  <Handler extends (...args: any[]) => any>(options: EndpointOptions<Schema>, handler: AuthGuardedHandler<Handler>): EndpointDefinition<AuthGuardedHandler<Handler>, Schema>;
};
/** Bind a declared Capsule schema once when endpoint admission needs schema-aware read-only database typing. */
export function endpointFor<Schema extends SchemaDefinition>(schema: Schema): EndpointBuilder<Schema>;

/** Declare the single provider-neutral email-event subscription for a Capsule. */
export function emailEvent<Handler extends EmailEventHandler>(handler: Handler): EmailEventDefinition<Handler>;
/** Declare the single verified Stripe-event subscription for a Capsule. A declared Team Billing platform consequence commits before this compatible legacy handler runs. */
export function stripeEvent<Handler extends StripeEventHandler>(handler: Handler): StripeEventDefinition<Handler>;
/** Opt into one runtime-serialized, transaction-owned Stripe consequence per Job attempt, shared with any declared Team Billing platform consequence for the verified Event. */
export function stripeEvent<Handler extends AtomicStripeEventHandler>(options: { consequence: "atomic" }, handler: Handler): AtomicStripeEventDefinition<Handler>;
/**
 * Define a named query for subscribed client reads. SQLite, Postgres and libsql refresh
 * subscriptions when a table read by their last run changes. Unknown tables retain a
 * full refresh; values derived from clocks or external state do not refresh on unrelated writes.
 * Only recognized single-table writes may skip refresh when they report zero changed rows;
 * batches and unknown statements retain full refresh even with a zero-row final result.
 * Rejected Postgres and libsql prepared writes retain conservative refresh when writes may have committed,
 * including errors after a batch COMMIT or a lost remote acknowledgement.
 * Dedicated Postgres resource writes publish invalidation after
 * transaction settlement, even if another refresh ran before commit.
 */
export function query<const Args extends readonly JsonValue[] = readonly JsonValue[], Result = unknown>(
  handler: (ctx: CapsuleContext, ...args: Args) => MaybePromise<Result>,
): QueryDefinition<(ctx: CapsuleContext, ...args: Args) => MaybePromise<Result>>;
export function query<Handler extends (...args: any[]) => any>(handler: AuthGuardedHandler<Handler>): QueryDefinition<AuthGuardedHandler<Handler>>;
/** Define a named mutation for client-initiated writes or commands. */
export function mutation<const Args extends unknown[] = string[], Result = unknown>(
  handler: (ctx: CapsuleContext, ...args: Args) => MaybePromise<Result>,
): MutationDefinition<(ctx: CapsuleContext, ...args: Args) => MaybePromise<Result>>;
export function mutation<Handler extends (...args: any[]) => any>(handler: AuthGuardedHandler<Handler>): MutationDefinition<AuthGuardedHandler<Handler>>;
/** Define a server-mediated App message handler. */
export function message(handler: MessageHandler): MessageDefinition<MessageHandler>;
export function message<Handler extends (...args: any[]) => any>(handler: AuthGuardedHandler<Handler>): MessageDefinition<AuthGuardedHandler<Handler>>;
/**
 * Declare a named server-only Job handler in `capsule({ jobs })` for durable work.
 * Enabled operator telemetry automatically traces each attempt with a causal
 * enqueue link and independent queue metrics; no tracing API is required.
 * Monitoring failures do not block Job work. Telemetry queues/exports are
 * bounded and best effort; durable Jobs retain their existing retry semantics.
 */
export function job<Payload extends JsonValue, Result extends JsonValue>(
  handler: (ctx: JobHandlerContext, payload: Payload) => MaybePromise<Result>,
): JobDefinition<(ctx: JobHandlerContext, payload: Payload) => MaybePromise<Result>>;
/**
 * Declare a named server-only recurring Privileged Job in
 * `capsule({ schedules })`. The map key is its durable identity. Expressions use
 * numeric five-field cron; `missedRun` defaults to `skip` and `latest` catches
 * up at most one occurrence. Dynamic payload factories may supply a stable
 * `payloadVersion` that changes with their code or captured configuration;
 * omission preserves the weaker v0.8.5 source-text identity.
 * Scheduled Jobs retain Job Queue at-least-once attempt semantics.
 */
export function schedule<const Definition extends ScheduleDefinition>(definition: Definition): Definition & { kind: "schedule" };
/** Define a Capsule table from field builders. */
export function table<const Fields extends Record<string, AnyFieldDefinition>>(fields: Fields): CapsuleTableDefinition<Fields>;

/** Text field stored as SQLite `TEXT` and exposed as a JavaScript string. */
export function String(): FieldBuilder<string>;
/** Boolean field stored by Sporades and exposed as `true`/`false`. */
export function Boolean(): FieldBuilder<boolean>;
/** Numeric field exposed as a JavaScript number. */
export function Number(): FieldBuilder<number>;
/** Date/timestamp field exposed as an ISO string; runtime writes also accept `Date` values. */
export function Date(): FieldBuilder<string | globalThis.Date | null>;
/** JSON-compatible structured field. */
export function Json<Value extends JsonValue = JsonValue>(): FieldBuilder<Value>;
/** Reference field storing the row id of another table. */
export function Reference(targetTable: string): ReferenceFieldBuilder;

/**
 * Explicit private-File Bearer admission; omitted read scopes leave policy to ownership and File ACL rules.
 * Enabled HTTP telemetry times existing credential/admission and File operations with bounded names
 * and outcomes only. Credentials, grants, actor identifiers and File metadata are never child-span attributes.
 */
export type CapsuleFileAccessKeyPolicy = { read: { scopes?: readonly string[] } };

/** Deployer-owned v1 request-admission JSON; HTTP and WebSocket upgrades (including /__sporades/ws)
 * share complete generations, canonical conditions, trusted Hosted identity and per-process quotas before Capsule code or protocol switching.
 * Client resets during opaque 403/429 upgrade denials close only the affected connection. */
export type { AdmissionPolicy, AdmissionCondition, AdmissionAction, AdmissionGeneration, AdmissionHealth, AdmissionEvidence, AdmissionPolicyConfig } from "./admission-policy.js";

/** HTTP security section of sporades.json. All hardening additions are opt-in in 0.9.x. */
export type SecurityConfig = {
  cors?: { allowedOrigins?: string[] };
  csp?: {
    mode?: "report-only" | "enforce";
    directives?: Record<string, string | string[]>;
    /** Fresh per-response nonce. Put nonce="%SPORADES_NONCE%" on trusted authored scripts. Inline event handlers cannot use nonces. */
    nonce?: boolean;
    /** Browser report-uri destination: same-origin absolute path or credential-free HTTPS URL, or `"observability"` to
     * forward bounded, redacted violations through the configured `observability.errors` sink (required for that value). */
    reportTo?: "observability" | (string & {});
  };
  /** Hosted Capsules only. maxAgeSeconds is a non-negative safe integer; zero clears HSTS. */
  hsts?: { maxAgeSeconds: number; includeSubDomains?: boolean; preload?: boolean };
};
export type { ObservabilityConfig, AnalyticsConfig } from "./observability.js";
/** Opt-in sporades.json Server env requirements. Explicit keys plus configured SMTP, webhook and enabled Stripe keys are checked. Omit to preserve existing doctor/push behavior; failClosed defaults to false. */
export type ServerEnvConfig = Readonly<{ required?: readonly string[]; failClosed?: boolean }>;
