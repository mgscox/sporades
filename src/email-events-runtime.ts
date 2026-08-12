import { timingSafeEqual } from "node:crypto";

type LooseRecord = Record<string, any>;

const MAILJET_EVENT_KINDS: Record<string, string> = {
  sent: "delivered",
  open: "opened",
  click: "clicked",
  bounce: "bounced",
  blocked: "blocked",
  spam: "complained",
  unsub: "unsubscribed",
};

function text(value: unknown) {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function secureEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function mailjetBasicPassword(authorization: unknown) {
  if (typeof authorization !== "string" || !authorization.startsWith("Basic ")) return "";
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator < 0 ? "" : decoded.slice(separator + 1);
  } catch {
    return "";
  }
}

function verifiedMailjetRequest(ctx: LooseRecord, secret: string) {
  const token = text(ctx.request?.query?.token);
  const basicPassword = mailjetBasicPassword(ctx.request?.headers?.authorization);
  return (token.length > 0 && secureEqual(token, secret))
    || (basicPassword.length > 0 && secureEqual(basicPassword, secret));
}

function mailjetMessageIdentity(raw: LooseRecord) {
  return typeof raw.Message_GUID === "string" && raw.Message_GUID.trim()
    ? raw.Message_GUID.trim()
    : typeof raw.mj_message_id === "string" ? raw.mj_message_id.trim() : "";
}

function mailjetProviderEventId(raw: LooseRecord, event: string, seconds: number, identity: string) {
  const clickUrl = event === "click" ? `:${text(raw.url)}` : "";
  return `${event}:${identity}:${Math.trunc(seconds) || 0}${clickUrl}`;
}

function normalizeMailjetEvent(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const data = raw as LooseRecord;
  if (typeof data.event !== "string" || !data.event.trim()) return false;
  const providerKind = data.event.trim().toLowerCase();
  const kind = MAILJET_EVENT_KINDS[providerKind];
  if (!kind) return null;
  const seconds = Number(data.time);
  const identity = mailjetMessageIdentity(data);
  if (!Number.isFinite(seconds) || seconds <= 0 || !identity) return false;
  const providerEventId = mailjetProviderEventId(data, providerKind, seconds, identity);
  const occurredAt = new Date(seconds * 1000).toISOString();
  return {
    provider: "mailjet",
    kind,
    providerEventId,
    occurredAt,
    ...(text(data.CustomID).trim() ? { correlationId: text(data.CustomID).trim() } : {}),
    ...(text(data.email).trim() ? { recipient: text(data.email).trim().toLowerCase() } : {}),
    raw: data,
  };
}

function parseMailjetEvents(body: unknown) {
  let value = body;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return { malformed: true, events: [], ignored: 0 }; }
  }
  if (!value || typeof value !== "object") return { malformed: true, events: [], ignored: 0 };
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length === 0) return { malformed: true, events: [], ignored: 0 };
  const events = [];
  let ignored = 0;
  for (const entry of entries) {
    const event = normalizeMailjetEvent(entry);
    if (event === false) return { malformed: true, events: [], ignored: 0 };
    if (event) events.push(event);
    else ignored += 1;
  }
  return { malformed: false, events, ignored };
}

/** Send provider-normalized events through the Capsule's single email-event seam. */
export async function dispatchVerifiedEmailEvents(ctx: LooseRecord, events: LooseRecord[], subscription?: LooseRecord) {
  if (subscription?.kind !== "emailEvent" || typeof subscription.handler !== "function") return;
  for (const event of events) {
    await ctx.privileged.run({
      operation: "email-events.dispatch",
      targetResourceKind: "email-provider-callback",
      metadata: { provider: event.provider, providerEventId: event.providerEventId },
    }, (privilegedContext: LooseRecord) => subscription.handler(privilegedContext, event));
  }
}

export function createEmailEventEndpoints(mailConfig: LooseRecord | undefined, serverEnv: LooseRecord, subscription: LooseRecord | undefined) {
  const mailjet = mailConfig?.webhooks?.mailjet;
  if (!mailjet?.enabled) return [];
  return [{
    name: "__sporades_mailjet_email_events",
    runtimeOwnedEmailEvent: true,
    method: "POST",
    path: mailjet.path,
    async handler(ctx: LooseRecord) {
      const secret = serverEnv[mailjet.secretEnv];
      if (typeof secret !== "string" || secret.length === 0) {
        return { status: 503, body: { ok: false, accepted: 0, ignored: 0 } };
      }
      if (!verifiedMailjetRequest(ctx, secret)) {
        return { status: 401, body: { ok: false, accepted: 0, ignored: 0 } };
      }
      const parsed = parseMailjetEvents(ctx.request?.body);
      if (parsed.malformed) {
        return { status: 400, body: { ok: false, accepted: 0, ignored: 0 } };
      }
      await dispatchVerifiedEmailEvents(ctx, parsed.events, subscription);
      return { status: 200, body: { ok: true, accepted: parsed.events.length, ignored: parsed.ignored } };
    },
  }];
}
