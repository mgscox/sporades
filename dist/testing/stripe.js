import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
const API_VERSION = "2026-08-26.dahlia";
// Kept explicit: the contract test compares these with every SDK call in the real provider.
const ENDPOINTS = [
    ["POST", /^\/v1\/checkout\/sessions$/, "checkout.sessions.create"],
    ["GET", /^\/v1\/checkout\/sessions\/([^/]+)$/, "checkout.sessions.retrieve"],
    ["POST", /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/, "checkout.sessions.expire"],
    ["GET", /^\/v1\/billing_portal\/configurations\/([^/]+)$/, "billingPortal.configurations.retrieve"],
    ["POST", /^\/v1\/billing_portal\/sessions$/, "billingPortal.sessions.create"],
    ["GET", /^\/v1\/subscriptions$/, "subscriptions.list"],
    ["GET", /^\/v1\/subscriptions\/([^/]+)$/, "subscriptions.retrieve"],
    ["POST", /^\/v1\/subscriptions\/([^/]+)$/, "subscriptions.update"],
    ["DELETE", /^\/v1\/subscriptions\/([^/]+)$/, "subscriptions.cancel"],
    ["GET", /^\/v1\/customers\/([^/]+)$/, "customers.retrieve"],
];
const EVENTS = [
    "checkout.session.completed", "checkout.session.expired", "customer.subscription.created",
    "customer.subscription.updated", "customer.subscription.deleted", "invoice.payment_failed",
];
const [CHECKOUT_COMPLETED, CHECKOUT_EXPIRED, SUBSCRIPTION_CREATED, SUBSCRIPTION_UPDATED, SUBSCRIPTION_DELETED, INVOICE_FAILED] = EVENTS;
const copy = (value) => structuredClone(value);
function fail(message = "Unsupported Stripe fake request.", status = 400, code = "sporades_fake_unsupported", type = "invalid_request_error") {
    throw Object.assign(new Error(message), { status, code, type });
}
function requireValue(condition, message) { if (!condition)
    fail(message); }
function loopbackTarget(value) {
    requireValue(typeof value === "string" && /^https?:\/\/(?:127\.0\.0\.1|\[::1\]):\d+(?:\/|$)/.test(value), "Webhook target must use literal loopback and an explicit port.");
    const url = new URL(value);
    requireValue(["127.0.0.1", "[::1]"].includes(url.hostname) && !url.username && !url.password && !url.hash);
    return url.toString();
}
function validateCatalogue(catalogue) {
    requireValue(catalogue && Array.isArray(catalogue.products) && Array.isArray(catalogue.portalConfigurations), "A catalogue is required.");
    const products = new Map();
    const prices = new Set();
    const configs = new Set();
    for (const product of catalogue.products) {
        requireValue(/^prod_[A-Za-z0-9_]+$/.test(product.id) && !products.has(product.id) && Array.isArray(product.prices) && product.prices.length);
        products.set(product.id, new Set());
        for (const price of product.prices) {
            requireValue(/^price_[A-Za-z0-9_]+$/.test(price.id) && !prices.has(price.id) && ["month", "year"].includes(price.recurring));
            prices.add(price.id);
            products.get(product.id).add(price.id);
        }
    }
    for (const config of catalogue.portalConfigurations) {
        requireValue(/^bpc_[A-Za-z0-9_]+$/.test(config.id) && !configs.has(config.id) && Array.isArray(config.products) && config.products.length);
        configs.add(config.id);
        const seen = new Set();
        for (const product of config.products) {
            requireValue(!seen.has(product.product) && product.prices.length && new Set(product.prices).size === product.prices.length
                && product.prices.every((price) => products.get(product.product)?.has(price)));
            seen.add(product.product);
        }
    }
}
function json(response, status, body) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
}
async function readBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 1_048_576)
            fail("Request too large.", 413);
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
}
function parseForm(form) {
    const result = Object.create(null);
    for (const [key, value] of form) {
        requireValue(/^[a-z_][a-z_0-9]*(?:\[[a-z_0-9]+\])*$/.test(key));
        const parts = key.match(/[^[\]]+/g);
        requireValue(parts.every((part) => !["__proto__", "constructor", "prototype"].includes(part)));
        let current = result;
        for (const [index, part] of parts.entries()) {
            if (index === parts.length - 1) {
                requireValue(current[part] === undefined);
                current[part] = value;
            }
            else {
                current[part] ??= Object.create(null);
                requireValue(typeof current[part] === "object");
                current = current[part];
            }
        }
    }
    return result;
}
function exactKeys(object, required, optional = []) {
    requireValue(object && typeof object === "object" && required.every((key) => Object.hasOwn(object, key))
        && Object.keys(object).every((key) => required.includes(key) || optional.includes(key)));
}
function integer(value, max = 999_999) {
    requireValue(typeof value === "number" || typeof value === "string" && /^\d+$/.test(value));
    const number = Number(value);
    requireValue(Number.isSafeInteger(number) && number > 0 && number <= max);
    return number;
}
function listen(server, port = 0) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve(`http://127.0.0.1:${server.address().port}`);
        });
    });
}
async function close(server) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
/** A stateful, deliberately narrow Stripe HTTP fake for Team Billing acceptance tests. */
export async function createStripeTeamBillingFake(options) {
    const webhookTarget = loopbackTarget(options.webhookTarget);
    requireValue(typeof options.webhookSecret === "string" && options.webhookSecret.startsWith("whsec_") && options.webhookSecret.length > 6, "A webhook secret is required.");
    const webhookSecret = options.webhookSecret;
    const delivery = options.delivery;
    validateCatalogue(options.catalogue);
    for (const port of [options.port, options.controlPort])
        requireValue(port === undefined || Number.isInteger(port) && port >= 0 && port <= 65535);
    requireValue(options.delivery === undefined || ["auto", "manual"].includes(options.delivery));
    const timeout = options.requestTimeoutMs ?? 10_000;
    integer(timeout, 300_000);
    const pageSize = integer(options.pageSize ?? 100, 100);
    const catalogue = copy(options.catalogue);
    const sessions = new Map();
    const customers = new Map();
    const subscriptions = new Map();
    const portalSessions = new Map();
    const eventLog = [];
    const delivered = new Set();
    const deliveryLog = [];
    const requests = [];
    const faults = [];
    // Keys are namespaced by the bearer key, which never appears in snapshots or logs.
    const idempotency = new Map();
    const lastCreated = new Map();
    const timers = new Set();
    const controllers = new Set();
    let now = Math.floor(Date.now() / 1000);
    const initialNow = now;
    let stopped = false;
    const id = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
    function get(map, key) {
        return map.get(key) ?? fail(`No such resource: '${key}'.`, 404, "resource_missing");
    }
    function price(priceId) {
        for (const product of catalogue.products) {
            const entry = product.prices.find((item) => item.id === priceId);
            if (entry)
                return { id: entry.id, object: "price", livemode: false, product: product.id,
                    recurring: { interval: entry.recurring, interval_count: 1, usage_type: "licensed" } };
        }
        return fail("Unknown catalogue Price.");
    }
    function periodEnd(start, priceValue) {
        const date = new Date(start * 1000);
        // Calendar periods, clamped to the last day of the target month (including leap years).
        const day = date.getUTCDate();
        date.setUTCDate(1);
        date.setUTCMonth(date.getUTCMonth() + (priceValue.recurring.interval === "year" ? 12 : 1));
        const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
        date.setUTCDate(Math.min(day, lastDay));
        return Math.floor(date.getTime() / 1000);
    }
    async function send(event, fault = {}) {
        requireValue(!stopped, "Fake is closed.");
        const payload = copy(event);
        if (fault.mutatePayloadSameId)
            payload.data.object = copy(fault.mutatePayloadSameId);
        const body = JSON.stringify(payload);
        const timestamp = Math.floor(Date.now() / 1000) - (fault.staleTimestamp ? 600 : 0);
        const signature = createHmac("sha256", fault.badSignature ? `${webhookSecret}_forged` : webhookSecret)
            .update(`${timestamp}.${body}`).digest("hex");
        const controller = new AbortController();
        controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), timeout);
        let attempt;
        try {
            const response = await fetch(webhookTarget, { method: "POST", redirect: "error", signal: controller.signal,
                headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` }, body });
            attempt = { eventId: event.id, status: response.status };
            await response.body?.cancel();
            if (response.ok)
                delivered.add(event.id);
        }
        catch {
            attempt = { eventId: event.id, status: null, error: "Webhook delivery failed." };
        }
        finally {
            clearTimeout(timer);
            controllers.delete(controller);
        }
        deliveryLog.push(attempt);
        return copy(attempt);
    }
    async function emit(type, object, input = {}) {
        requireValue(typeof type === "string" && object && typeof object === "object");
        const objectId = String(object.id ?? type);
        if (input.created !== undefined)
            integer(input.created, 253_402_300_799);
        const created = input.created ?? Math.max(now, (lastCreated.get(objectId) ?? 0) + 1);
        lastCreated.set(objectId, Math.max(created, lastCreated.get(objectId) ?? 0));
        const event = { id: id("evt"), object: "event", api_version: API_VERSION,
            type, created, livemode: false, data: { object: copy(object) } };
        eventLog.push(event);
        if (delivery !== "manual")
            await send(event);
        return copy(event);
    }
    async function subscriptionEvent(subscription) {
        await emit(subscription.status === "canceled" ? SUBSCRIPTION_DELETED : SUBSCRIPTION_UPDATED, subscription);
        return copy(subscription);
    }
    async function complete(sessionId, input = {}) {
        const session = get(sessions, sessionId);
        requireValue(session.status === "open", "Checkout is not open.");
        requireValue(!input.customerId || /^cus_[A-Za-z0-9_]{1,120}$/.test(input.customerId));
        requireValue(!input.customerId || !session.customer || input.customerId === session.customer, "Checkout Customer mismatch.");
        const customerId = input.customerId ?? session.customer ?? id("cus");
        if (!customers.has(customerId))
            customers.set(customerId, { id: customerId, object: "customer", livemode: false, metadata: {} });
        const subscriptionId = id("sub");
        const itemPrice = price(session.line_items.data[0].price.id);
        const subscription = { id: subscriptionId, object: "subscription", livemode: false, customer: customerId,
            status: "active", cancel_at_period_end: false, cancel_at: null, pending_update: null,
            metadata: copy(session.subscription_data.metadata),
            items: { object: "list", has_more: false, data: [{ id: id("si"), object: "subscription_item", subscription: subscriptionId,
                        quantity: session.line_items.data[0].quantity, price: itemPrice, current_period_start: now, current_period_end: periodEnd(now, itemPrice) }] } };
        subscriptions.set(subscriptionId, subscription);
        Object.assign(session, { status: "complete", customer: customerId, subscription: subscriptionId });
        // Commit both objects before delivering either event.
        await emit(CHECKOUT_COMPLETED, session);
        await emit(SUBSCRIPTION_CREATED, subscription);
        return copy(session);
    }
    async function expire(sessionId) {
        const session = get(sessions, sessionId);
        if (session.status !== "open")
            fail(`Only Checkout Sessions with a status in ["open"] can be expired. This Checkout Session has a status of \`${session.status}\`.`, 400);
        session.status = "expired";
        await emit(CHECKOUT_EXPIRED, session);
        return copy(session);
    }
    function liveSubscription(subscriptionId) {
        const subscription = get(subscriptions, subscriptionId);
        requireValue(subscription.status !== "canceled", "Subscription is canceled.");
        return subscription;
    }
    async function setStatus(subscriptionId, status) {
        requireValue(["active", "past_due", "unpaid", "canceled"].includes(status));
        const subscription = liveSubscription(subscriptionId);
        subscription.status = status;
        if (status === "canceled") {
            subscription.cancel_at_period_end = false;
            subscription.cancel_at = null;
        }
        return subscriptionEvent(subscription);
    }
    async function setQuantity(subscriptionId, quantity) {
        const subscription = liveSubscription(subscriptionId);
        subscription.items.data[0].quantity = integer(quantity);
        return subscriptionEvent(subscription);
    }
    async function switchPrice(subscriptionId, priceId) {
        const subscription = liveSubscription(subscriptionId);
        subscription.items.data[0].price = price(priceId);
        return subscriptionEvent(subscription);
    }
    async function setCancellation(subscriptionId, cancel) {
        const subscription = liveSubscription(subscriptionId);
        subscription.cancel_at_period_end = cancel;
        subscription.cancel_at = cancel ? subscription.items.data[0].current_period_end : null;
        return subscriptionEvent(subscription);
    }
    function configuration(configId) {
        const entry = catalogue.portalConfigurations.find((entry) => entry.id === configId);
        if (!entry)
            fail("No such Portal configuration.", 404, "resource_missing");
        return { id: configId, object: "billing_portal.configuration", active: true, livemode: false, features: {
                payment_method_update: { enabled: true }, invoice_history: { enabled: true },
                subscription_cancel: { enabled: true, mode: "at_period_end" },
                subscription_update: { enabled: true, default_allowed_updates: ["price"],
                    products: entry.products.map((product) => ({ ...copy(product), adjustable_quantity: { enabled: false } })) },
            } };
    }
    async function operate(operation, resourceId, p, fault) {
        switch (operation) {
            case "checkout.sessions.create": {
                exactKeys(p, ["mode", "line_items", "success_url", "cancel_url", "client_reference_id", "expires_at", "metadata", "subscription_data"], ["customer"]);
                requireValue(p.mode === "subscription");
                exactKeys(p.line_items, ["0"]);
                exactKeys(p.line_items[0], ["price", "quantity"]);
                exactKeys(p.metadata, ["sporades_team_billing_operation"]);
                exactKeys(p.subscription_data, ["metadata"]);
                exactKeys(p.subscription_data.metadata, ["sporades_team_billing_operation"]);
                requireValue(p.client_reference_id === p.metadata.sporades_team_billing_operation
                    && p.client_reference_id === p.subscription_data.metadata.sporades_team_billing_operation);
                if (p.customer)
                    get(customers, p.customer);
                const sessionId = id("cs_test");
                const session = { id: sessionId, object: "checkout.session", mode: "subscription", status: "open", livemode: false,
                    url: `https://checkout.stripe.com/c/pay/${sessionId}`, customer: p.customer ?? null, subscription: null,
                    success_url: p.success_url, cancel_url: p.cancel_url, client_reference_id: p.client_reference_id,
                    expires_at: integer(p.expires_at, 253_402_300_799), metadata: copy(p.metadata), subscription_data: copy(p.subscription_data),
                    line_items: { object: "list", has_more: false, data: [{ price: price(p.line_items[0].price), quantity: integer(p.line_items[0].quantity) }] } };
                sessions.set(sessionId, session);
                return copy(session);
            }
            case "checkout.sessions.retrieve":
                exactKeys(p, []);
                return copy(get(sessions, resourceId));
            case "checkout.sessions.expire":
                exactKeys(p, []);
                if (fault?.status === "completeDuringExpire" && get(sessions, resourceId).status === "open")
                    await complete(resourceId);
                return expire(resourceId);
            case "billingPortal.configurations.retrieve":
                exactKeys(p, [], ["expand"]);
                if (p.expand) {
                    exactKeys(p.expand, ["0"]);
                    requireValue(p.expand[0] === "features.subscription_update.products");
                }
                return configuration(resourceId);
            case "billingPortal.sessions.create": {
                exactKeys(p, ["customer", "configuration", "return_url"]);
                get(customers, p.customer);
                configuration(p.configuration);
                const portalId = id("bps");
                const session = { ...copy(p), id: portalId, object: "billing_portal.session", livemode: false,
                    url: `https://billing.stripe.com/p/session/${portalId}` };
                portalSessions.set(portalId, session);
                return copy(session);
            }
            case "customers.retrieve":
                exactKeys(p, []);
                return copy(get(customers, resourceId));
            case "subscriptions.retrieve":
                exactKeys(p, []);
                return copy(get(subscriptions, resourceId));
            case "subscriptions.update": {
                exactKeys(p, ["items", "proration_behavior", "proration_date", "payment_behavior"]);
                exactKeys(p.items, ["0"]);
                exactKeys(p.items[0], ["id", "price", "quantity"]);
                const subscription = liveSubscription(resourceId);
                const item = subscription.items.data[0];
                requireValue(p.items[0].id === item.id && p.proration_behavior === "create_prorations" && p.payment_behavior === "pending_if_incomplete");
                integer(p.proration_date, 253_402_300_799);
                const targetPrice = price(p.items[0].price);
                const quantity = integer(p.items[0].quantity);
                item.price = targetPrice;
                item.quantity = quantity;
                subscription.pending_update = fault?.status === "paymentActionRequired" ? { expires_at: now + 3600 } : null;
                return subscriptionEvent(subscription);
            }
            case "subscriptions.list": {
                exactKeys(p, ["customer", "status", "limit"], ["starting_after"]);
                get(customers, p.customer);
                requireValue(p.status === "all");
                const all = [...subscriptions.values()].filter((item) => item.customer === p.customer);
                const cursor = p.starting_after ? all.findIndex((item) => item.id === p.starting_after) : -1;
                requireValue(!p.starting_after || cursor >= 0);
                const limit = Math.min(integer(p.limit, 100), pageSize);
                const data = all.slice(cursor + 1, cursor + 1 + limit);
                return { object: "list", data: copy(data), has_more: cursor + 1 + data.length < all.length, url: "/v1/subscriptions" };
            }
            case "subscriptions.cancel":
                exactKeys(p, []);
                return setStatus(resourceId, "canceled");
        }
    }
    const apiServer = createServer(serialized(async (request, response) => {
        try {
            // Reject live/restricted keys before inspecting routes, logs, idempotency or state.
            const bearer = request.headers.authorization ?? "";
            if (!/^Bearer sk_test_[A-Za-z0-9_]+$/.test(bearer))
                fail("Only sk_test_ keys are accepted.", 401, "invalid_api_key", "authentication_error");
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            const route = ENDPOINTS.find(([method, pattern]) => request.method === method && pattern.test(url.pathname));
            const parameters = parseForm(request.method === "GET" ? url.searchParams : new URLSearchParams(await readBody(request)));
            const keyHeader = request.headers["idempotency-key"];
            const key = typeof keyHeader === "string" ? keyHeader : null;
            const entry = { method: request.method ?? "", path: url.pathname, operation: route?.[2] ?? "unsupported",
                parameters: copy(parameters), idempotencyKey: key, replay: false };
            requests.push(entry);
            requireValue(route);
            requireValue(!request.headers["stripe-version"] || request.headers["stripe-version"] === API_VERSION, "Unsupported Stripe API version.");
            const operation = route[2];
            const resourceId = url.pathname.match(route[1])?.[1] ?? "";
            const fingerprint = JSON.stringify([request.method, url.pathname, [...(request.method === "GET" ? url.searchParams : new URLSearchParams(flatten(parameters)))].sort(([a], [b]) => a.localeCompare(b))]);
            const cacheKey = request.method === "POST" && key ? JSON.stringify([bearer, key]) : null;
            const prior = cacheKey ? idempotency.get(cacheKey) : undefined;
            if (prior) {
                if (prior.fingerprint !== fingerprint)
                    fail("Idempotency key reused with different parameters.", 400, "idempotency_error", "idempotency_error");
                entry.replay = true;
                response.setHeader("idempotent-replayed", "true");
                json(response, prior.status, prior.body);
                return;
            }
            const fault = faults.find((fault) => fault.operation === operation && (fault.count ?? 1) > 0);
            if (fault)
                fault.count = (fault.count ?? 1) - 1;
            const special = fault && typeof fault.status === "string" && fault.status !== "timeout";
            const faultResponse = () => {
                if (fault.status === "timeout") {
                    const timer = setTimeout(() => { timers.delete(timer); response.destroy(); }, timeout + 250);
                    timers.add(timer);
                    response.once("close", () => { clearTimeout(timer); timers.delete(timer); });
                }
                else
                    json(response, Number(fault.status), { error: { type: "api_error", code: "sporades_fake_fault", message: "Injected provider fault." } });
            };
            if (fault && !special && fault.when !== "after") {
                faultResponse();
                return;
            }
            const body = await operate(operation, resourceId, parameters, fault);
            if (cacheKey)
                idempotency.set(cacheKey, { fingerprint, status: 200, body: copy(body) });
            if (fault && !special && fault.when === "after") {
                faultResponse();
                return;
            }
            json(response, 200, body);
        }
        catch (error) {
            json(response, error.status ?? 400, { error: { type: error.type ?? "invalid_request_error",
                    code: error.code ?? "sporades_fake_unsupported", message: error.status ? error.message : "Unsupported Stripe fake request." } });
        }
    }));
    const fake = {
        origin: "", controlOrigin: "",
        async close() {
            if (stopped)
                return;
            stopped = true;
            for (const timer of timers)
                clearTimeout(timer);
            timers.clear();
            for (const controller of controllers)
                controller.abort();
            await Promise.all([close(apiServer), close(controlServer)]);
        },
        checkout: { complete, expire },
        portal: { switchPrice, cancelAtPeriodEnd: (id) => setCancellation(id, true), resume: (id) => setCancellation(id, false) },
        subscriptions: {
            setStatus, setQuantity, get: (id) => copy(get(subscriptions, id)),
            async renew(id) {
                const subscription = liveSubscription(id);
                const item = subscription.items.data[0];
                requireValue(!subscription.cancel_at_period_end, "Subscription is scheduled for cancellation.");
                item.current_period_start = item.current_period_end;
                item.current_period_end = periodEnd(item.current_period_start, item.price);
                subscription.status = "active";
                return subscriptionEvent(subscription);
            },
            async failPayment(id) {
                const subscription = liveSubscription(id);
                subscription.status = "past_due";
                const item = subscription.items.data[0];
                const invoiceId = idForInvoice();
                const invoice = { id: invoiceId, object: "invoice", livemode: false, customer: subscription.customer,
                    status: "open", paid: false, attempt_count: 1,
                    parent: { type: "subscription_details", subscription_details: { subscription: subscription.id } },
                    lines: { object: "list", has_more: false, data: [{ id: idForLine(), object: "line_item", invoice: invoiceId, livemode: false,
                                parent: { type: "subscription_item_details", subscription_item_details: { subscription: subscription.id, subscription_item: item.id, proration: false } },
                                pricing: { type: "price_details", price_details: { price: item.price.id, product: item.price.product } },
                                quantity: item.quantity, period: { start: item.current_period_start, end: item.current_period_end } }] } };
                // Invoice evidence must follow subscription evidence even though they have different object IDs.
                await emit(INVOICE_FAILED, invoice, { created: Math.max(now, (lastCreated.get(subscription.id) ?? 0) + 1) });
                lastCreated.set(subscription.id, Math.max(now, eventLog.at(-1).created));
                return copy(invoice);
            },
        },
        customers: { subscriptions: (id) => { get(customers, id); return copy([...subscriptions.values()].filter((item) => item.customer === id)); } },
        clock: { async advance(seconds) {
                requireValue(Number.isSafeInteger(seconds) && seconds >= 0 && now + seconds <= 253_402_300_799);
                now += seconds;
                for (const session of sessions.values())
                    if (session.status === "open" && session.expires_at <= now)
                        await expire(session.id);
                for (const sub of subscriptions.values())
                    if (sub.status !== "canceled" && sub.cancel_at_period_end && sub.cancel_at <= now)
                        await setStatus(sub.id, "canceled");
            } },
        events: {
            pending: () => copy(eventLog.filter((event) => !delivered.has(event.id))),
            async deliver(eventId, fault) {
                const events = eventId ? [eventLog.find((entry) => entry.id === eventId) ?? fail("Unknown event.")] : eventLog.filter((event) => !delivered.has(event.id));
                const result = [];
                for (const event of events)
                    result.push(await send(event, fault));
                return result;
            },
            async deliverInOrder(ids) { const result = []; for (const id of ids)
                result.push(...await fake.events.deliver(id)); return result; },
            async redeliver(id, fault) { return (await fake.events.deliver(id, fault))[0]; },
            emit, deliveries: () => copy(deliveryLog),
        },
        faults: {
            inject(fault) {
                requireValue(ENDPOINTS.some((entry) => entry[2] === fault.operation));
                requireValue(typeof fault.status === "number" ? Number.isInteger(fault.status) && fault.status >= 400 && fault.status <= 599
                    : ["timeout", "paymentActionRequired", "completeDuringExpire"].includes(fault.status));
                requireValue(fault.when === undefined || ["before", "after"].includes(fault.when));
                if (fault.status === "paymentActionRequired")
                    requireValue(fault.operation === "subscriptions.update");
                if (fault.status === "completeDuringExpire")
                    requireValue(fault.operation === "checkout.sessions.expire");
                faults.push({ ...copy(fault), count: integer(fault.count ?? 1) });
            },
            clear() { faults.length = 0; },
        },
        requests: () => copy(requests),
        state: () => copy({ catalogue, now, customers: [...customers.values()], subscriptions: [...subscriptions.values()],
            checkouts: [...sessions.values()], portalSessions: [...portalSessions.values()], events: eventLog }),
        reset() {
            sessions.clear();
            customers.clear();
            subscriptions.clear();
            portalSessions.clear();
            idempotency.clear();
            lastCreated.clear();
            eventLog.length = 0;
            delivered.clear();
            deliveryLog.length = 0;
            requests.length = 0;
            faults.length = 0;
            now = initialNow;
        },
    };
    function idForInvoice() { return id("in"); }
    function idForLine() { return id("il"); }
    // An explicit dispatch table prevents control clients from reaching arbitrary object properties.
    const controls = {
        "checkout.complete": fake.checkout.complete, "checkout.expire": fake.checkout.expire,
        "portal.switchPrice": fake.portal.switchPrice, "portal.cancelAtPeriodEnd": fake.portal.cancelAtPeriodEnd, "portal.resume": fake.portal.resume,
        "subscriptions.setStatus": fake.subscriptions.setStatus, "subscriptions.setQuantity": fake.subscriptions.setQuantity,
        "subscriptions.failPayment": fake.subscriptions.failPayment, "subscriptions.renew": fake.subscriptions.renew, "subscriptions.get": fake.subscriptions.get,
        "customers.subscriptions": fake.customers.subscriptions, "clock.advance": fake.clock.advance,
        "events.pending": fake.events.pending, "events.deliver": fake.events.deliver, "events.deliverInOrder": fake.events.deliverInOrder,
        "events.redeliver": fake.events.redeliver, "events.emit": fake.events.emit, "events.deliveries": fake.events.deliveries,
        "faults.inject": fake.faults.inject, "faults.clear": fake.faults.clear, requests: fake.requests, state: fake.state, reset: fake.reset,
    };
    const controlServer = createServer(async (request, response) => {
        try {
            requireValue(request.method === "POST" && request.url?.startsWith("/__control/"));
            // No browser CORS or cross-origin form access to a local control plane.
            requireValue(!request.headers.origin && request.headers["content-type"]?.split(";")[0] === "application/json");
            const operation = request.url.slice("/__control/".length);
            requireValue(Object.hasOwn(controls, operation));
            const input = JSON.parse(await readBody(request));
            exactKeys(input, ["args"]);
            requireValue(Array.isArray(input.args));
            const result = await controls[operation](...input.args);
            json(response, 200, { ok: true, data: result ?? null });
        }
        catch {
            json(response, 400, { ok: false, error: "Invalid fake control request." });
        }
    });
    try {
        fake.origin = await listen(apiServer, options.port);
        fake.controlOrigin = await listen(controlServer, options.controlPort);
    }
    catch (error) {
        if (apiServer.listening)
            await close(apiServer);
        if (controlServer.listening)
            await close(controlServer);
        throw error;
    }
    return fake;
}
function flatten(object, prefix = "") {
    return Object.entries(object).flatMap(([key, value]) => {
        const name = prefix ? `${prefix}[${key}]` : key;
        return typeof value === "object" ? flatten(value, name) : [[name, String(value)]];
    });
}
// Serialize HTTP execution through the idempotency commit, including overlapping SDK retries.
function serialized(handler) {
    let lane = Promise.resolve();
    return (request, response) => {
        lane = lane.then(() => handler(request, response)).catch(() => { response.destroy(); });
    };
}
//# sourceMappingURL=stripe.js.map