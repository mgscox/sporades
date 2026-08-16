export type FieldKind = "String" | "Boolean" | "Number" | "Date" | "Json" | "Reference";

/** JSON-compatible values accepted by Sporades `Json()` fields and preferences APIs. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type MaybePromise<Value> = Value | Promise<Value>;

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

export type AclDatabaseHelpers = {
  get(tableName: string, id: string): Record<string, unknown> | null;
  exists(tableName: string, id: string): boolean;
};

export type AclStorageHelpers = {
  get(resourceName: "files", reference: string): AclStorageFileMetadata | null;
  exists(resourceName: "files", reference: string): boolean;
};

/** Read-only Team decisions available while evaluating table and File ACL rules. */
export type AclTeamHelpers = {
  /** True when the current linked actor belongs to the explicitly identified Team. */
  isMember(teamId: string): boolean;
  /** True when the current linked actor is an admin of the explicitly identified Team. */
  isAdmin(teamId: string): boolean;
  /** True when the current linked actor holds this currently declared application role in the explicitly identified Team. */
  hasRole(teamId: string, role: string): boolean;
  /** True when the current linked actor holds any role in this non-empty, bounded (32 maximum) declared-role set for the explicitly identified Team. */
  hasAnyRole(teamId: string, roles: readonly string[]): boolean;
};

export type AclHelpers = {
  db: AclDatabaseHelpers;
  storage: AclStorageHelpers;
  teams: AclTeamHelpers;
};

/** Runtime context available while evaluating table ACL rules. */
export type TableAclContext = {
  auth: AuthContext;
  acl: AclHelpers;
  [key: string]: unknown;
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
  auth: AuthContext;
  acl: AclHelpers;
};

/** Stable File metadata supplied to a File ACL rule; it never includes bytes or storage credentials. */
export type FileAclRuleInput = {
  ctx: FileAclContext;
  operation: FileAclOperation;
  file: AclStorageFileMetadata;
};

export type FileAclRule = (input: FileAclRuleInput) => MaybePromise<boolean>;

/**
 * Optional rules that extend normal File ownership with explicit Capsule ACL.
 * Owner access and public-URL revocation remain with the File owner; absent
 * rules never widen File access.
 */
export type FileAclRules = Partial<Record<FileAclOperation, FileAclRule>>;

export type CapsuleFilesDefinition = {
  acl?: FileAclRules;
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
  unique(...fields: string[]): TableDefinition<Fields>;
};

export type CapsuleTableDefinition<Fields extends Record<string, AnyFieldDefinition>> = Omit<TableDefinition<Fields>, "acl" | "unique"> & {
  acl(rules: TableAclRules<RowFromFields<Fields>>): CapsuleTableDefinition<Fields>;
  unique(...fields: [keyof Fields & string, ...(keyof Fields & string)[]]): CapsuleTableDefinition<Fields>;
};

export type SchemaDefinition = Record<string, TableDefinition>;

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
 * Query builders are immutable from an app-author point of view: chain
 * `where`, `orderBy`, and `limit`, then finish with `get()` or `all()`.
 * Inserts and updates return rows including Sporades-managed auto fields.
 */
export type TableApi<Row extends Record<string, unknown> = Record<string, unknown>> = {
  insert(values: InsertValues<Row>): Row;
  update(id: string, values: UpdateValues<Row>): Row | null;
  delete(id: string): boolean;
  where<FieldName extends keyof Row & string>(fieldName: FieldName, value: Row[FieldName]): TableApi<Row>;
  orderBy(fieldName: keyof Row & string, direction?: OrderDirection): TableApi<Row>;
  limit(count: number): TableApi<Row>;
  get(): Row | null;
  all(): Row[];
};

export type DatabaseFromSchema<Schema extends SchemaDefinition> = {
  [TableName in keyof Schema]: Schema[TableName] extends TableDefinition<infer Fields> ? TableApi<RowFromFields<Fields>> : TableApi;
};

export type ReadOnlyTableApi<Row extends Record<string, unknown> = Record<string, unknown>> = {
  where<FieldName extends keyof Row & string>(fieldName: FieldName, value: Row[FieldName]): ReadOnlyTableApi<Row>;
  orderBy(fieldName: keyof Row & string, direction?: OrderDirection): ReadOnlyTableApi<Row>;
  limit(count: number): ReadOnlyTableApi<Row>;
  get(): Row | null;
  all(): Row[];
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
  userId: string;
  displayName: string;
  email: string | null;
  picture: string | null;
  isAuthenticated: boolean;
  isGuest: boolean;
  provider: string;
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
  htmlBody?: string;
  provider?: JsonObject;
};

/** Stable SMTP delivery result. */
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
  send(message: MailSendInput): Promise<MailSendResult>;
};

/**
 * Server-only auth management API.
 *
 * Available to trusted Capsule handlers. Lets server code update email
 * credentials (e.g. for password reset flows) without direct access to the
 * internal auth database.
 */
export type ServerAuthApi = {
  /** Update the password for an existing email credential. Throws if the email is not registered. */
  setEmailPassword(email: string, newPassword: string): Promise<void>;
  /**
   * Issue a Reset code and deliver it over the runtime SMTP transport.
   *
   * Resolves identically whether or not the email is registered, so it cannot
   * be used to enumerate accounts. Throws only when mail is not configured or
   * email auth is disabled.
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
   * Spend a Reset code and set the new password. Revokes every Session for that
   * user and does not create a new one.
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
export type TeamJoinLinkInspection = { team: { id: string; name: string } | null; expiresAt: string | null; usable: boolean };
/** Safe post-auth Join-link check. It never consumes, reserves, or explains a capability. */
export type TeamJoinLinkValidation = { valid: boolean };
/** Atomic membership-scoped application-role reconciliation. Management role is never included. */
export type TeamApplicationRoleChanges = { add: string[]; remove: string[] };
export type TeamJoinAdmissionInput = { teamId: string; userId: string; currentMemberCount: number };
export type TeamJoinAdmissionDecision = { allow: boolean };
export type TeamJoinAdmissionContext<Schema extends SchemaDefinition = SchemaDefinition> = Pick<CapsuleContext<Schema>, "auth" | "env" | "log"> & {
  /** Transaction-bound application reads. Admission policies cannot mutate app state. */
  db: ReadOnlyDatabaseFromSchema<Schema>;
};
export type CurrentUserTeamsApi = {
  list(): Promise<{ teams: TeamSummary[] }>;
  /** Creates a named Team and makes the current linked user its first admin. Linked users may belong to at most 25 Teams. */
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

/** Copy overrides for the built-in password reset message. */
export type PasswordResetMailOptions = {
  subject?: string;
  textBody?: string;
  htmlBody?: string;
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

export type PrivilegedFileApi = {
  /** Return a private runtime URL for one live Capsule File by id or absolute File path. */
  url(fileReference: string): Promise<PrivilegedResult<{ url: string; file: PrivilegedOwnedFileMetadata }>>;
  /** Create a public URL for one live Capsule File while preserving File runtime boundaries. */
  createPublicUrl(fileReference: string, options?: { expires?: string | Date; ttlSeconds?: number; noExpiry?: boolean }): Promise<PrivilegedResult<{ publicUrl: PrivilegedPublicFileUrl }>>;
  /** Delete one live Capsule File through the configured Capsule File storage adapter. */
  delete(fileReference: string): Promise<PrivilegedResult<PrivilegedFileMetadata>>;
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
 */
export type PrivilegedContext<Schema extends SchemaDefinition = SchemaDefinition> = Omit<CapsuleContext<Schema>, "auth" | "privileged" | "teams"> & {
  auth: PrivilegedAuthContext;
  signal: AbortSignal;
  files: PrivilegedFileApi;
  jobs: JobApi;
  schedules: ScheduleInspectionApi;
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

/**
 * Runtime-owned context passed to queries, mutations, endpoints, messages,
 * middleware, and hooks.
 */
export type CapsuleContext<Schema extends SchemaDefinition = SchemaDefinition> = {
  db: DatabaseFromSchema<Schema>;
  auth: AuthContext;
  env: Record<string, string>;
  log: Logger;
  messages: MessageApi;
  privileged: PrivilegedApi<Schema>;
  /** Server-only current-user durable Job Queue. */
  jobs: JobApi;
  /** Server-only SMTP delivery. Present even when mail is disabled. */
  mail: MailApi;
  /** Server-only auth management (e.g. password reset). */
  serverAuth: ServerAuthApi;
  /** Runtime-owned current-user Teams with normal linked-user authorization. */
  teams: CurrentUserTeamsApi;
};

/** Request details available only inside Custom endpoint handlers. */
export type EndpointRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
};

export type EndpointContext<Schema extends SchemaDefinition = SchemaDefinition> = CapsuleContext<Schema> & {
  request: EndpointRequest;
};

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
  init?: (ctx: CapsuleContext<Schema>) => MaybePromise<void>;
  shutdown?: (ctx: CapsuleContext<Schema>) => MaybePromise<void>;
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
export type EndpointOptions = {
  method: string;
  path: string;
};

export type EndpointDefinition<Handler = EndpointHandler> = {
  kind: "endpoint";
  options: EndpointOptions;
  handler: Handler;
};

export type EmailEventDefinition<Handler = EmailEventHandler> = {
  kind: "emailEvent";
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
  enqueuedBy: { mode: "user"; userId: string } | { mode: "schedule"; scheduleName: string; scheduledFor: string };
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
  enqueue(handler: string, payload: JsonValue, options?: { idempotencyKey?: string; availableAt?: string | Date; retry?: { maxAttempts: number; delayMs?: number } }): Promise<JobState>;
  cancel(id: string): Promise<JobState | null>;
  get(id: string): Promise<JobState | null>;
  list(options?: { limit?: number; cursor?: string }): Promise<{ jobs: JobSummary[]; nextCursor: string | null }>;
};
export type JobDefinition<Handler = (ctx: CapsuleContext, payload: JsonValue) => MaybePromise<JsonValue>> = { kind: "job"; handler: Handler };
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
export type ScheduleContext<Schema extends SchemaDefinition = SchemaDefinition> = Readonly<{ signal: AbortSignal; privileged: PrivilegedApi<Schema> }>;
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
  payload?: JsonValue | SchedulePayloadFactory;
  retry?: { maxAttempts: number; delayMs?: number };
  enabled?: boolean;
  missedRun?: "skip" | "latest";
};

/**
 * Top-level Capsule definition passed to `capsule()`.
 *
 * The Capsule is the deployable unit: schema, server handlers, middleware, and
 * hooks bundled with the client, config, and runtime data boundary.
 */
export type CapsuleDefinition<Schema extends SchemaDefinition = SchemaDefinition> = {
  name: string;
  schema?: Schema;
  queries?: Record<string, QueryDefinition<QueryHandler<Schema, any>>>;
  mutations?: Record<string, MutationDefinition>;
  endpoints?: Record<string, EndpointDefinition<EndpointHandler<Schema>>>;
  emailEvents?: EmailEventDefinition<EmailEventHandler<Schema>>;
  messages?: Record<string, MessageDefinition<MessageHandler<Schema>>>;
  jobs?: Record<string, JobDefinition>;
  schedules?: Record<string, ScheduleDefinition>;
  /** Up to 32 Capsule-specific membership roles. Each must match `^[a-z][a-z0-9-]{0,31}$` (maximum 32 characters); `admin`, `member`, and `sporades-*` remain runtime-reserved. */
  teams?: {
    appRoles?: readonly string[];
    /** Trusted admission policy invoked after Join-link validation and before a new membership is inserted in the same transaction. */
    admitJoin?(ctx: TeamJoinAdmissionContext<Schema>, input: TeamJoinAdmissionInput): MaybePromise<TeamJoinAdmissionDecision>;
  };
  /** Optional File ACL rules for deliberate non-owner access to normal File operations. File ownership and public-URL revocation remain with the File owner. */
  files?: CapsuleFilesDefinition;
  /** Enable the client-only Journey tracker and define its TTL and automatic-capture ceiling. */
  journey?: { enabled: true; ttlSeconds?: number; capture?: { navigation?: boolean; focus?: boolean; interactions?: boolean } };
  middleware?: ContextMiddleware<Schema>[];
  hooks?: CapsuleHooks<Schema>;
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
export function capsule<const Schema extends SchemaDefinition, const Definition extends CapsuleDefinition<Schema>>(
  definition: Definition & { schema?: Schema },
): Capsule<Definition>;

/**
 * Require the current request to have a valid Sporades session.
 *
 * By default Anonymous sessions are accepted. Pass `{ linked: true }` when the
 * operation must require email, Google, or another linked provider.
 */
export function requireAuth(ctx: { auth: AuthContext }, options?: RequireAuthOptions): AuthContext;
/** Define a Custom endpoint for HTTP integrations such as webhooks. */
export function endpoint<Handler extends EndpointHandler>(options: EndpointOptions, handler: Handler): EndpointDefinition<Handler>;

/** Declare the single provider-neutral email-event subscription for a Capsule. */
export function emailEvent<Handler extends EmailEventHandler>(handler: Handler): EmailEventDefinition<Handler>;
/** Define a named query for subscribed client reads. */
export function query<const Args extends readonly JsonValue[] = readonly JsonValue[], Result = unknown>(
  handler: (ctx: CapsuleContext, ...args: Args) => MaybePromise<Result>,
): QueryDefinition<(ctx: CapsuleContext, ...args: Args) => MaybePromise<Result>>;
/** Define a named mutation for client-initiated writes or commands. */
export function mutation<const Args extends unknown[] = string[], Result = unknown>(
  handler: (ctx: CapsuleContext, ...args: Args) => MaybePromise<Result>,
): MutationDefinition<(ctx: CapsuleContext, ...args: Args) => MaybePromise<Result>>;
/** Define a server-mediated App message handler. */
export function message<Handler extends MessageHandler>(handler: Handler): MessageDefinition<Handler>;
/** Declare a named server-only Job handler in `capsule({ jobs })`. */
export function job<Payload extends JsonValue, Result extends JsonValue>(
  handler: (ctx: CapsuleContext, payload: Payload) => MaybePromise<Result>,
): JobDefinition<(ctx: CapsuleContext, payload: Payload) => MaybePromise<Result>>;
/**
 * Declare a named server-only recurring Privileged Job in
 * `capsule({ schedules })`. The map key is its durable identity. Expressions use
 * numeric five-field cron; `missedRun` defaults to `skip` and `latest` catches
 * up at most one occurrence. Scheduled Jobs retain Job Queue at-least-once
 * attempt semantics.
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
