import type { InventoryCapsule } from "./inventory-contract.js";
/** Bounded, best-effort local readiness reporting on the existing private relay.
 * This is called only by the background inventory worker, never by a request or
 * Capsule lifecycle path. No runtime readiness detail or credential is emitted.
 */
export declare function reportHostAvailability(input: {
    host: string;
    network: string;
    capsules: Pick<InventoryCapsule, "id" | "state">[];
}, relayPort?: number): Promise<boolean>;
//# sourceMappingURL=host-availability.d.ts.map