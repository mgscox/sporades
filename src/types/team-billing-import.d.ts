export type TeamBillingImportAdapter = {
  dialect: { name: string; sql(statement: string): string };
  exec(statement: string): unknown | Promise<unknown>;
  prepare(statement: string): {
    all(...params: unknown[]): unknown[] | Promise<unknown[]>;
    get(...params: unknown[]): Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
    run(...params: unknown[]): unknown | Promise<unknown>;
  };
  withTransaction<Value>(run: (transaction: TeamBillingImportAdapter) => Value | Promise<Value>): Promise<Value>;
};

export type LegacyTeamBillingEvidence = Readonly<{
  sourceKey: string;
  teamId: string;
  mode: "sandbox" | "live";
  providerCustomerId: string;
  providerSubscriptionId: string;
  providerSubscriptionItemId: string;
  providerPriceId: string;
  productKey: string;
  quantity: number;
  state: "active" | "past-due" | "cancelled";
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  providerEventId: string;
  providerEventType: "customer.subscription.created" | "customer.subscription.updated" | "customer.subscription.deleted";
  providerEventDigest: string;
  providerObservedAt: string;
  retainedUntil: string;
}>;

export type LegacyTeamBillingImportResult = Readonly<{ outcome: "imported" | "unchanged" }>;

export type LegacyTeamBillingReplayGuard = Readonly<{
  providerEventId: string;
  providerEventType: string;
  providerEventDigest: string;
  mode: "sandbox" | "live";
  settledAt: string;
  retainedUntil: string;
}>;

/** Import one complete, app-classified, verified legacy Subscription snapshot without provider I/O. */
export function importLegacyTeamBillingEvidence(
  adapter: TeamBillingImportAdapter,
  input: LegacyTeamBillingEvidence,
): Promise<LegacyTeamBillingImportResult>;

/** Import one legacy processed-event replay guard without associating it to a Team. */
export function importLegacyTeamBillingReplayGuard(
  adapter: TeamBillingImportAdapter,
  input: LegacyTeamBillingReplayGuard,
): Promise<LegacyTeamBillingImportResult>;
