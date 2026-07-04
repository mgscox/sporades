export type FieldKind = "String" | "Boolean" | "Number" | "Date" | "Json" | "Reference";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type MaybePromise<Value> = Value | Promise<Value>;

export type FieldBuilder<Value> = {
  kind: FieldKind;
  default(defaultValue: Value): FieldDefinition<Value>;
};

export type FieldDefinition<Value> = {
  kind: FieldKind;
  defaultValue?: Value;
};

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

export type TableAclContext = {
  auth: AuthContext;
  [key: string]: unknown;
};

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

export type TableAclRules<Row extends Record<string, unknown> = Record<string, unknown>> = Partial<
  Record<TableAclOperation, TableAclRule<Row>>
>;

export type TableDefinition<Fields extends Record<string, AnyFieldDefinition> = Record<string, AnyFieldDefinition>> = {
  kind: "table";
  fields: Fields;
  aclRules?: TableAclRules;
  acl(rules: TableAclRules<RowFromFields<Fields>>): TableDefinition<Fields>;
};

export type SchemaDefinition = Record<string, TableDefinition>;

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

export type AuthContext = {
  userId: string;
  displayName: string;
  email: string | null;
  picture: string | null;
  isAuthenticated: boolean;
  isGuest: boolean;
  provider: string;
};

export type Logger = {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export type MessageScope =
  | "currentUser"
  | "all"
  | {
      userId?: string;
      userIds?: string[];
    };

export type MessageApi = {
  send(message: { type: string; data?: unknown; scope?: MessageScope }): number;
};

export type CapsuleContext<Schema extends SchemaDefinition = SchemaDefinition> = {
  db: DatabaseFromSchema<Schema>;
  auth: AuthContext;
  env: Record<string, string>;
  log: Logger;
  messages: MessageApi;
};

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

export type QueryHandler<Schema extends SchemaDefinition = SchemaDefinition, Result = unknown> = (
  ctx: CapsuleContext<Schema>,
) => MaybePromise<Result>;

export type MutationHandler<Schema extends SchemaDefinition = SchemaDefinition, Result = unknown> = (
  ctx: CapsuleContext<Schema>,
  ...args: any[]
) => MaybePromise<Result>;

export type EndpointHandler<Schema extends SchemaDefinition = SchemaDefinition, Result = unknown> = (
  ctx: EndpointContext<Schema>,
) => MaybePromise<Result>;

export type MessageHandler<Schema extends SchemaDefinition = SchemaDefinition, Result = unknown> = (
  ctx: CapsuleContext<Schema>,
  data: any,
) => MaybePromise<Result>;

export type ContextKind = "query" | "mutation" | "endpoint" | "message";

export type MiddlewareContext<Schema extends SchemaDefinition = SchemaDefinition> = CapsuleContext<Schema> &
  Partial<Pick<EndpointContext<Schema>, "request">> & {
    kind: ContextKind;
    [key: string]: any;
  };

export type ContextMiddleware<Schema extends SchemaDefinition = SchemaDefinition> = (
  ctx: MiddlewareContext<Schema>,
) => MaybePromise<MiddlewareContext<Schema> | void>;

export type MutationResult<Result = unknown> = {
  ok: boolean;
  data?: Result | null;
  error?: { message: string; hint?: string } | null;
};

export type MutationHookEvent<Schema extends SchemaDefinition = SchemaDefinition, Result = unknown> = {
  name: string;
  args: any[];
  ctx: MiddlewareContext<Schema>;
  result?: MutationResult<Result>;
};

export type MutationHook<Schema extends SchemaDefinition = SchemaDefinition, Result = unknown> = (
  event: MutationHookEvent<Schema, Result>,
) => MaybePromise<void>;

export type CapsuleHooks<Schema extends SchemaDefinition = SchemaDefinition> = {
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

export type EndpointOptions = {
  method: string;
  path: string;
};

export type EndpointDefinition<Handler = EndpointHandler> = {
  kind: "endpoint";
  options: EndpointOptions;
  handler: Handler;
};

export type MessageDefinition<Handler = MessageHandler> = {
  kind: "message";
  handler: Handler;
};

export type CapsuleDefinition<Schema extends SchemaDefinition = SchemaDefinition> = {
  name: string;
  schema?: Schema;
  queries?: Record<string, QueryDefinition<QueryHandler<Schema>>>;
  mutations?: Record<string, MutationDefinition<MutationHandler<Schema>>>;
  endpoints?: Record<string, EndpointDefinition<EndpointHandler<Schema>>>;
  messages?: Record<string, MessageDefinition<MessageHandler<Schema>>>;
  middleware?: ContextMiddleware<Schema>[];
  hooks?: CapsuleHooks<Schema>;
};

export type Capsule<Definition extends object = CapsuleDefinition> = Definition & {
  kind: "capsule";
};

export function capsule<const Schema extends SchemaDefinition, const Definition extends CapsuleDefinition<Schema>>(
  definition: Definition & { schema?: Schema },
): Capsule<Definition>;

export function endpoint<Handler extends EndpointHandler>(options: EndpointOptions, handler: Handler): EndpointDefinition<Handler>;
export function query<Handler extends QueryHandler>(handler: Handler): QueryDefinition<Handler>;
export function mutation<Handler extends MutationHandler>(handler: Handler): MutationDefinition<Handler>;
export function message<Handler extends MessageHandler>(handler: Handler): MessageDefinition<Handler>;
export function table<const Fields extends Record<string, AnyFieldDefinition>>(fields: Fields): TableDefinition<Fields>;

export function String(): FieldBuilder<string>;
export function Boolean(): FieldBuilder<boolean>;
export function Number(): FieldBuilder<number>;
export function Date(): FieldBuilder<string | globalThis.Date | null>;
export function Json<Value extends JsonValue = JsonValue>(): FieldBuilder<Value>;
export function Reference(targetTable: string): ReferenceFieldBuilder;
