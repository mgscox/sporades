/** Operator workflow contracts. No credentials, provisioning or Host lifecycle access. */
export type AcceptanceSurface = 'server-error' | 'browser-error' | 'browser-rejection' |
  'analytics-pageview' | 'notification-smtp' | 'notification-inbox';
export type AcceptanceTarget = { origin: string; capsule: string; release: string; environment?: string };
export type AcceptancePlan = {
  version: 1;
  target: AcceptanceTarget;
  analytics?: boolean;
  notifications?: boolean;
  surfaces: Partial<Record<AcceptanceSurface, {
    provider: string;
    /** Exact existing GlitchTip project or analytics website identity. */
    project: string;
    state: 'enabled' | 'disabled' | 'missing';
    /** Existing, approved app diagnostic path and operator approval reference. Never created by the gate. */
    diagnostic?: { path: string; approval: string };
  }>>;
};
export type AcceptanceContext = {
  target: Readonly<AcceptanceTarget>;
  surface: AcceptanceSurface;
  /** Unique per-surface marker; notification surfaces correlate to server-error. */
  marker: string;
  project: string;
  diagnostic?: { path: string; approval: string };
  startedAt: string;
  signal: AbortSignal;
  serverEventHandle?: string;
};
export type AcceptanceEvent = {
  /** Opaque provider read-back ID, never a credential-bearing URL. */
  handle: string;
  project: string;
  marker: string;
  timestamp: string;
  capsule: string;
  release: string;
  environment?: string;
  surface: AcceptanceSurface;
  /** Complete stored event/receipt, used for synthetic redaction checks; never emitted in the report. */
  payload: unknown;
  relatedEventHandle?: string;
};
export type AcceptanceDriver = {
  /** Exercise the app's existing diagnostic path once, using only synthetic data. Never direct provider capture. */
  probe(context: AcceptanceContext): Promise<{
    capture: 'app-runtime';
    target: AcceptanceTarget;
    /** Synthetic values actually injected by this probe, checked against stored payloads. */
    redactionCanaries: string[];
  }>;
  /** Read actual stored evidence. Return null while not yet present. Throw on provider unavailability. */
  readBack(context: AcceptanceContext): Promise<AcceptanceEvent | null>;
  /** Release only resources this driver owns; must honor the signal, including after partial failure. */
  cleanup(signal: AbortSignal): Promise<void>;
};
export type AcceptanceEvidence = {
  status: 'pass' | 'fail' | 'skipped' | 'blocked';
  reason: string;
  marker: string;
  provider?: string;
  project?: string;
  handle?: string;
  timestamp?: string;
  diagnostic?: { path: string; approval: string };
};
export type AcceptanceReport = {
  version: 1;
  status: 'pass' | 'fail' | 'blocked';
  target: AcceptanceTarget;
  marker: string;
  startedAt: string;
  finishedAt: string;
  surfaces: Record<AcceptanceSurface, AcceptanceEvidence>;
  cleanup: 'pass' | 'fail';
};
