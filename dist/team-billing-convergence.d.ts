type LooseRecord = Record<string, any>;
/** Apply a verified observation using the caller's already-owned transaction. */
export declare function applyVerifiedTeamBillingObservation(database: LooseRecord, event: any): Promise<Readonly<{
    applied: boolean;
}>>;
export {};
//# sourceMappingURL=team-billing-convergence.d.ts.map