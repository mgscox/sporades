/** Lifecycle inventory recovery files and Host-scoped HTTPS wire contract.
 * Each Capsule permits its canonical origin plus 20 aliases (21 targets total).
 * Domains and subnames use lowercase DNS labels of 1–63 characters, including
 * consecutive hyphens and ASCII punycode; targets remain bare HTTP(S) origins.
 * Running/failed targets drive availability expectations. Acknowledged stops,
 * deletions and opt-outs cease expectations; sender loss never does. Public
 * GET /__sporades/probe accepts a fresh X-Sporades-Probe-Nonce header
 * (or nonce query parameter, 16-64 hex characters) and returns an uncached marker
 * and echoed nonce; protected readiness stays Host-owned.
 * Operator stack .env: ALERT_WEBHOOK_URL, optional ALERT_WEBHOOK_TOKEN, and
 * MONITORING_PUBLIC_URL. Notification secrets are never profile descriptors.
 */
export type {
  HostInventory,
  InventoryCapsule,
  InventoryAcknowledgement,
} from "../../dist/cli/inventory-contract.js";

export type { TelemetryProfile } from "../../dist/cli/telemetry-profile.js";
