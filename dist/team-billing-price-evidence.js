import { matchesBillingPriceAmount, normalizeModeBinding, teamBillingPrices } from "./team-billing-prices.js";
/** Offline activation check; callers supply saved Prices with currency_options expanded. */
export function validateTeamBillingPriceEvidence(input) {
    const invalid = () => Object.assign(new Error("Team Billing Price evidence does not match the declared catalogue."), {
        code: "TEAM_BILLING_PRICE_EVIDENCE_MISMATCH",
        hint: "Save one active recurring Stripe Price per binding with currency_options expanded and verify every declared amount.",
    });
    try {
        if (!input || !["sandbox", "live"].includes(input.mode))
            throw invalid();
        if (!input.catalogue || typeof input.catalogue !== "object" || Array.isArray(input.catalogue)
            || Object.keys(input.catalogue).length < 1 || Object.keys(input.catalogue).length > 32)
            throw invalid();
        const seenPrices = new Set();
        const evidence = input.evidence;
        const prices = Array.isArray(evidence) ? evidence : evidence?.data;
        if (!Array.isArray(prices))
            throw invalid();
        for (const product of Object.values(input.catalogue)) {
            const binding = normalizeModeBinding(product?.stripe?.[input.mode], invalid);
            for (const declared of teamBillingPrices(binding)) {
                if (seenPrices.has(declared.priceId))
                    throw invalid();
                seenPrices.add(declared.priceId);
                const matches = prices.filter(price => price?.id === declared.priceId);
                if (matches.length !== 1)
                    throw invalid();
                const price = matches[0];
                const productId = typeof price.product === "string" ? price.product : price.product?.id;
                if (price.object !== "price" || price.active !== true || price.livemode !== (input.mode === "live")
                    || (binding.productId && productId !== binding.productId) || price.type !== "recurring"
                    || price.billing_scheme !== "per_unit" || price.recurring?.usage_type !== "licensed"
                    || (declared.interval && declared.interval !== `${price.recurring.interval}:${price.recurring.interval_count}`)
                    || price.custom_unit_amount != null || price.transform_quantity != null || price.tiers != null)
                    throw invalid();
                if (!declared.currency)
                    continue;
                if (price.currency !== declared.currency || !matchesBillingPriceAmount(price, declared.unitAmount))
                    throw invalid();
                const options = price.currency_options;
                if (options != null && (typeof options !== "object" || Array.isArray(options)))
                    throw invalid();
                const expected = { [declared.currency]: { unitAmount: declared.unitAmount }, ...declared.currencyOptions };
                for (const [currency, option] of Object.entries(options ?? {})) {
                    if (!Object.hasOwn(expected, currency) || !matchesBillingPriceAmount(option, expected[currency].unitAmount))
                        throw invalid();
                }
                for (const [currency, option] of Object.entries(declared.currencyOptions ?? {})) {
                    if (!matchesBillingPriceAmount(options?.[currency], option.unitAmount))
                        throw invalid();
                }
            }
        }
        return Object.freeze({ ok: true });
    }
    catch {
        throw invalid();
    }
}
//# sourceMappingURL=team-billing-price-evidence.js.map