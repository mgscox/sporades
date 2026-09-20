import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

type RecordValue = Record<string, any>;

export const NOTIFICATION_RESERVATION_MS = 30_000;
export const NOTIFICATION_RECOVERY_SCAN_MS = 30_000;
export const NOTIFICATION_MAX_BACKOFF_MS = 3_600_000;
// A single-recipient sendIntent conversation exchanges at most: greeting,
// EHLO, STARTTLS, EHLO again, up to 3 AUTH LOGIN steps, MAIL FROM, RCPT TO,
// DATA and its final response after the connect itself — 12 socket-timeout-
// bounded reads. The reservation must outlive that worst case, or a live (not
// crashed) send on a slow-but-configured-that-way server gets treated as
// abandoned and reserved again elsewhere while still in flight.
const NOTIFICATION_SMTP_ROUNDTRIP_MARGIN = 12;

export const notificationIntentSchemas = [
  {
    table: "sporades_notification_intents",
    columns: ["resourceTable", "resourceId", "operationId", "intentId", "payloadDigest", "payloadJson", "messageId", "acceptedAt"],
    primaryKey: ["resourceTable", "resourceId", "operationId", "intentId"],
    indexes: [],
    definition: "[resourceTable] TEXT NOT NULL, [resourceId] TEXT NOT NULL, [operationId] TEXT NOT NULL, [intentId] TEXT NOT NULL, [payloadDigest] TEXT NOT NULL, [payloadJson] TEXT NOT NULL, [messageId] TEXT NOT NULL, [acceptedAt] TEXT NOT NULL, PRIMARY KEY ([resourceTable], [resourceId], [operationId], [intentId])",
  },
  {
    table: "sporades_notification_recipients",
    columns: ["resourceTable", "resourceId", "operationId", "intentId", "recipient", "state", "attemptCount", "currentAttemptToken", "currentAttemptDeadline", "nextAttemptAt", "lastOutcomeCategory", "updatedAt"],
    primaryKey: ["resourceTable", "resourceId", "operationId", "intentId", "recipient"],
    indexes: [
      { name: "sporades_notification_recipients_due", columns: ["state", "nextAttemptAt", "resourceTable", "resourceId", "operationId", "intentId", "recipient"] },
      { name: "sporades_notification_recipients_reservations", columns: ["state", "currentAttemptDeadline", "resourceTable", "resourceId", "operationId", "intentId", "recipient"] },
    ],
    definition: "[resourceTable] TEXT NOT NULL, [resourceId] TEXT NOT NULL, [operationId] TEXT NOT NULL, [intentId] TEXT NOT NULL, [recipient] TEXT NOT NULL, [state] TEXT NOT NULL, [attemptCount] TEXT NOT NULL, [currentAttemptToken] TEXT NOT NULL, [currentAttemptDeadline] TEXT NOT NULL, [nextAttemptAt] TEXT NOT NULL, [lastOutcomeCategory] TEXT NOT NULL, [updatedAt] TEXT NOT NULL, PRIMARY KEY ([resourceTable], [resourceId], [operationId], [intentId], [recipient])",
  },
  {
    table: "sporades_notification_attempts",
    columns: ["resourceTable", "resourceId", "operationId", "intentId", "recipient", "attemptToken", "sequence", "reservedAt", "deadline", "completedAt", "outcomeCategory"],
    primaryKey: ["resourceTable", "resourceId", "operationId", "intentId", "recipient", "attemptToken"],
    indexes: [],
    definition: "[resourceTable] TEXT NOT NULL, [resourceId] TEXT NOT NULL, [operationId] TEXT NOT NULL, [intentId] TEXT NOT NULL, [recipient] TEXT NOT NULL, [attemptToken] TEXT NOT NULL, [sequence] TEXT NOT NULL, [reservedAt] TEXT NOT NULL, [deadline] TEXT NOT NULL, [completedAt] TEXT NOT NULL, [outcomeCategory] TEXT NOT NULL, PRIMARY KEY ([resourceTable], [resourceId], [operationId], [intentId], [recipient], [attemptToken])",
  },
  {
    table: "sporades_notification_attempt_keys",
    columns: ["resourceTable", "resourceId", "operationId", "intentId", "attemptKey"],
    primaryKey: ["resourceTable", "resourceId", "operationId", "intentId"],
    indexes: [],
    definition: "[resourceTable] TEXT NOT NULL, [resourceId] TEXT NOT NULL, [operationId] TEXT NOT NULL, [intentId] TEXT NOT NULL, [attemptKey] TEXT NOT NULL, PRIMARY KEY ([resourceTable], [resourceId], [operationId], [intentId])",
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
    for (const index of schema.indexes) {
      await adapter.exec(sql(adapter, `CREATE INDEX IF NOT EXISTS [${index.name}] ON [${schema.table}] (${index.columns.map(column => `[${column}]`).join(", ")})`));
    }
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
  const allowed = Object.hasOwn(input ?? {}, "html") ? ["html", "id", "subject", "text", "to"] : ["id", "subject", "text", "to"];
  if (!exactPlainObject(input, allowed)) invalid();
  if (typeof input.id !== "string" || input.id.length === 0 || Buffer.byteLength(input.id, "utf8") > 128
    || Buffer.from(input.id, "utf8").toString("utf8") !== input.id) invalid();
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
  const recipients = normalized.to.map((entry: any) => entry.email);
  // One recipient row per address is the durable identity. A repeated address
  // would violate the recipient primary key mid-insert, and that engine error
  // normalizes to an opaque terminal RESOURCE_STORAGE_ERROR that poisons the
  // whole enclosing transaction. Reject it here as ordinary invalid input.
  if (new Set(recipients).size !== recipients.length) invalid();
  const payload = { id: input.id, to: recipients, subject: normalized.subject,
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
  const messageId = `<${randomUUID()}@sporades.local>`;
  const inserted = await adapter.prepare(sql(adapter, "INSERT INTO [sporades_notification_intents] ([resourceTable],[resourceId],[operationId],[intentId],[payloadDigest],[payloadJson],[messageId],[acceptedAt]) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT ([resourceTable],[resourceId],[operationId],[intentId]) DO NOTHING"))
    .run(...key, payloadDigest, payloadJson, messageId, acceptedAt);
  if (inserted.changes === 0) {
    const raced = await adapter.prepare(sql(adapter, "SELECT [payloadDigest] FROM [sporades_notification_intents] WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=?" )).get(...key);
    const digest = raced?.payloadDigest ?? raced?.payloaddigest;
    if (digest !== payloadDigest) throw Object.assign(new Error("Resource operation could not complete."), { code: "RESOURCE_OPERATION_CONFLICT" });
    return { id: input.id, state: "staged" as const };
  }
  await adapter.prepare(sql(adapter, "INSERT INTO [sporades_notification_attempt_keys] ([resourceTable],[resourceId],[operationId],[intentId],[attemptKey]) VALUES (?,?,?,?,?)"))
    .run(...key, randomBytes(32).toString("hex"));
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

function notificationAttemptToken(attemptKey: string, key: any[], sequence: number, messageId: string, nonce: string = randomUUID()) {
  const authenticator = createHmac("sha256", attemptKey)
    .update([...key, String(sequence), messageId, nonce].join("\0"))
    .digest("hex");
  return `${nonce}.${authenticator}`;
}

function notificationAttemptTokenIsValid(attemptKey: string, reservation: RecordValue, messageId: string) {
  const token = String(reservation.token ?? "");
  const separator = token.indexOf(".");
  if (separator < 1 || token.indexOf(".", separator + 1) !== -1) return false;
  const nonce = token.slice(0, separator); const actual = token.slice(separator + 1);
  if (!/^[0-9a-f-]{36}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(actual)) return false;
  const expected = notificationAttemptToken(attemptKey, reservation.key, reservation.sequence, messageId, nonce).slice(separator + 1);
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

async function notificationAttemptKey(adapter: RecordValue, key: any[]) {
  const select = () => adapter.prepare(sql(adapter, "SELECT [attemptKey] FROM [sporades_notification_attempt_keys] WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=?" )).get(...key.slice(0, 4));
  let row = await select();
  if (!row) {
    await adapter.prepare(sql(adapter, "INSERT INTO [sporades_notification_attempt_keys] ([resourceTable],[resourceId],[operationId],[intentId],[attemptKey]) VALUES (?,?,?,?,?) ON CONFLICT ([resourceTable],[resourceId],[operationId],[intentId]) DO NOTHING"))
      .run(...key.slice(0, 4), randomBytes(32).toString("hex"));
    row = await select();
  }
  const attemptKey = row?.attemptKey ?? row?.attemptkey;
  if (typeof attemptKey !== "string" || !/^[0-9a-f]{64}$/.test(attemptKey)) throw new Error("notification attempt key missing");
  return attemptKey;
}

async function recoverExpiredReservations(database: RecordValue, now: Date) {
  await database.adapter.withTransaction(async (tx: RecordValue) => {
    const expired = await tx.prepare(sql(tx, "SELECT * FROM [sporades_notification_recipients] WHERE [state]='submitting' AND [currentAttemptDeadline]<>'' AND [currentAttemptDeadline]<=? ORDER BY [currentAttemptDeadline]" )).all(now.toISOString());
    for (const row of expired) {
      const key = recipientKey(row); const token = row.currentAttemptToken ?? row.currentattempttoken;
      const attempt = Number(row.attemptCount ?? row.attemptcount);
      const next = new Date(now.getTime() + notificationRetryDelay(attempt)).toISOString();
      await tx.prepare(sql(tx, "UPDATE [sporades_notification_attempts] SET [completedAt]=?,[outcomeCategory]='unknown' WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=? AND [recipient]=? AND [attemptToken]=? AND [outcomeCategory]='submitting'"))
        .run(now.toISOString(), ...key, token);
      // The state lands directly on 'retry-wait' (not the transient 'unknown'
      // label): reservation and wake queries already treat both identically,
      // and setting it here — where the exact key is already known — avoids a
      // separate unfiltered UPDATE...WHERE [state]='unknown' full-table scan
      // once per pass to normalize it (the [sporades_notification_recipients]
      // schema carries no secondary index; the PostgreSQL schema verifier
      // rejects any beyond the primary key).
      await tx.prepare(sql(tx, "UPDATE [sporades_notification_recipients] SET [state]='retry-wait',[currentAttemptToken]='',[currentAttemptDeadline]='',[nextAttemptAt]=?,[lastOutcomeCategory]='unknown',[updatedAt]=? WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=? AND [recipient]=? AND [state]='submitting' AND [currentAttemptToken]=?"))
        .run(next, now.toISOString(), ...key, token);
    }
  });
}

function notificationReservationWindowMs(database: RecordValue) {
  const connectionTimeoutMs = Number(database.mail?.connectionTimeoutMs) || 0;
  const socketTimeoutMs = Number(database.mail?.socketTimeoutMs) || 0;
  return Math.max(NOTIFICATION_RESERVATION_MS, connectionTimeoutMs + socketTimeoutMs * NOTIFICATION_SMTP_ROUNDTRIP_MARGIN);
}

async function reserveDueRecipient(database: RecordValue, now: Date) {
  return database.adapter.withTransaction(async (tx: RecordValue) => {
    const row = await tx.prepare(sql(tx, "SELECT * FROM [sporades_notification_recipients] WHERE [state] IN ('accepted','retry-wait','unknown') AND [nextAttemptAt]<=? ORDER BY [nextAttemptAt],[resourceTable],[resourceId],[operationId],[intentId],[recipient] LIMIT 1" )).get(now.toISOString());
    if (!row) return null;
    const key = recipientKey(row);
    const sequence = Number(row.attemptCount ?? row.attemptcount) + 1;
    const deadline = new Date(now.getTime() + notificationReservationWindowMs(database)).toISOString();
    const intent = await tx.prepare(sql(tx, "SELECT [payloadJson],[messageId] FROM [sporades_notification_intents] WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=?" )).get(...key.slice(0, 4));
    if (!intent) throw new Error("notification intent missing");
    const messageId = intent.messageId ?? intent.messageid;
    const attemptKey = await notificationAttemptKey(tx, key);
    const token = notificationAttemptToken(attemptKey, key, sequence, messageId);
    const changed = await tx.prepare(sql(tx, "UPDATE [sporades_notification_recipients] SET [state]='submitting',[attemptCount]=?,[currentAttemptToken]=?,[currentAttemptDeadline]=?,[nextAttemptAt]='',[lastOutcomeCategory]='',[updatedAt]=? WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=? AND [recipient]=? AND [state] IN ('accepted','retry-wait','unknown') AND [nextAttemptAt]<=?"))
      .run(String(sequence), token, deadline, now.toISOString(), ...key, now.toISOString());
    if (Number(changed?.changes ?? 0) !== 1) return null;
    await tx.prepare(sql(tx, "INSERT INTO [sporades_notification_attempts] ([resourceTable],[resourceId],[operationId],[intentId],[recipient],[attemptToken],[sequence],[reservedAt],[deadline],[completedAt],[outcomeCategory]) VALUES (?,?,?,?,?,?,?,?,?,?,?)"))
      .run(...key, token, String(sequence), now.toISOString(), deadline, "", "submitting");
    // The recipient row is the durable retry ledger. The random attempt token is
    // self-authenticating against durable intent identity and sequence, so completed
    // diagnostics can be compacted without copying recipient PII into an unbounded
    // failure history or preventing an older live sender from reporting success.
    await tx.prepare(sql(tx, "DELETE FROM [sporades_notification_attempts] WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=? AND [recipient]=? AND [completedAt]<>'' AND [attemptToken]<>?"))
      .run(...key, token);
    return { key, token, sequence, deadline, recipient: row.recipient,
      payload: JSON.parse(intent.payloadJson ?? intent.payloadjson), messageId };
  });
}

async function reservationIsCurrent(database: RecordValue, reservation: RecordValue) {
  const row = await database.adapter.prepare(sql(database.adapter, "SELECT [state],[currentAttemptToken] FROM [sporades_notification_recipients] WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=? AND [recipient]=?" )).get(...reservation.key);
  return row?.state === "submitting" && (row.currentAttemptToken ?? row.currentattempttoken) === reservation.token;
}

async function settleAttempt(database: RecordValue, reservation: RecordValue, outcome: "acknowledged" | "rejected" | "unknown") {
  const now = database.clock.now();
  await database.adapter.withTransaction(async (tx: RecordValue) => {
    if (outcome === "acknowledged") {
      const intent = await tx.prepare(sql(tx, "SELECT [messageId] FROM [sporades_notification_intents] WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=?" )).get(...reservation.key.slice(0, 4));
      const messageId = intent?.messageId ?? intent?.messageid;
      const attemptKey = await notificationAttemptKey(tx, reservation.key);
      if (typeof messageId !== "string" || typeof attemptKey !== "string" || !notificationAttemptTokenIsValid(attemptKey, reservation, messageId)) return;
    }
    const unfinishedOnly = outcome === "acknowledged" ? "" : " AND [outcomeCategory]='submitting'";
    await tx.prepare(sql(tx, `UPDATE [sporades_notification_attempts] SET [completedAt]=?,[outcomeCategory]=? WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=? AND [recipient]=? AND [attemptToken]=?${unfinishedOnly}`))
      .run(now.toISOString(), outcome, ...reservation.key, reservation.token);
    if (outcome === "acknowledged") {
      // A positive DATA acknowledgement from any durably authenticated attempt is monotonic.
      await tx.prepare(sql(tx, "UPDATE [sporades_notification_recipients] SET [state]='acknowledged',[currentAttemptToken]='',[currentAttemptDeadline]='',[nextAttemptAt]='',[lastOutcomeCategory]='acknowledged',[updatedAt]=? WHERE [resourceTable]=? AND [resourceId]=? AND [operationId]=? AND [intentId]=? AND [recipient]=? AND [state]<>'acknowledged' AND CAST([attemptCount] AS INTEGER)>=?"))
        .run(now.toISOString(), ...reservation.key, reservation.sequence);
      return;
    }
    // 'unknown' settles straight to 'retry-wait' (the queryable state
    // reservation/wake already accept identically for it) rather than the
    // transient 'unknown' label a separate unfiltered UPDATE would otherwise
    // have to sweep on every pass; `lastOutcomeCategory` keeps reporting the
    // true outcome for observability.
    const state = outcome === "rejected" ? "rejected" : "retry-wait";
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
    }, NOTIFICATION_RECOVERY_SCAN_MS);
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
        // stopNotificationIntentWorker can land while the lookup above is in
        // flight; re-check before arming rather than trusting the check made
        // before that await, or a stop request loses the race and a timer
        // gets armed (and never cleared) after shutdown already ran.
        if (database.__notificationIntentStopped) return;
        // Durable scanning, not a volatile post-commit notification, is the
        // authority. An unref'ed native idle poll discovers commits made by a
        // different process without making a virtual application clock perform
        // unexpected storage work when tests or operators advance it.
        // The wake is bounded by that same poll: a recipient backed off by up
        // to NOTIFICATION_MAX_BACKOFF_MS must not shadow an intent committed a
        // second later whose nextAttemptAt is already past. Waits at or beyond
        // the recovery interval take the native poll, which rediscovers durable
        // work and recomputes the wake on every pass; only a nearer wake earns
        // its own application-clock timer.
        const delay = wakeAt ? Math.max(0, Date.parse(wakeAt) - database.clock.now().getTime()) : null;
        if (delay === null || !Number.isFinite(delay) || delay >= NOTIFICATION_RECOVERY_SCAN_MS) scheduleRecoveryScan();
        else {
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
