import { createHash } from "node:crypto";
import { createTeamBillingTables } from "./team-billing-runtime.js";
import { teamBillingSubscriptionSemantics } from "./team-billing-subscription-semantics.js";

type LooseRecord = Record<string, any>;

const TEAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^(?:cus|sub|si|price|evt)_[A-Za-z0-9_]{2,250}$/;
const PRODUCT_KEY = /^[a-z][a-z0-9-]{0,47}$/;
const CANONICAL_TIME = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

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

/** Imports legacy processed-event evidence as a provider-free replay guard. */
export async function importLegacyTeamBillingReplayGuard(
  adapter: LooseRecord,
  input: LegacyTeamBillingReplayGuard,
): Promise<LegacyTeamBillingImportResult> {
  if (!input || typeof input !== "object" || Object.keys(input).sort().join(",") !== [
    "mode", "providerEventDigest", "providerEventId", "providerEventType", "retainedUntil", "settledAt",
  ].sort().join(",")
    || !["sandbox", "live"].includes(input.mode) || !PROVIDER_ID.test(input.providerEventId)
    || typeof input.providerEventType !== "string" || !/^[a-z][a-z0-9_.]{2,127}$/.test(input.providerEventType)
    || typeof input.providerEventDigest !== "string" || input.providerEventDigest.length < 16 || input.providerEventDigest.length > 256
    || !canonicalTime(input.settledAt) || !canonicalTime(input.retainedUntil) || input.retainedUntil <= input.settledAt) throw invalid();
  await ensureImportStorage(adapter);
  return await adapter.withTransaction(async (transaction: LooseRecord) => {
    await lockImportIdentities(transaction, [input.providerEventId]);
    const sql = transaction.dialect.sql;
    const observation = await transaction.prepare(sql(
      "SELECT * FROM [sporades_team_billing_observations] WHERE [providerEventId] = ?",
    )).get(input.providerEventId);
    const expected = {
      teamId: null, mode: input.mode, providerEventId: input.providerEventId, providerObjectId: null,
      payloadDigest: input.providerEventDigest, observedAt: input.settledAt, eventType: input.providerEventType,
      eventRank: null, outcome: "ignored", safeReason: "LEGACY_REPLAY_GUARD",
    };
    if (observation && !same(observation, expected)) throw conflict();
    const replay = await transaction.prepare(sql(
      "SELECT * FROM [sporades_team_billing_replay] WHERE [providerEventId] = ?",
    )).get(input.providerEventId);
    if (replay && !same(replay, {
      providerEventId: input.providerEventId, payloadDigest: input.providerEventDigest,
      settledAt: input.settledAt, retainedUntil: input.retainedUntil,
    })) throw conflict();
    if (observation && replay) return Object.freeze({ outcome: "unchanged" });
    if (!observation) {
      await transaction.prepare(sql(
        "INSERT INTO [sporades_team_billing_observations] ([id], [teamId], [mode], [providerEventId], [providerObjectId], [payloadDigest], [observedAt], [createdAt], [eventType], [eventRank], [outcome], [safeReason]) VALUES (?, NULL, ?, ?, NULL, ?, ?, ?, ?, NULL, 'ignored', 'LEGACY_REPLAY_GUARD')",
      )).run(stableId("legacy-replay", input.providerEventId), input.mode, input.providerEventId,
        input.providerEventDigest, input.settledAt, input.settledAt, input.providerEventType);
    }
    if (!replay) {
      await transaction.prepare(sql(
        "INSERT INTO [sporades_team_billing_replay] ([providerEventId], [payloadDigest], [settledAt], [retainedUntil]) VALUES (?, ?, ?, ?)",
      )).run(input.providerEventId, input.providerEventDigest, input.settledAt, input.retainedUntil);
    }
    return Object.freeze({ outcome: "imported" });
  });
}

/**
 * Imports one already-verified legacy Subscription snapshot into Sporades-owned
 * billing state. Classification and product policy remain with the Capsule;
 * this primitive accepts only a complete, exact provider tuple and fails closed
 * on every conflict. It performs no provider I/O.
 */
export async function importLegacyTeamBillingEvidence(
  adapter: LooseRecord,
  input: LegacyTeamBillingEvidence,
): Promise<LegacyTeamBillingImportResult> {
  const evidence = validate(input);
  const semantics = teamBillingSubscriptionSemantics(evidence.providerEventType, evidence.state, evidence.cancelAtPeriodEnd)!;
  await ensureImportStorage(adapter);
  return await adapter.withTransaction(async (transaction: LooseRecord) => {
    await lockImportIdentities(transaction, [evidence.teamId, evidence.providerCustomerId, evidence.providerSubscriptionId, evidence.providerEventId]);
    const sql = transaction.dialect.sql;
    let changed = false;

    const customer = await transaction.prepare(sql(
      "SELECT * FROM [sporades_team_billing_customers] WHERE [teamId] = ? OR [providerCustomerId] = ?",
    )).all(evidence.teamId, evidence.providerCustomerId);
    if (customer.length > 1 || (customer[0] && !same(customer[0], {
      teamId: evidence.teamId, mode: evidence.mode, providerCustomerId: evidence.providerCustomerId,
    }))) throw conflict();
    if (!customer[0]) {
      await transaction.prepare(sql(
        "INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, ?, ?, ?, ?)",
      )).run(evidence.teamId, evidence.mode, evidence.providerCustomerId, evidence.providerObservedAt, evidence.providerObservedAt);
      changed = true;
    }

    const subscription = await transaction.prepare(sql(
      "SELECT * FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ? OR [providerSubscriptionId] = ?",
    )).all(evidence.teamId, evidence.providerSubscriptionId);
    const expectedSubscription = {
      teamId: evidence.teamId,
      mode: evidence.mode,
      providerSubscriptionId: evidence.providerSubscriptionId,
      providerPriceId: evidence.providerPriceId,
      providerSubscriptionItemId: evidence.providerSubscriptionItemId,
      productKey: evidence.productKey,
      quantity: evidence.quantity,
      state: evidence.state,
      cancelAtPeriodEnd: evidence.cancelAtPeriodEnd ? 1 : 0,
      currentPeriodStart: evidence.currentPeriodStart,
      currentPeriodEnd: evidence.currentPeriodEnd,
      observedAt: evidence.providerObservedAt,
      lastEventOccurredAt: evidence.providerObservedAt,
      lastEventKind: semantics.kind,
      lastEventRank: semantics.rank,
      terminalLatch: semantics.terminalLatch,
    };
    if (subscription.length > 1 || (subscription[0] && !same(subscription[0], expectedSubscription))) throw conflict();
    if (!subscription[0]) {
      await transaction.prepare(sql(
        "INSERT INTO [sporades_team_billing_subscriptions] " +
        "([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [providerSubscriptionItemId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [currentPeriodStart], [currentPeriodEnd], [observedAt], [updatedAt], [lastEventOccurredAt], [lastEventKind], [lastEventRank], [terminalLatch]) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )).run(stableId("legacy-subscription", evidence.providerSubscriptionId), evidence.teamId, evidence.mode,
        evidence.providerSubscriptionId, evidence.providerPriceId, evidence.providerSubscriptionItemId,
        evidence.productKey, evidence.quantity, evidence.state, evidence.cancelAtPeriodEnd ? 1 : 0,
        evidence.currentPeriodStart, evidence.currentPeriodEnd, evidence.providerObservedAt, evidence.providerObservedAt,
        evidence.providerObservedAt, semantics.kind, semantics.rank, semantics.terminalLatch);
      changed = true;
    }

    const observation = await transaction.prepare(sql(
      "SELECT * FROM [sporades_team_billing_observations] WHERE [providerEventId] = ?",
    )).get(evidence.providerEventId);
    const expectedObservation = {
      teamId: evidence.teamId,
      mode: evidence.mode,
      providerEventId: evidence.providerEventId,
      providerObjectId: evidence.providerSubscriptionId,
      payloadDigest: evidence.providerEventDigest,
      observedAt: evidence.providerObservedAt,
      eventType: evidence.providerEventType,
      eventRank: semantics.rank,
      outcome: "applied",
      safeReason: null,
    };
    if (observation && !same(observation, expectedObservation)) throw conflict();
    if (!observation) {
      await transaction.prepare(sql(
        "INSERT INTO [sporades_team_billing_observations] ([id], [teamId], [mode], [providerEventId], [providerObjectId], [payloadDigest], [observedAt], [createdAt], [eventType], [eventRank], [outcome], [safeReason]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', NULL)",
      )).run(stableId("legacy-observation", evidence.providerEventId), evidence.teamId, evidence.mode,
        evidence.providerEventId, evidence.providerSubscriptionId, evidence.providerEventDigest,
        evidence.providerObservedAt, evidence.providerObservedAt, evidence.providerEventType, semantics.rank);
      changed = true;
    }

    const replay = await transaction.prepare(sql(
      "SELECT * FROM [sporades_team_billing_replay] WHERE [providerEventId] = ?",
    )).get(evidence.providerEventId);
    if (replay && !same(replay, {
      providerEventId: evidence.providerEventId,
      payloadDigest: evidence.providerEventDigest,
      settledAt: evidence.providerObservedAt,
      retainedUntil: evidence.retainedUntil,
    })) throw conflict();
    if (!replay) {
      await transaction.prepare(sql(
        "INSERT INTO [sporades_team_billing_replay] ([providerEventId], [payloadDigest], [settledAt], [retainedUntil]) VALUES (?, ?, ?, ?)",
      )).run(evidence.providerEventId, evidence.providerEventDigest, evidence.providerObservedAt, evidence.retainedUntil);
      changed = true;
    }
    return Object.freeze({ outcome: changed ? "imported" : "unchanged" });
  });
}

function validate(input: LegacyTeamBillingEvidence): LegacyTeamBillingEvidence {
  if (!input || typeof input !== "object" || Object.keys(input).sort().join(",") !== [
    "cancelAtPeriodEnd", "currentPeriodEnd", "currentPeriodStart", "mode", "productKey", "providerCustomerId",
    "providerEventDigest", "providerEventId", "providerEventType", "providerObservedAt", "providerPriceId",
    "providerSubscriptionId", "providerSubscriptionItemId", "quantity", "retainedUntil", "sourceKey", "state", "teamId",
  ].sort().join(",")
    || typeof input.sourceKey !== "string" || input.sourceKey.length < 1 || input.sourceKey.length > 256
    || !TEAM_ID.test(input.teamId) || !["sandbox", "live"].includes(input.mode)
    || ![input.providerCustomerId, input.providerSubscriptionId, input.providerSubscriptionItemId, input.providerPriceId, input.providerEventId].every((value) => PROVIDER_ID.test(value))
    || !PRODUCT_KEY.test(input.productKey) || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 999_999
    || !["active", "past-due", "cancelled"].includes(input.state) || typeof input.cancelAtPeriodEnd !== "boolean"
    || !nullableTime(input.currentPeriodStart) || !nullableTime(input.currentPeriodEnd)
    || typeof input.providerEventType !== "string" || !/^customer\.subscription\.(?:created|updated|deleted)$/.test(input.providerEventType)
    || !teamBillingSubscriptionSemantics(input.providerEventType, input.state, input.cancelAtPeriodEnd)
    || typeof input.providerEventDigest !== "string" || input.providerEventDigest.length < 16 || input.providerEventDigest.length > 256
    || !canonicalTime(input.providerObservedAt) || !canonicalTime(input.retainedUntil)
    || input.retainedUntil <= input.providerObservedAt) throw invalid();
  return Object.freeze({ ...input });
}

function canonicalTime(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_TIME.test(value) && new Date(value).toISOString() === value;
}

function nullableTime(value: unknown): value is string | null {
  return value === null || canonicalTime(value);
}

function same(row: LooseRecord, expected: LooseRecord) {
  return Object.entries(expected).every(([key, value]) => row[key] === value || (typeof value === "number" && Number(row[key]) === value));
}

function stableId(prefix: string, value: string) {
  return `${prefix}-${createHash("sha256").update(value).digest("base64url").slice(0, 30)}`;
}

function invalid() {
  return coded("Legacy Team Billing evidence is incomplete or invalid.", "TEAM_BILLING_IMPORT_INVALID");
}

function conflict() {
  return coded("Legacy Team Billing evidence conflicts with existing Sporades state.", "TEAM_BILLING_IMPORT_CONFLICT");
}

function coded(message: string, code: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

async function lockImportIdentities(transaction: LooseRecord, identities: string[]) {
  if (transaction.dialect?.name !== "postgres") return;
  for (const identity of [...new Set(identities)].sort()) {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`sporades-team-billing-import:${identity}`);
  }
}

async function ensureImportStorage(adapter: LooseRecord) {
  if (adapter.dialect?.name !== "postgres") {
    await createTeamBillingTables(adapter);
    return;
  }
  await adapter.withTransaction(async (transaction: LooseRecord) => {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get("sporades-team-billing-import:storage");
    await createTeamBillingTables(transaction);
  });
}
