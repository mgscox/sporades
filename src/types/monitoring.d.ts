/** Lifecycle inventory recovery files and Host-scoped HTTPS wire contract.
 * Each Capsule permits its canonical origin plus 20 aliases (21 targets total).
 * Domains and subnames use lowercase DNS labels of 1–63 characters, including
 * consecutive hyphens and ASCII punycode; targets remain bare HTTP(S) origins.
 * This grants no runtime, dashboard, probe scheduling or remote-admin capability.
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
