/** Version 1 JSON contract for Host-scoped lifecycle inventory and recovery. */
export type TelemetryInventoryState = "registered" | "released" | "started" | "stopped" | "failed" | "deleted" | "opted-out";
export interface TelemetryInventoryCapsule {
  /** Canonical Hosted domain/subname; interpreted within the authenticated Host. */
  identity: string;
  state: TelemetryInventoryState;
  /** Sanitized HTTP(S) origins ending in /; no credentials, query or fragment. */
  targets: string[];
  releaseId?: string;
  lifecycleAt?: string;
}
export interface TelemetryInventory {
  schemaVersion: 1;
  host: string;
  revision: number;
  capsules: TelemetryInventoryCapsule[];
}
export interface TelemetryInventoryAcknowledgement {
  inventory: TelemetryInventory;
  acknowledgedAt: string;
}
export interface TelemetryInventoryStatus {
  configured: boolean;
  pending: boolean;
  stale: boolean;
  host?: string;
  desiredRevision?: number;
  acknowledgedRevision?: number;
  acknowledgedAt?: string | null;
  lastAttemptAt?: string | null;
  lastConfirmedAt?: string | null;
  delivery?: "pending" | "acknowledged" | "authority-denied" | "revision-conflict" | "unavailable";
}
