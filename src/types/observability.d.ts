/**
 * Opt-in Sentry-envelope error collection. Diagnostics conceal complete sensitive
 * values (including arrays/objects) and URL queries/fragments, including relative
 * URLs in messages and stack filenames after punctuation or key/value delimiters.
 * From the first literal or encoded query/fragment delimiter, the entire remaining
 * diagnostic line is concealed, including whitespace, quotation, nested containers,
 * later URL-like text, JSON fields and closing punctuation. Public prefixes and
 * following lines remain available. URL stripping precedes Server env substitution,
 * including URL-prefix env values and complete URL-valued secrets.
 */
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
