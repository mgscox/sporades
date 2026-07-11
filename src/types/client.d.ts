/** Structured error returned by Sporades client SDK operations. */
export type SporadesError = {
  message: string;
  hint?: string;
  [key: string]: unknown;
};

/**
 * Standard result envelope for client SDK calls.
 *
 * Check `error` before trusting `data`; failed operations keep transport and
 * runtime details inside a Sporades-shaped error.
 */
export type SporadesResult<Data = unknown> = {
  data: Data | null;
  error: SporadesError | null;
};

/** JSON-compatible values accepted by current-user preferences. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Automatic Journey sources a page may narrow below the Capsule declaration. */
export type JourneyCapture = { navigation?: boolean; focus?: boolean; interactions?: boolean };
/** Page-runtime consent options. Enabling does not create a Journey session. */
export type JourneyEnableOptions = { capture?: JourneyCapture };
/** A semantic latest-state replacement; metadata and TTL are bounded by the runtime. */
export type JourneySetInput = { status: string; metadata?: JsonObject; ttlSeconds?: number };
/** One TTL-buffered, server-owned connection/activity segment. */
export type JourneyRecord = { sessionId: string; userId: string; status: string; metadata: JsonObject | null; updatedAt: string; expiresAt: string };
/** Effective page consent. Session identity is created lazily on publication. */
export type JourneyEnableResult = { enabled: true; userId: string; capture: Required<JourneyCapture> };
/** Snapshot-first realtime Journey delivery. Removal carries the complete last record. */
export type JourneyEvent = { type: "snapshot"; states: JourneyRecord[] } | { type: "added" | "updated" | "removed"; state: JourneyRecord };
/** A Journey listener lifetime owned by the subscribing page. */
export type JourneySubscription = { unsubscribe(): void };
/** Client-only API for consent, publication, observation, and retirement of transient Journey state. */
export type JourneyApi = {
  enable(options?: JourneyEnableOptions): Promise<SporadesResult<JourneyEnableResult>>;
  set(state: JourneySetInput): Promise<SporadesResult<{ journey: JourneyRecord }>>;
  list(): Promise<SporadesResult<{ journeys: JourneyRecord[] }>>;
  subscribe(listener: (event: JourneyEvent) => void): JourneySubscription;
  disable(): Promise<SporadesResult<{ ok: boolean }>>;
};

/**
 * Current Sporades auth state in the browser.
 *
 * Every visitor receives a real Anonymous session. `isGuest` remains true until
 * that session is linked to a provider such as email or Google.
 */
export type AuthState = {
  userId: string;
  displayName: string;
  email: string | null;
  picture: string | null;
  isAuthenticated: boolean;
  isGuest: boolean;
  provider: string;
};

export type ProviderState = {
  enabled: boolean;
  configured?: boolean;
};

/** Provider availability reported by the server runtime. */
export type AuthProviders = Record<string, ProviderState> & {
  anonymous?: ProviderState;
  google?: ProviderState;
  email?: ProviderState;
};

export type EmailCredentials = {
  email: string;
  password: string;
  name?: string;
};

/** Complete current browser auth replacement delivered by `auth.subscribe()`. */
export type AuthObserverState = {
  auth: AuthState | null;
  providers: AuthProviders;
  loading: boolean;
  error: SporadesError | null;
};

/** Current auth data returned by `auth.get()`. */
export type AuthResult = { auth: AuthState; providers: AuthProviders };

/**
 * Browser auth API.
 *
 * The SDK stores the Sporades session token in localStorage and sends it over
 * the same-origin client transport. Provider SDKs are not exposed to app code.
 */
export type AuthApi = {
  get(): Promise<SporadesResult<AuthResult>>;
  subscribe(listener: (state: AuthObserverState) => void): Subscription;
  signUp(provider: "email", credentials: EmailCredentials): Promise<SporadesResult>;
  signUp(provider: string, credentials?: unknown): Promise<SporadesResult>;
  signIn(provider: "email", credentials: EmailCredentials): Promise<SporadesResult>;
  signIn(provider: string, credentials?: unknown): Promise<SporadesResult>;
  signOut(): Promise<SporadesResult<{ ok: boolean }>>;
};

/** Handle returned by client subscriptions. */
export type Subscription = {
  unsubscribe(): void;
};

/**
 * App-defined message delivered through the Sporades client transport.
 *
 * App code uses unprefixed type names. Sporades owns the internal `app.` prefix
 * and only delivers client-origin messages after server mediation.
 */
export type AppMessage<Data = unknown> = {
  type: string;
  data: Data | null;
};

/** Filterable stream of App messages from the server runtime. */
export type AppMessageStream<Data = unknown> = {
  filter(predicate: (message: AppMessage<Data>) => boolean): AppMessageStream<Data>;
  subscribe(listener: (message: AppMessage<Data>) => void): Subscription;
};

/**
 * Metadata for an uploaded file inside one Capsule.
 *
 * `id` is stable across replacement. `version` changes when bytes are replaced,
 * so generated URLs cannot keep serving stale content.
 */
export type FileMetadata = {
  id: string;
  name: string;
  type: string;
  size: number;
  path?: string;
  version?: string;
  url?: string;
  [key: string]: unknown;
};

/** Server-managed public read URL for a private uploaded file. */
export type PublicFileUrl = {
  id: string;
  fileId: string;
  url: string;
  expiresAt: string | null;
  revokedAt?: string | null;
  [key: string]: unknown;
};

/**
 * Value that resolves to one live file metadata record, usually a File ID or
 * an absolute Capsule File path.
 */
export type FileReference = string;

/** Upload progress event for a single file upload. */
export type UploadProgressEvent = {
  type: "progress";
  fileId: string;
  loaded: number;
  total: number;
};

/** Upload completion event for a single file upload. */
export type UploadCompleteEvent = {
  type: "complete";
  file: FileMetadata;
};

/**
 * Options for `files.upload()`.
 *
 * Use `path` for an absolute Capsule File path. Use `replace` with `fileId` or
 * `fileReference` when preserving the stable File ID but writing a new version.
 */
export type UploadOptions = {
  replace?: boolean;
  fileId?: string;
  fileReference?: FileReference;
  path?: string;
  onProgress?(event: UploadProgressEvent): void;
  onComplete?(event: UploadCompleteEvent): void;
};

/**
 * Expiry policy for a generated public file URL.
 *
 * Choose exactly one of `expires`, `ttlSeconds`, or `noExpiry` for clear app
 * intent.
 */
export type PublicUrlOptions = {
  expires?: string | Date;
  ttlSeconds?: number;
  noExpiry?: boolean;
};

/**
 * Browser file API.
 *
 * Uploads hide URL negotiation and byte transfer details. Passing an array is a
 * convenience that uploads files sequentially and returns metadata in order.
 */
export type FilesApi = {
  upload(file: Blob | File, options?: UploadOptions): Promise<FileMetadata>;
  upload(files: Array<Blob | File>, options?: UploadOptions): Promise<FileMetadata[]>;
  url(fileReference: FileReference): Promise<string>;
  download(fileReference: FileReference): Promise<Blob>;
  delete(fileReference: FileReference): Promise<FileMetadata>;
  publicUrl(fileReference: FileReference, options?: PublicUrlOptions): Promise<PublicFileUrl>;
  revokePublicUrl(publicUrlId: string): Promise<PublicFileUrl>;
};

/** Successful current-user preferences payload. */
export type PreferencesResult<Preferences extends JsonObject = JsonObject> = {
  preferences: Preferences;
};

/**
 * Current-user preferences API.
 *
 * Preferences are runtime-owned JSON keyed by the Sporades user identity. They
 * are not part of Capsule app schema and do not appear on `ctx.db`.
 */
export type PreferencesApi<Preferences extends JsonObject = JsonObject> = {
  get(): Promise<SporadesResult<PreferencesResult<Preferences>>>;
  update<Patch extends Partial<Preferences> & JsonObject>(patch: Patch): Promise<SporadesResult<PreferencesResult<Preferences & Patch>>>;
};

/** Hook state returned by `useQuery()`. */
export type QueryState<Data = unknown> = {
  data: Data | null;
  error: SporadesError | null;
  loading: boolean;
};

/** Framework-neutral realtime query subscriptions. */
export type QueriesApi = {
  subscribe<Data = unknown>(name: string, listener: (state: QueryState<Data>) => void): Subscription;
};

/** Framework-neutral mutation execution using the standard Sporades result envelope. */
export type MutationsApi = {
  run<Result = unknown>(name: string, ...args: unknown[]): Promise<SporadesResult<Result>>;
};

/** Hook state returned by `useMutation()`. */
export type MutationState<Result = unknown> = {
  error: SporadesError | null;
  loading: boolean;
  run(...args: unknown[]): Promise<SporadesResult<Result>>;
};

/** Hook state and auth commands returned by `useAuth()`. */
export type UseAuthState = {
  auth: AuthState | null;
  providers: AuthProviders;
  loading: boolean;
  error: SporadesError | null;
  isAuthenticated(): boolean;
  signUp: AuthApi["signUp"];
  signIn: AuthApi["signIn"];
  signOut: AuthApi["signOut"];
};

/**
 * Framework primitives consumed by `createHooks()`.
 *
 * Pass `useState` and `useEffect` from the JSX framework used by the Capsule
 * client, such as React or Preact.
 */
export type HookPrimitives = {
  useState<State>(initialState: State | (() => State)): [State, (nextState: State) => void];
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
};

/** Framework-bound Sporades hooks produced by `createHooks()`. */
export type SporadesHooks = {
  useQuery<Data = unknown>(name: string): QueryState<Data>;
  useMutation<Result = unknown>(name: string): MutationState<Result>;
  useAuth(): UseAuthState;
};

/** Vue lifecycle/reactivity primitives consumed by `createVueComposables()`. */
export type VueComposablePrimitives = {
  reactive<State extends object>(state: State): State;
  onScopeDispose(cleanup: () => void): void;
};

/** Vue-native Sporades composables over the shared framework-neutral client connection. */
export type SporadesVueComposables = {
  useQuery<Data = unknown>(name: string): QueryState<Data>;
  useMutation<Result = unknown>(name: string): VueMutationState<Result>;
  useAuth(): UseAuthState;
};

/** Vue mutation state follows the latest invocation while `loading` covers every pending call. */
export type VueMutationState<Result = unknown> = MutationState<Result> & {
  data: Result | null;
};

/** SolidJS-compatible reactive accessor. */
export type SolidAccessor<State> = () => State;

/** SolidJS-compatible signal setter. */
export type SolidSignalSetter<State> = (next: State | ((current: State) => State)) => State;

/** SolidJS lifecycle and signal primitives consumed by `createSolidPrimitives()`. */
export type SolidPrimitiveInputs = {
  createSignal<State>(initialState: State): [SolidAccessor<State>, SolidSignalSetter<State>];
  onCleanup(cleanup: () => void): void;
};

/** SolidJS mutation state follows the latest invocation while loading covers every pending call. */
export type SolidMutationState<Result = unknown> = {
  data: Result | null;
  error: SporadesError | null;
  loading: boolean;
};

/** Root-owned SolidJS mutation primitive. */
export type SolidMutation<Result = unknown> = {
  state: SolidAccessor<SolidMutationState<Result>>;
  run(...args: unknown[]): Promise<SporadesResult<Result>>;
};

/** Root-owned SolidJS auth primitive and direct auth commands. */
export type SolidAuth = {
  state: SolidAccessor<AuthObserverState>;
  isAuthenticated(): boolean;
  signUp: AuthApi["signUp"];
  signIn: AuthApi["signIn"];
  signOut: AuthApi["signOut"];
};

/** SolidJS-native Sporades primitives over the shared framework-neutral client connection. */
export type SporadesSolidPrimitives = {
  createQuery<Data = unknown>(name: string): SolidAccessor<QueryState<Data>>;
  createMutation<Result = unknown>(name: string): SolidMutation<Result>;
  createAuth(): SolidAuth;
};

/** Minimal Svelte-compatible readable store contract. */
export type SvelteReadable<State> = {
  subscribe(listener: (state: State) => void): () => void;
};

/** Svelte mutation store state; invoke mutations through the store's `run` method. */
export type SvelteMutationStore<Result = unknown> = SvelteReadable<Omit<MutationState<Result>, "run"> & { data: Result | null }> & {
  run(...args: unknown[]): Promise<SporadesResult<Result>>;
};

/** Svelte auth state and commands over one lazily observed auth subscription. */
export type SvelteAuthStore = SvelteReadable<Omit<UseAuthState, "signUp" | "signIn" | "signOut">> & {
  signUp: AuthApi["signUp"];
  signIn: AuthApi["signIn"];
  signOut: AuthApi["signOut"];
};

/** Svelte-native stores over the shared framework-neutral client connection. */
export type SporadesSvelteStores = {
  queryStore<Data = unknown>(name: string): SvelteReadable<QueryState<Data>>;
  mutationStore<Result = unknown>(name: string): SvelteMutationStore<Result>;
  authStore(): SvelteAuthStore;
};

/** Auth commands for the current browser session. */
export const auth: AuthApi;
/** File upload, URL, download, delete, and public URL commands. */
export const files: FilesApi;
/** Runtime-owned current-user preferences commands. */
export const preferences: PreferencesApi;
/** Explicit, page-runtime User journey publication lifecycle; server sessions are created lazily by accepted publications. */
export const journey: JourneyApi;
/** Framework-neutral query state subscriptions. */
export const queries: QueriesApi;
/** Framework-neutral mutation execution. */
export const mutations: MutationsApi;

/** Return whether the current browser session is authenticated. */
export function isAuthenticated(): Promise<boolean>;
/**
 * Send an App message to the server runtime.
 *
 * The message must be handled by a declared server `message(...)` handler
 * before any server-side response or fan-out occurs.
 */
export function sendMessage(type: string, data?: unknown): Promise<SporadesResult>;
/** Create a filterable stream for App messages. */
export function onMessage<Data = unknown>(): AppMessageStream<Data>;
/** Subscribe directly to all App messages and receive an unsubscribe handle. */
export function onMessage<Data = unknown>(listener: (message: AppMessage<Data>) => void): Subscription;
/**
 * Bind Sporades query, mutation, and auth hooks to a client framework.
 *
 * @example
 * ```tsx
 * import { useEffect, useState } from "react";
 * import { createHooks } from "sporades/client";
 *
 * const { useAuth, useMutation, useQuery } = createHooks({ useState, useEffect });
 * ```
 */
export function createHooks(primitives: HookPrimitives): SporadesHooks;

/** Bind reactive Sporades state and subscription cleanup to a Vue effect scope or component. */
export function createVueComposables(primitives: VueComposablePrimitives): SporadesVueComposables;
/** Bind root-owned SolidJS signals and cleanup to the shared Sporades client connection. */
export function createSolidPrimitives(primitives: SolidPrimitiveInputs): SporadesSolidPrimitives;
/** Create lazily observed Svelte-compatible stores for query, mutation, and auth state. */
export function createSvelteStores(): SporadesSvelteStores;
