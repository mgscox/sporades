const VARIABLE = "SPORADES_DEV_STRIPE_API_ORIGIN";
function refuse(code, message, hint) {
    throw Object.assign(new Error(message), { code, hint });
}
export function assertStripeTestOriginCommand(command) {
    if (process.env[VARIABLE] !== undefined && command !== "dev") {
        refuse("STRIPE_TEST_ORIGIN_DEV_ONLY", `${VARIABLE} is only supported by sporades dev.`, `Unset ${VARIABLE} before running other commands, including deploy, Host operations and Bundle builds.`);
    }
}
// Deliberately stricter than the internal provider seam: no DNS or URL
// normalization (including abbreviated IPv4 addresses or an implicit port).
export function resolveDevStripeApiOrigin() {
    const value = process.env[VARIABLE];
    if (value === undefined)
        return undefined;
    const match = /^https?:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/.exec(value);
    if (!match || Number(match[1]) > 65535) {
        refuse("STRIPE_API_ORIGIN_INVALID", `${VARIABLE} must be an exact literal loopback origin.`, "Use http://127.0.0.1:<port> or http://[::1]:<port> (https is also accepted), with an explicit port from 1 to 65535 and no credentials, path, query or fragment.");
    }
    return value;
}
export function validateDevStripeRuntime(payments, serverEnv) {
    const origin = resolveDevStripeApiOrigin();
    if (origin === undefined)
        return undefined;
    const stripe = payments?.stripe;
    if (stripe?.enabled === true && (stripe.livemode !== false ||
        typeof serverEnv[stripe.secretKeyEnv] !== "string" ||
        !serverEnv[stripe.secretKeyEnv].startsWith("sk_test_"))) {
        refuse("STRIPE_TEST_ORIGIN_LIVE_MODE", "The Dev Stripe test origin requires test-mode Stripe credentials.", "Set payments.stripe.livemode to false and use a Sealed Server secret key starting with sk_test_.");
    }
    return origin;
}
export function markDevStripeRuntime(database) {
    if (!database.stripeApiBaseUrl)
        return;
    database.runtimeDiagnostics.payments = { stripe: { providerOrigin: "loopback-test" } };
    database.log.emit({ category: "platform", event: "payments.stripe.test_origin_active", level: "warn",
        message: database.paymentsConfig?.stripe.enabled
            ? "Loopback Stripe test provider active; this certifies nothing about live Stripe."
            : "Loopback Stripe test provider selected while payments are dormant; no provider calls will run.",
        data: { payments: { stripe: { providerOrigin: "loopback-test" } } },
    });
}
//# sourceMappingURL=dev-stripe-origin.js.map