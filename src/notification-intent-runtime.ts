import { createHash, randomUUID } from "node:crypto";

type RecordValue = Record<string, any>;

export const NOTIFICATION_RESERVATION_MS = 30_000;
export const NOTIFICATION_MAX_BACKOFF_MS = 3_600_000;

export const notificationIntentSchemas = [
  {
    table: "sporades_notification_intents",
    columns: ["resourceTable", "resourceId", "operationId", "intentId", "payloadDigest", "payloadJson", "messageId", "acceptedAt"],
    primaryKey: ["resourceTable", "resourceId", "operationId", "intentId"],
    definition: "[resourceTable] TEXT NOT NULL, [resourceId] TEXT NOT NULL, [operationId] TEXT NOT NULL, [intentId] TEXT NOT NULL, [payloadDigest] TEXT NOT NULL, [payloadJson] TEXT NOT NULL, [messageId] TEXT NOT NULL, [acceptedAt] TEXT NOT NULL, PRIMARY KEY ([resourceTable], [resourceId], [operationId], [intentId])",
  },
  {
    table: "sporades_notification_recipients",
    columns: ["resourceTable", "resourceId", "operationId", "intentId", "recipient", "state", "attemptCount", "currentAttemptToken", "currentAttemptDeadline", "nextAttemptAt", "lastOutcomeCategory", "updatedAt"],
    primaryKey: ["resourceTable", "resourceId", "operationId", "intentId", "recipient"],
    definition: "[resourceTable] TEXT NOT NULL, [resourceId] TEXT NOT NULL, [operationId] TEXT NOT NULL, [intentId] TEXT NOT NULL, [recipient] TEXT NOT NULL, [state] TEXT NOT NULL, [attemptCount] TEXT NOT NULL, [currentAttemptToken] TEXT NOT NULL, [currentAttemptDeadline] TEXT NOT NULL, [nextAttemptAt] TEXT NOT NULL, [lastOutcomeCategory] TEXT NOT NULL, [updatedAt] TEXT NOT NULL, PRIMARY KEY ([resourceTable], [resourceId], [operationId], [intentId], [recipient])",
  },
  {
    table: "sporades_notification_attempts",
    columns: ["resourceTable", "resourceId", "operationId", "intentId", "recipient", "attemptToken", "sequence", "reservedAt", "deadline", "completedAt", "outcomeCategory"],
    primaryKey: ["resourceTable", "resourceId", "operationId", "intentId", "recipient", "attemptToken"],
    definition: "[resourceTable] TEXT NOT NULL, [resourceId] TEXT NOT NULL, [operationId] TEXT NOT NULL, [intentId] TEXT NOT NULL, [recipient] TEXT NOT NULL, [attemptToken] TEXT NOT NULL, [sequence] TEXT NOT NULL, [reservedAt] TEXT NOT NULL, [deadline] TEXT NOT NULL, [completedAt] TEXT NOT NULL, [outcomeCategory] TEXT NOT NULL, PRIMARY KEY ([resourceTable], [resourceId], [operationId], [intentId], [recipient], [attemptToken])",
  },
] as const;

const sql = (adapter: RecordValue, statement: string) => adapter.dialect.sql(statement);

export async function ensureNotificationIntentStorage(adapter: RecordValue) {
  if (adapter.engine === "postgres") {
    const bootstrap = (adapter as any)[Symbol.for("sporades.database.resourceBootstrapMechanics")];
    if (typeof bootstrap !== "function") throw Object.assign(new Error("Resource operation could not complete."), { code: "RESOURCE_ADAPTER_UNSUPPORTED" });
    await bootstrap();
    return;
  }
  for (const schema of notificationIntentSchemas) {
    await adapter.exec(sql(adapter, `CREATE TABLE IF NOT EXISTS [${schema.table}] (${schema.definition})`));
  }
}

export async function notificationIntentStorageExists(adapter: RecordValue) {
  if (adapter.engine === "postgres") {
    const row = await adapter.prepare("SELECT to_regclass('sporades_notification_intents') AS present").get();
    return Boolean(row?.present);
  }
  const row = await adapter.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name='sporades_notification_intents'").get();
  return Number(row?.n ?? 0) === 1;
}

function exactPlainObject(input: any, allowed: string[]) {
  return input && Object.getPrototypeOf(input) === Object.prototype
    && Object.getOwnPropertySymbols(input).length === 0
    && Object.values(Object.getOwnPropertyDescriptors(input)).every((descriptor: any) => Object.hasOwn(descriptor, "value"))
    && Object.keys(input).sort().join(",") === allowed.sort().join(",");
}

export async function stageNotificationIntent(
  adapter: RecordValue,
  database: RecordValue,
  identity: RecordValue,
  input: any,
  canonicalJson: (value: unknown) => string,
) {
  const invalid = () => { throw Object.assign(new Error("Resource operation could not complete."), { code: "RESOURCE_INVALID_INPUT" }); };
  if (!database.mail?.enabled) throw Object.assign(new Error("Resource operation could not complete."), { code: "RESOURCE_EFFECT_UNSUPPORTED" });
  const allowed = input?.html === undefined ? ["id", "subject", "text", "to"] : ["html", "id", "subject", "text", "to"];
  if (!exactPlainObject(input, allowed)) invalid();
  if (typeof input.id !== "string" || input.id.length === 0 || Buffer.byteLength(input.id, "utf8") > 128) invalid();
  if (!Array.isArray(input.to) || input.to.length < 1 || input.to.length > 100 || input.to.some((value: any) => typeof value !== "string")) invalid();
  if (typeof input.subject !== "string" || typeof input.text !== "string" || (input.html !== undefined && typeof input.html !== "string")) invalid();
  if (input.text.length === 0 && (input.html === undefined || input.html.length === 0)) invalid();
  let normalized: any;
  try { normalized = database.mail.validateIntent(input); }
  catch (error: any) {
    if (error?.code === "MAIL_DISABLED" || error?.code === "MAIL_CREDENTIAL_MISSING") {
      throw Object.assign(new Error("Resource operation could not complete."), { code: "RESOURCE_EFFECT_UNSUPPORTED" });
    }
    invalid();
  }
  if (normalized.to.length !== input.to.length) invalid();
  const payload = { id: input.id, to: normalized.to.map((entry: any) => entry.email), subject: normalized.subject,
    text: input.text, ...(input.html === undefined ? {} : { html: input.html }) };
  const payloadJson = canonicalJson(payload);
  if (Buffer.byteLength(payloadJson, "utf8") > 65_536) invalid();
  const payloadDigest = createHash("sha256").update(payloadJson).digest("hex");
  const key = [identity.table, identity.id, identity.operationId, input.id];
  const existing = await adapter.prepare(sql(adapter, "SELECT [payloadDigest] FROM [sporades_notification_intents] WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=?" )).get(...key);
  if (existing) {
    const digest = existing.payloadDigest ?? existing.payloaddigest;
    if (digest !== payloadDigest) throw Object.assign(new Error("Resource operation could not complete."), { code: "RESOURCE_OPERATION_CONFLICT" });
    return { id: input.id, state: "staged" as const };
  }
  const acceptedAt = database.clock.now().toISOString();
  const messageId = `<${createHash("sha256").update(`${database.capsuleIdentity}\0${key.join("\0")}`).digest("hex")}@sporades.local>`;
  await adapter.prepare(sql(adapter, "INSERT INTO [sporades_notification_intents] ([resourceTable],[resourceId],[operationId],[intentId],[payloadDigest],[payloadJson],[messageId],[acceptedAt]) VALUES (?,?,?,?,?,?,?,?)"))
    .run(...key, payloadDigest, payloadJson, messageId, acceptedAt);
  for (const recipient of payload.to) {
    await adapter.prepare(sql(adapter, "INSERT INTO [sporades_notification_recipients] ([resourceTable],[resourceId],[operationId],[intentId],[recipient],[state],[attemptCount],[currentAttemptToken],[currentAttemptDeadline],[nextAttemptAt],[lastOutcomeCategory],[updatedAt]) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"))
      .run(...key, recipient, "accepted", "0", "", "", acceptedAt, "", acceptedAt);
  }
  return { id: input.id, state: "staged" as const };
}

export async function readNotificationIntentStatuses(adapter: RecordValue, identity: RecordValue, intentIds: string[]) {
  const intents = [];
  for (const intentId of intentIds) {
    const recipients = await adapter.prepare(sql(adapter, "SELECT [recipient],[state],[attemptCount],[nextAttemptAt],[lastOutcomeCategory] FROM [sporades_notification_recipients] WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=? ORDER BY [recipient]"))
      .all(identity.table, identity.id, identity.operationId, intentId);
    const publicRecipients = recipients.map((row: any) => ({
      recipient: row.recipient,
      state: row.state,
      attemptCount: Number(row.attemptCount ?? row.attemptcount ?? 0),
      nextAttemptAt: (row.nextAttemptAt ?? row.nextattemptat) || null,
      lastOutcomeCategory: (row.lastOutcomeCategory ?? row.lastoutcomecategory) || null,
    }));
    const pending = publicRecipients.some((row: any) => ["accepted", "submitting", "unknown", "retry-wait"].includes(row.state));
    const allAcknowledged = publicRecipients.length > 0 && publicRecipients.every((row: any) => row.state === "acknowledged");
    intents.push({ id: intentId, state: pending ? "pending" : allAcknowledged ? "acknowledged" : "rejected", recipients: publicRecipients });
  }
  return intents;
}

export function notificationRetryDelay(attemptNumber: number) {
  return Math.min(30_000 * (2 ** Math.min(Math.max(1, attemptNumber) - 1, 7)), NOTIFICATION_MAX_BACKOFF_MS);
}

const recipientKey = (row: any) => [row.resourceTable ?? row.resourcetable, row.resourceId ?? row.resourceid,
  row.operationId ?? row.operationid, row.intentId ?? row.intentid, row.recipient];

async function recoverExpiredReservations(database: RecordValue, now: Date) {
  await database.adapter.withTransaction(async (tx: RecordValue) => {
    const expired = await tx.prepare(sql(tx, "SELECT * FROM [sporades_notification_recipients] WHERE [state]='submitting' AND [currentAttemptDeadline]<>'' AND [currentAttemptDeadline]<=? ORDER BY [currentAttemptDeadline]" )).all(now.toISOString());
    for (const row of expired) {
      const key = recipientKey(row); const token = row.currentAttemptToken ?? row.currentattempttoken;
      const attempt = Number(row.attemptCount ?? row.attemptcount);
      const next = new Date(now.getTime() + notificationRetryDelay(attempt)).toISOString();
      await tx.prepare(sql(tx, "UPDATE [sporades_notification_attempts] SET [completedAt]=?,[outcomeCategory]='unknown' WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=? AND [recipient]=? AND [attemptToken]=? AND [outcomeCategory]='submitting'"))
        .run(now.toISOString(), ...key, token);
      await tx.prepare(sql(tx, "UPDATE [sporades_notification_recipients] SET [state]='unknown',[currentAttemptToken]='',[currentAttemptDeadline]='',[nextAttemptAt]=?,[lastOutcomeCategory]='unknown',[updatedAt]=? WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=? AND [recipient]=? AND [state]='submitting' AND [currentAttemptToken]=?"))
        .run(next, now.toISOString(), ...key, token);
    }
  });
}

async function moveUnknownRecipientsToRetryWait(database: RecordValue) {
  await database.adapter.prepare(sql(database.adapter,
    "UPDATE [sporades_notification_recipients] SET [state]='retry-wait' WHERE [state]='unknown'" )).run();
}

async function reserveDueRecipient(database: RecordValue, now: Date) {
  return database.adapter.withTransaction(async (tx: RecordValue) => {
    const row = await tx.prepare(sql(tx, "SELECT * FROM [sporades_notification_recipients] WHERE [state] IN ('accepted','retry-wait','unknown') AND [nextAttemptAt]<=? ORDER BY [nextAttemptAt],[resourceTable],[resourceId],[operationId],[intentId],[recipient] LIMIT 1" )).get(now.toISOString());
    if (!row) return null;
    const key = recipientKey(row); const token = randomUUID();
    const sequence = Number(row.attemptCount ?? row.attemptcount) + 1;
    const deadline = new Date(now.getTime() + NOTIFICATION_RESERVATION_MS).toISOString();
    const changed = await tx.prepare(sql(tx, "UPDATE [sporades_notification_recipients] SET [state]='submitting',[attemptCount]=?,[currentAttemptToken]=?,[currentAttemptDeadline]=?,[nextAttemptAt]='',[lastOutcomeCategory]='',[updatedAt]=? WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=? AND [recipient]=? AND [state] IN ('accepted','retry-wait','unknown') AND [nextAttemptAt]<=?"))
      .run(String(sequence), token, deadline, now.toISOString(), ...key, now.toISOString());
    if (Number(changed?.changes ?? 0) !== 1) return null;
    await tx.prepare(sql(tx, "INSERT INTO [sporades_notification_attempts] ([resourceTable],[resourceId],[operationId],[intentId],[recipient],[attemptToken],[sequence],[reservedAt],[deadline],[completedAt],[outcomeCategory]) VALUES (?,?,?,?,?,?,?,?,?,?,?)"))
      .run(...key, token, String(sequence), now.toISOString(), deadline, "", "submitting");
    const intent = await tx.prepare(sql(tx, "SELECT [payloadJson],[messageId] FROM [sporades_notification_intents] WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=?" )).get(...key.slice(0, 4));
    if (!intent) throw new Error("notification intent missing");
    return { key, token, sequence, deadline, recipient: row.recipient,
      payload: JSON.parse(intent.payloadJson ?? intent.payloadjson), messageId: intent.messageId ?? intent.messageid };
  });
}

async function reservationIsCurrent(database: RecordValue, reservation: RecordValue) {
  const row = await database.adapter.prepare(sql(database.adapter, "SELECT [state],[currentAttemptToken] FROM [sporades_notification_recipients] WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=? AND [recipient]=?" )).get(...reservation.key);
  return row?.state === "submitting" && (row.currentAttemptToken ?? row.currentattempttoken) === reservation.token;
}

async function settleAttempt(database: RecordValue, reservation: RecordValue, outcome: "acknowledged" | "rejected" | "unknown") {
  const now = database.clock.now();
  await database.adapter.withTransaction(async (tx: RecordValue) => {
    const unfinishedOnly = outcome === "acknowledged" ? "" : " AND [outcomeCategory]='submitting'";
    await tx.prepare(sql(tx, `UPDATE [sporades_notification_attempts] SET [completedAt]=?,[outcomeCategory]=? WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=? AND [recipient]=? AND [attemptToken]=?${unfinishedOnly}`))
      .run(now.toISOString(), outcome, ...reservation.key, reservation.token);
    if (outcome === "acknowledged") {
      // A positive DATA acknowledgement from any recorded attempt is monotonic.
      await tx.prepare(sql(tx, "UPDATE [sporades_notification_recipients] SET [state]='acknowledged',[currentAttemptToken]='',[currentAttemptDeadline]='',[nextAttemptAt]='',[lastOutcomeCategory]='acknowledged',[updatedAt]=? WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=? AND [recipient]=? AND [state]<>'acknowledged' AND EXISTS (SELECT 1 FROM [sporades_notification_attempts] WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=? AND [recipient]=? AND [attemptToken]=?)"))
        .run(now.toISOString(), ...reservation.key, ...reservation.key, reservation.token);
      return;
    }
    const state = outcome === "rejected" ? "rejected" : "unknown";
    const next = outcome === "unknown" ? new Date(now.getTime() + notificationRetryDelay(reservation.sequence)).toISOString() : "";
    await tx.prepare(sql(tx, "UPDATE [sporades_notification_recipients] SET [state]=?,[currentAttemptToken]='',[currentAttemptDeadline]='',[nextAttemptAt]=?,[lastOutcomeCategory]=?,[updatedAt]=? WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=? AND [recipient]=? AND [state]='submitting' AND [currentAttemptToken]=?"))
      .run(state, next, outcome, now.toISOString(), ...reservation.key, reservation.token);
  });
}

export async function runNotificationIntentDeliveryPass(database: RecordValue) {
  // Init publishes the complete schema when mail is configured. A restart
  // without mail can still drain (and terminally reject) already-durable
  // intents, but must not couple that scan back to unrelated resource-table
  // validation: the intent tables themselves are the worker's authority.
  await recoverExpiredReservations(database, database.clock.now());
  await moveUnknownRecipientsToRetryWait(database);
  const reservation = await reserveDueRecipient(database, database.clock.now());
  if (!reservation) return false;
  await database.notificationIntentFault?.("after-reservation", reservation);
  if (!await reservationIsCurrent(database, reservation)) return true;
  await database.notificationIntentFault?.("before-submit", reservation);
  try {
    await database.mail.sendIntent({ ...reservation.payload, to: [reservation.recipient] }, reservation.messageId,
      (event: RecordValue) => database.log?.emit(event));
    await database.notificationIntentFault?.("after-submit", reservation);
    await settleAttempt(database, reservation, "acknowledged");
  } catch (error: any) {
    if (error?.notificationIntentCrash === true) throw error;
    const outcome = error?.smtpOutcome === "rejected" ? "rejected" : "unknown";
    await settleAttempt(database, reservation, outcome);
    if (outcome === "unknown") await moveUnknownRecipientsToRetryWait(database);
  }
  return true;
}

async function nextWakeAt(database: RecordValue) {
  const row = await database.adapter.prepare(sql(database.adapter, "SELECT [nextAttemptAt],[currentAttemptDeadline] FROM [sporades_notification_recipients] WHERE [state] IN ('accepted','retry-wait','unknown','submitting') ORDER BY CASE WHEN [state]='submitting' THEN [currentAttemptDeadline] ELSE [nextAttemptAt] END LIMIT 1" )).get();
  return row ? ((row.currentAttemptDeadline ?? row.currentattemptdeadline) || (row.nextAttemptAt ?? row.nextattemptat)) : null;
}

export function startNotificationIntentWorker(database: RecordValue) {
  database.__notificationIntentStopped = false;
  const scheduleRecoveryScan = () => {
    if (database.__notificationIntentStopped || database.__notificationIntentTimer) return;
    const timer: any = setTimeout(() => {
      database.__notificationIntentTimer = null;
      void run().catch(() => {});
    }, 30_000);
    timer.unref?.();
    database.__notificationIntentTimer = timer;
    database.__notificationIntentNativeTimer = true;
  };
  const run = async () => {
    if (database.__notificationIntentStopped || database.__notificationIntentWorkerPromise) return;
    const work = (async () => {
      try {
        while (!database.__notificationIntentStopped && await runNotificationIntentDeliveryPass(database)) {}
        if (database.__notificationIntentStopped) return;
        const wakeAt = await nextWakeAt(database);
      // Durable scanning, not a volatile post-commit notification, is the
      // authority. An unref'ed native idle poll discovers commits made by a
      // different process without making a virtual application clock perform
      // unexpected storage work when tests or operators advance it.
        if (!wakeAt) scheduleRecoveryScan();
        else {
          const delay = Math.max(0, Date.parse(wakeAt) - database.clock.now().getTime());
          database.__notificationIntentTimer = database.clock.setTimer(() => {
            database.__notificationIntentTimer = null; void run().catch(() => {});
          }, delay);
          database.__notificationIntentNativeTimer = false;
        }
      } catch (error) {
        scheduleRecoveryScan();
        throw error;
      }
    })();
    database.__notificationIntentWorkerPromise = work;
    try { await work; }
    finally { if (database.__notificationIntentWorkerPromise === work) database.__notificationIntentWorkerPromise = null; }
  };
  return run();
}

export function stopNotificationIntentWorker(database: RecordValue) {
  database.__notificationIntentStopped = true;
  if (database.__notificationIntentTimer) {
    if (database.__notificationIntentNativeTimer) clearTimeout(database.__notificationIntentTimer);
    else database.clock.clearTimer(database.__notificationIntentTimer);
  }
  database.__notificationIntentTimer = null;
  database.__notificationIntentNativeTimer = false;
  return database.__notificationIntentWorkerPromise;
}
