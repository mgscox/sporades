/** Narrow lifecycle inventory wire contract, also shipped in the monitoring stack. */
export type InventoryCapsule = {
    /** Full Hosted domain/subname, also exported verbatim as service.name (up to 317 characters). */
    id: string;
    state: "registered" | "released" | "running" | "stopped" | "failed" | "deleted" | "opted-out";
    changedAt: string;
    release: string | null;
    /** Canonical origin plus up to 20 registered aliases (21 targets total). */
    targets: string[];
};
export type HostInventory = {
    schemaVersion: 1;
    host: string;
    revision: number;
    capsules: InventoryCapsule[];
};
export type InventoryAcknowledgement = {
    revision: number;
    acknowledgedAt: string;
};
export declare const INVENTORY_MAX_BYTES: number;
export declare function inventoryHost(value: unknown): value is string;
export declare function validateInventory(value: unknown): HostInventory;
/** Token reuse across Hosts would widen write authority and is rejected at setup. */
export declare function validateInventoryCredentials(value: unknown): Record<string, string>;
//# sourceMappingURL=inventory-contract.d.ts.map