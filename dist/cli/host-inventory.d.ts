import { type HostInventory, type InventoryAcknowledgement } from "./inventory-contract.js";
type Outbox = {
    connectionGeneration?: string;
    desired: HostInventory;
    endpoint: string;
    acknowledgement: InventoryAcknowledgement | null;
    lastAttemptAt: string | null;
    failure: string | null;
};
export declare function queueHostInventory(root: string): Promise<Outbox | null>;
export declare function hostInventoryStatus(root: string, snapshotFailed?: boolean): Promise<{
    host: string | null;
    desiredRevision: number | null;
    acknowledgedRevision: number | null;
    acknowledgedAt: string | null;
    pending: boolean;
    stale: boolean;
    lastAttemptAt: string | null;
    failure: string | null;
    reconcilerInstalled: boolean;
}>;
export declare function exportHostInventory(root: string): Promise<HostInventory | null>;
export declare function reconcileHostInventory(root: string): Promise<{
    host: string | null;
    desiredRevision: number | null;
    acknowledgedRevision: number | null;
    acknowledgedAt: string | null;
    pending: boolean;
    stale: boolean;
    lastAttemptAt: string | null;
    failure: string | null;
    reconcilerInstalled: boolean;
}>;
export declare function inventoryUnit(root: string): string;
export declare function kickHostInventory(root: string): void;
export declare function installHostInventoryWorker(root: string): Promise<{
    installed: boolean;
    reason: string;
    unit?: undefined;
    intervalSeconds?: undefined;
} | {
    installed: boolean;
    unit: string;
    intervalSeconds: number;
    reason?: undefined;
}>;
/** Remove only the exact generated timer/service; retain protected outbox and secrets. */
export declare function removeHostInventoryWorker(root: string): Promise<{
    removed: boolean;
}>;
export {};
//# sourceMappingURL=host-inventory.d.ts.map