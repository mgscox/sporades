import { createHash, timingSafeEqual } from "node:crypto";
const MAILJET_EVENT_KINDS = {
    sent: "delivered",
    open: "opened",
    click: "clicked",
    bounce: "bounced",
    blocked: "blocked",
    spam: "complained",
    unsub: "unsubscribed",
};
const SMTP2GO_EVENT_KINDS = {
    processed: "deferred",
    delivered: "delivered",
    open: "opened",
    click: "clicked",
    bounce: "bounced",
    spam: "complained",
    unsubscribe: "unsubscribed",
    resubscribe: "resubscribed",
    reject: "blocked",
};
function text(value) {
    return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}
function secureEqual(left, right) {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
function mailjetBasicPassword(authorization) {
    if (typeof authorization !== "string" || !authorization.startsWith("Basic "))
        return "";
    try {
        const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
        const separator = decoded.indexOf(":");
        return separator < 0 ? "" : decoded.slice(separator + 1);
    }
    catch {
        return "";
    }
}
function verifiedMailjetRequest(ctx, secret) {
    const token = text(ctx.request?.query?.token);
    const basicPassword = mailjetBasicPassword(ctx.request?.headers?.authorization);
    return (token.length > 0 && secureEqual(token, secret))
        || (basicPassword.length > 0 && secureEqual(basicPassword, secret));
}
function verifiedSmtp2goRequest(ctx, secret) {
    const authorization = text(ctx.request?.headers?.authorization);
    const match = authorization.match(/^Bearer ([^\s]+)$/i);
    const token = match?.[1] ?? "";
    return token.length > 0 && secureEqual(token, secret);
}
function verifiedPostmarkRequest(ctx, secret) {
    const token = text(ctx.request?.headers?.["x-sporades-webhook-token"]);
    return token.length > 0 && secureEqual(token, secret);
}
function mailjetMessageIdentity(raw) {
    return typeof raw.Message_GUID === "string" && raw.Message_GUID.trim()
        ? raw.Message_GUID.trim()
        : typeof raw.mj_message_id === "string" ? raw.mj_message_id.trim() : "";
}
function mailjetProviderEventId(raw, event, seconds, identity) {
    const clickUrl = event === "click" ? `:${text(raw.url)}` : "";
    return `${event}:${identity}:${Math.trunc(seconds) || 0}${clickUrl}`;
}
function normalizeMailjetEvent(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return false;
    const data = raw;
    if (typeof data.event !== "string" || !data.event.trim())
        return false;
    const providerKind = data.event.trim().toLowerCase();
    const kind = MAILJET_EVENT_KINDS[providerKind];
    if (!kind)
        return null;
    const seconds = Number(data.time);
    const identity = mailjetMessageIdentity(data);
    if (!Number.isFinite(seconds) || seconds <= 0 || !identity)
        return false;
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
function parseMailjetEvents(body) {
    let value = body;
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        }
        catch {
            return { malformed: true, events: [], ignored: 0 };
        }
    }
    if (!value || typeof value !== "object")
        return { malformed: true, events: [], ignored: 0 };
    const entries = Array.isArray(value) ? value : [value];
    if (entries.length === 0)
        return { malformed: true, events: [], ignored: 0 };
    const events = [];
    let ignored = 0;
    for (const entry of entries) {
        const event = normalizeMailjetEvent(entry);
        if (event === false)
            return { malformed: true, events: [], ignored: 0 };
        if (event)
            events.push(event);
        else
            ignored += 1;
    }
    return { malformed: false, events, ignored };
}
function smtp2goOccurredAt(value) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return new Date(value < 1_000_000_000_000 ? value * 1000 : value).toISOString();
    }
    if (typeof value !== "string" || !value.trim())
        return "";
    if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
        const seconds = Number(value);
        return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : "";
    }
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : "";
}
function smtp2goCorrelationId(raw) {
    const key = Object.keys(raw).find((name) => name.toLowerCase() === "x-sporades-correlation-id");
    return key ? text(raw[key]).trim() : "";
}
function normalizeSmtp2goEvent(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return false;
    const data = raw;
    if (typeof data.event !== "string" || !data.event.trim())
        return false;
    const providerKind = data.event.trim().toLowerCase();
    const kind = SMTP2GO_EVENT_KINDS[providerKind];
    if (!kind)
        return null;
    const providerEventId = typeof data.id === "string" ? data.id.trim() : "";
    const occurredAt = smtp2goOccurredAt(data.time);
    if (!providerEventId || !occurredAt)
        return false;
    const correlationId = smtp2goCorrelationId(data);
    return {
        provider: "smtp2go",
        kind,
        providerEventId,
        occurredAt,
        ...(correlationId ? { correlationId } : {}),
        ...(text(data.rcpt).trim() ? { recipient: text(data.rcpt).trim().toLowerCase() } : {}),
        raw: data,
    };
}
function parseSmtp2goEvents(body) {
    return parseSingleProviderEvent(body, normalizeSmtp2goEvent);
}
function parseSingleProviderEvent(body, normalize) {
    let value = body;
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        }
        catch {
            return { malformed: true, events: [], ignored: 0 };
        }
    }
    const event = normalize(value);
    if (event === false)
        return { malformed: true, events: [], ignored: 0 };
    if (event === null)
        return { malformed: false, events: [], ignored: 1 };
    return { malformed: false, events: [event], ignored: 0 };
}
function normalizePostmarkEvent(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return false;
    const data = raw;
    if (typeof data.RecordType !== "string" || !data.RecordType.trim())
        return false;
    const recordType = data.RecordType.trim();
    const geo = data.Geo && typeof data.Geo === "object" && !Array.isArray(data.Geo)
        ? data.Geo
        : {};
    const descriptor = {
        Delivery: { kind: "delivered", timestamp: "DeliveredAt", recipient: "Recipient", identityDiscriminator: "" },
        Bounce: { kind: "bounced", timestamp: "BouncedAt", recipient: "Email", identityDiscriminator: text(data.Type) },
        Open: {
            kind: "opened",
            timestamp: "ReceivedAt",
            recipient: "Recipient",
            identityDiscriminator: JSON.stringify([data.FirstOpen, text(data.UserAgent), text(geo.IP)]),
        },
        Click: {
            kind: "clicked",
            timestamp: "ReceivedAt",
            recipient: "Recipient",
            identityDiscriminator: JSON.stringify([text(data.OriginalLink), text(data.ClickLocation)]),
        },
        SpamComplaint: { kind: "complained", timestamp: "BouncedAt", recipient: "Email", identityDiscriminator: "" },
        SubscriptionChange: {
            kind: data.SuppressSending === false
                ? "resubscribed"
                : data.SuppressSending === true && data.SuppressionReason === "ManualSuppression" && data.Origin === "Recipient"
                    ? "unsubscribed"
                    : data.SuppressSending === true && data.SuppressionReason === "HardBounce"
                        ? "bounced"
                        : data.SuppressSending === true && data.SuppressionReason === "SpamComplaint"
                            ? "complained"
                            : data.SuppressSending === true ? "blocked" : "",
            timestamp: "ChangedAt",
            recipient: "Recipient",
            identityDiscriminator: `${text(data.SuppressSending)}:${text(data.SuppressionReason)}:${text(data.Origin)}`,
        },
    }[recordType];
    if (!descriptor)
        return null;
    if (!descriptor.kind)
        return false;
    const messageId = typeof data.MessageID === "string" ? data.MessageID.trim() : "";
    const timestamp = data[descriptor.timestamp];
    const milliseconds = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
    if ((recordType !== "SubscriptionChange" && !messageId) || !Number.isFinite(milliseconds))
        return false;
    const occurredAt = new Date(milliseconds).toISOString();
    const recipient = text(data[descriptor.recipient]).trim().toLowerCase();
    if (!recipient)
        return false;
    const metadata = data.Metadata && typeof data.Metadata === "object" && !Array.isArray(data.Metadata)
        ? data.Metadata
        : {};
    const correlationKey = Object.keys(metadata).find((key) => key.toLowerCase() === "correlationid");
    const correlationId = correlationKey ? text(metadata[correlationKey]).trim() : "";
    const identity = createHash("sha256")
        .update(JSON.stringify([recordType, messageId || null, occurredAt, recipient, descriptor.identityDiscriminator]))
        .digest("hex");
    return {
        provider: "postmark",
        kind: descriptor.kind,
        providerEventId: `postmark:${recordType.toLowerCase()}:${identity}`,
        occurredAt,
        ...(correlationId ? { correlationId } : {}),
        ...(recipient ? { recipient } : {}),
        raw: data,
    };
}
function parsePostmarkEvents(body) {
    return parseSingleProviderEvent(body, normalizePostmarkEvent);
}
/** Send provider-normalized events through the Capsule's single email-event seam. */
export async function dispatchVerifiedEmailEvents(ctx, events, subscription) {
    if (subscription?.kind !== "emailEvent" || typeof subscription.handler !== "function")
        return;
    for (const event of events) {
        await ctx.privileged.run({
            operation: "email-events.dispatch",
            targetResourceKind: "email-provider-callback",
            metadata: { provider: event.provider, providerEventId: event.providerEventId },
        }, (privilegedContext) => subscription.handler(privilegedContext, event));
    }
}
function createProviderEmailEventEndpoint(name, config, serverEnv, subscription, verify, parse) {
    return {
        name,
        runtimeOwnedEmailEvent: true,
        method: "POST",
        path: config.path,
        async handler(ctx) {
            const secret = serverEnv[config.secretEnv];
            if (typeof secret !== "string" || secret.length === 0) {
                return { status: 503, body: { ok: false, accepted: 0, ignored: 0 } };
            }
            if (!verify(ctx, secret)) {
                return { status: 401, body: { ok: false, accepted: 0, ignored: 0 } };
            }
            const parsed = parse(ctx.request?.body);
            if (parsed.malformed) {
                return { status: 400, body: { ok: false, accepted: 0, ignored: 0 } };
            }
            await dispatchVerifiedEmailEvents(ctx, parsed.events, subscription);
            return { status: 200, body: { ok: true, accepted: parsed.events.length, ignored: parsed.ignored } };
        },
    };
}
export function createEmailEventEndpoints(mailConfig, serverEnv, subscription) {
    const mailjet = mailConfig?.webhooks?.mailjet;
    const endpoints = [];
    if (mailjet?.enabled)
        endpoints.push(createProviderEmailEventEndpoint("__sporades_mailjet_email_events", mailjet, serverEnv, subscription, verifiedMailjetRequest, parseMailjetEvents));
    const smtp2go = mailConfig?.webhooks?.smtp2go;
    if (smtp2go?.enabled)
        endpoints.push(createProviderEmailEventEndpoint("__sporades_smtp2go_email_events", smtp2go, serverEnv, subscription, verifiedSmtp2goRequest, parseSmtp2goEvents));
    const postmark = mailConfig?.webhooks?.postmark;
    if (postmark?.enabled)
        endpoints.push(createProviderEmailEventEndpoint("__sporades_postmark_email_events", postmark, serverEnv, subscription, verifiedPostmarkRequest, parsePostmarkEvents));
    return endpoints;
}
//# sourceMappingURL=email-events-runtime.js.map