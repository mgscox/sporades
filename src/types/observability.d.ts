/** Opt-in project configuration for Sentry-envelope compatible error collection. */
export type ObservabilityConfig = {
  errors?: {
    protocol: "sentry";
    /** Server env name containing a Sentry-compatible DSN. Never exposed to browsers. */
    dsnEnv: string;
    environment?: string;
    /** Error sampling probability from 0 to 1; defaults to 1. */
    sampleRate?: number;
    /** Capture browser errors through the same-origin tunnel; defaults to false. */
    client?: boolean;
  };
};

/** Opt-in project pageviews. Query strings and fragments are always removed. */
export type AnalyticsConfig = {
  provider: "umami" | "plausible";
  /** Server env name containing the exact HTTPS collection endpoint. */
  endpointEnv: string;
  /** Server env name containing the Umami website ID or Plausible domain. */
  websiteIdEnv: string;
  redactQuery?: true;
};
