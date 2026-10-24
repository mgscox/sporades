/**
 * Opt-in Sentry-envelope error collection. Per runtime process, trusted server
 * errors reserve 4 concurrent sends / 60 sends per 60-second fixed window.
 * Browser errors, CSP reports and analytics share a separate outbound lane with
 * the same bounds. Public HTTP ingress allows 8 concurrent requests / 120 attempts
 * per window, including invalid bodies. Saturation drops outbound events without
 * queuing; failures release concurrency but do not refund the window count.
 * Diagnostics conceal complete sensitive
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
    /** Server env name containing a Sentry-compatible DSN. Never exposed to browsers. Host services connect can seal this key automatically. */
    dsnEnv: string;
    environment?: string;
    /** Error sampling probability from 0 to 1; defaults to 1. */
    sampleRate?: number;
    /** Capture browser errors through the same-origin tunnel; defaults to false. */
    client?: boolean;
  };
};

/**
 * Opt-in project pageviews. Query strings and fragments are always removed.
 * Shares the public outbound lane (4 concurrent / 60 sends per 60-second fixed
 * window) with browser errors and CSP, independently of trusted server errors.
 */
export type AnalyticsConfig = {
  provider: "umami" | "plausible";
  /** Server env name containing the exact HTTPS collection endpoint; Host-managed Umami can seal it automatically. */
  endpointEnv: string;
  /** Server env name containing the Umami website ID or Plausible domain. */
  websiteIdEnv: string;
  redactQuery?: true;
};
