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

/** Sender-origin stage evidence; HTTP acceptance alone never proves storage. */
export type { DiagnosticCheck, TelemetryDeliveryChecks } from "../../dist/cli/telemetry-diagnostics.js";
export type { HostTelemetryDiagnostic, HostTelemetryMigration } from "../../dist/cli/host-telemetry-relay.js";
