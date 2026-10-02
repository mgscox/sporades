export type InventoryState = "registered" | "released" | "started" | "stopped" | "failed" | "deleted" | "opted-out";
export type InventoryCapsule = {
    identity: string;
    state: InventoryState;
    targets: string[];
    releaseId?: string;
    lifecycleAt?: string;
};
export type LifecycleInventory = {
    schemaVersion: 1;
    host: string;
    revision: number;
    capsules: InventoryCapsule[];
};
export type InventoryAcknowledgement = {
    inventory: LifecycleInventory;
    acknowledgedAt: string;
};
export declare const inventoryHostPattern: RegExp;
export declare function validateInventory(value: unknown): LifecycleInventory;
export declare function readInventoryFile<T>(file: string): Promise<T | null>;
export declare function writeInventoryFile(file: string, value: unknown): Promise<void>;
export declare function withInventoryLock<T>(directory: string, fn: () => Promise<T>): Promise<T>;
export declare function acknowledgeInventory(directory: string, authority: string, input: unknown): Promise<InventoryAcknowledgement>;
//# sourceMappingURL=lifecycle-inventory.d.ts.map