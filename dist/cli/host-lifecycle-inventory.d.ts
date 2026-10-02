import { type LifecycleInventory } from "./lifecycle-inventory.js";
type PendingInventory = {
    destination: string;
    desired: LifecycleInventory;
    acknowledgedRevision: number;
    acknowledgedAt: string | null;
    lastAttemptAt: string | null;
    delivery: string;
    lastConfirmedAt: string | null;
};
export declare function queueHostInventory(root: string): Promise<PendingInventory | null>;
export declare function hostInventoryStatus(root: string): Promise<{
    configured: boolean;
    pending: boolean;
    stale: boolean;
    host?: undefined;
    desiredRevision?: undefined;
    acknowledgedRevision?: undefined;
    acknowledgedAt?: undefined;
    lastAttemptAt?: undefined;
    lastConfirmedAt?: undefined;
    delivery?: undefined;
} | {
    configured: boolean;
    host: string;
    desiredRevision: number;
    acknowledgedRevision: number;
    acknowledgedAt: string | null;
    lastAttemptAt: string | null;
    lastConfirmedAt: string | null;
    pending: boolean;
    stale: boolean;
    delivery: string;
}>;
export declare function exportHostInventory(root: string): Promise<LifecycleInventory>;
export declare function reconcileHostInventory(root: string): Promise<{
    configured: boolean;
    pending: boolean;
    stale: boolean;
    host?: undefined;
    desiredRevision?: undefined;
    acknowledgedRevision?: undefined;
    acknowledgedAt?: undefined;
    lastAttemptAt?: undefined;
    lastConfirmedAt?: undefined;
    delivery?: undefined;
} | {
    configured: boolean;
    host: string;
    desiredRevision: number;
    acknowledgedRevision: number;
    acknowledgedAt: string | null;
    lastAttemptAt: string | null;
    lastConfirmedAt: string | null;
    pending: boolean;
    stale: boolean;
    delivery: string;
}>;
export declare function importHostInventory(root: string, input: unknown): Promise<{
    configured: boolean;
    pending: boolean;
    stale: boolean;
    host?: undefined;
    desiredRevision?: undefined;
    acknowledgedRevision?: undefined;
    acknowledgedAt?: undefined;
    lastAttemptAt?: undefined;
    lastConfirmedAt?: undefined;
    delivery?: undefined;
} | {
    configured: boolean;
    host: string;
    desiredRevision: number;
    acknowledgedRevision: number;
    acknowledgedAt: string | null;
    lastAttemptAt: string | null;
    lastConfirmedAt: string | null;
    pending: boolean;
    stale: boolean;
    delivery: string;
}>;
export {};
//# sourceMappingURL=host-lifecycle-inventory.d.ts.map