export type SporadesError = {
  message: string;
  hint?: string;
  [key: string]: unknown;
};

export type SporadesResult<Data = unknown> = {
  data: Data | null;
  error: SporadesError | null;
};

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

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

export type AuthApi = {
  signUp(provider: "email", credentials: EmailCredentials): Promise<SporadesResult>;
  signUp(provider: string, credentials?: unknown): Promise<SporadesResult>;
  signIn(provider: "email", credentials: EmailCredentials): Promise<SporadesResult>;
  signIn(provider: string, credentials?: unknown): Promise<SporadesResult>;
  signOut(): Promise<SporadesResult<{ ok: boolean }>>;
};

export type Subscription = {
  unsubscribe(): void;
};

export type AppMessage<Data = unknown> = {
  type: string;
  data: Data | null;
};

export type AppMessageStream<Data = unknown> = {
  filter(predicate: (message: AppMessage<Data>) => boolean): AppMessageStream<Data>;
  subscribe(listener: (message: AppMessage<Data>) => void): Subscription;
};

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

export type PublicFileUrl = {
  id: string;
  fileId: string;
  url: string;
  expiresAt: string | null;
  revokedAt?: string | null;
  [key: string]: unknown;
};

export type FileReference = string;

export type UploadProgressEvent = {
  type: "progress";
  fileId: string;
  loaded: number;
  total: number;
};

export type UploadCompleteEvent = {
  type: "complete";
  file: FileMetadata;
};

export type UploadOptions = {
  replace?: boolean;
  fileId?: string;
  fileReference?: FileReference;
  path?: string;
  onProgress?(event: UploadProgressEvent): void;
  onComplete?(event: UploadCompleteEvent): void;
};

export type PublicUrlOptions = {
  expires?: string | Date;
  ttlSeconds?: number;
  noExpiry?: boolean;
};

export type FilesApi = {
  upload(file: Blob | File, options?: UploadOptions): Promise<FileMetadata>;
  upload(files: Array<Blob | File>, options?: UploadOptions): Promise<FileMetadata[]>;
  url(fileReference: FileReference): Promise<string>;
  download(fileReference: FileReference): Promise<Blob>;
  delete(fileReference: FileReference): Promise<FileMetadata>;
  publicUrl(fileReference: FileReference, options?: PublicUrlOptions): Promise<PublicFileUrl>;
  revokePublicUrl(publicUrlId: string): Promise<PublicFileUrl>;
};

export type PreferencesResult<Preferences extends JsonObject = JsonObject> = {
  preferences: Preferences;
};

export type PreferencesApi<Preferences extends JsonObject = JsonObject> = {
  get(): Promise<SporadesResult<PreferencesResult<Preferences>>>;
  update<Patch extends Partial<Preferences> & JsonObject>(patch: Patch): Promise<SporadesResult<PreferencesResult<Preferences & Patch>>>;
};

export type QueryState<Data = unknown> = {
  data: Data | null;
  error: SporadesError | null;
  loading: boolean;
};

export type MutationState<Result = unknown> = {
  error: SporadesError | null;
  loading: boolean;
  run(...args: unknown[]): Promise<SporadesResult<Result>>;
};

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

export type HookPrimitives = {
  useState<State>(initialState: State | (() => State)): [State, (nextState: State) => void];
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
};

export type SporadesHooks = {
  useQuery<Data = unknown>(name: string): QueryState<Data>;
  useMutation<Result = unknown>(name: string): MutationState<Result>;
  useAuth(): UseAuthState;
};

export const auth: AuthApi;
export const files: FilesApi;
export const preferences: PreferencesApi;

export function isAuthenticated(): Promise<boolean>;
export function sendMessage(type: string, data?: unknown): Promise<SporadesResult>;
export function onMessage<Data = unknown>(): AppMessageStream<Data>;
export function onMessage<Data = unknown>(listener: (message: AppMessage<Data>) => void): Subscription;
export function createHooks(primitives: HookPrimitives): SporadesHooks;
