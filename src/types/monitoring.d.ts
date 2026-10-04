/** Lifecycle inventory recovery files and Host-scoped HTTPS wire contract.
 * Each Capsule permits its canonical origin plus 20 aliases (21 targets total).
 * Domains and subnames use lowercase DNS labels of 1–63 characters, including
 * consecutive hyphens and ASCII punycode; targets remain bare HTTP(S) origins.
 * Full Hosted domain/subname identities (up to 317 characters) are preserved in
 * inventory, runtime service.name and Host readiness, without prefix truncation.
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

/** CLI sender results never contain ingestion or inventory secret values. */
export type { SenderCredentialResult } from "../../dist/cli/monitoring-stack.js";

/** Sender-origin stage evidence; authenticated HTTP 2xx proves authentication
 * independently of OTLP body acceptance, and never proves storage alone.
 * Migration retains a Host-wide export pause and reports relayRestarted: false;
 * ordinary connect deliberately re-enables exports.
 * Activation rollback/recovery retains a deliberately disabled export policy;
 * exports-disable settles pending activation before publishing its newer intent. */
export type { DiagnosticCheck, TelemetryDeliveryChecks } from "../../dist/cli/telemetry-diagnostics.js";
export type { HostTelemetryDiagnostic, HostTelemetryMigration } from "../../dist/cli/host-telemetry-relay.js";

/** Operator-local maintenance; snapshots carry secrets and require cold storage.
 * Restore guards are shared per Docker volume; unrelated owners are rejected.
 * Upgrade/rollback validate effective supported backend configuration before publication.
 * Interrupted publication recovery refuses operator edits and retains files/journal.
 * Stack schema 4 records generated hashes; schema 3 requires a trusted baseline.
 * Restore uses fresh volumes and preserves numeric owners and file permissions.
 * Host exports-disable retains connection credentials/outbox; remove-agents
 * requires acknowledged deliberate opt-outs and preserves Capsule/backend data.
 */
export type {
  MonitoringMaintenanceAction,
  MonitoringMaintenanceResult,
} from "../../dist/cli/monitoring-maintenance.js";

/** Monitoring stack operator .env contract, not a Capsule authoring API.
 * ALERT_POLICY_JSON is a strict bounded JSON object; absent keys retain shipped
 * starting thresholds. Prometheus alone owns evaluation. Policies do not change
 * Host lifecycle, restart behavior, runtime exports or notification credentials.
 * Exact streamRoutes are excluded from independent-histogram latency rules;
 * expectedJobServices exempt only the process-pressure candidate warning.
 * See shipped monitoring/trace/performance-policy.md for defaults and bounds. */
export interface MonitoringAlertPolicy {
  hostCpuBusyRatio?: number;
  hostCpuWaitRatio?: number;
  hostCpuForSeconds?: number;
  memoryAvailableRatio?: number;
  memoryForSeconds?: number;
  memoryCriticalRatio?: number;
  memoryCriticalForSeconds?: number;
  swapPagesPerSecond?: number;
  ioPressureRatio?: number;
  pressureForSeconds?: number;
  diskFreeRatio?: number;
  diskFreeBytes?: number;
  inodeFreeRatio?: number;
  diskForSeconds?: number;
  apiErrorRatio?: number;
  apiMinRequests?: number;
  apiBudgetSeconds?: number;
  apiLatencyForSeconds?: number;
  processCpuCores?: number;
  eventLoopDelayMs?: number;
  processForSeconds?: number;
  routeBudgets?: Array<{ service: string; route: string; seconds: number }>;
  streamRoutes?: string[];
  expectedJobServices?: string[];
}
