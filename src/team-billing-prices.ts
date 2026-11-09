type Facts = Record<string, any>;

export function validBillingCurrency(value: any): value is string {
  return typeof value === "string" && /^[a-z]{3}$/.test(value);
}

export function validBillingAmount(value: any): value is number {
  return Number.isSafeInteger(value) && value >= 0 && value <= 99_999_999;
}

/** Undefined means the legacy identity-only Price contract. */
export function billingCurrencyAmount(price: Facts, currency: any): number | undefined {
  if (!validBillingCurrency(currency)) return undefined;
  return currency === price.currency ? price.unitAmount : price.currencyOptions?.[currency]?.unitAmount;
}

export function normalizeBillingCurrency(price: Facts, invalid: () => Error): Facts {
  if (!["currency", "unitAmount", "currencyOptions"].some(key => Object.hasOwn(price, key))) return {};
  if (!validBillingCurrency(price.currency) || !validBillingAmount(price.unitAmount)) throw invalid();
  const options = price.currencyOptions;
  const normalized: Facts = {};
  if (Object.hasOwn(price, "currencyOptions")) {
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).length > 32) throw invalid();
    for (const [currency, amount] of Object.entries(options) as [string, any][]) {
      if (!validBillingCurrency(currency) || currency === price.currency || !amount || typeof amount !== "object"
        || Array.isArray(amount) || Object.keys(amount).join(",") !== "unitAmount" || !validBillingAmount(amount.unitAmount)) throw invalid();
      normalized[currency] = Object.freeze({ unitAmount: amount.unitAmount });
    }
  }
  return { currency: price.currency, unitAmount: price.unitAmount,
    ...(options ? { currencyOptions: Object.freeze(normalized) } : {}) };
}

/** Subscription Price facts use the selected currency, rather than the default Price amount. */
export function matchesBillingCurrency(price: Facts, currency: any, amount: any): boolean {
  return !price.currency || billingCurrencyAmount(price, currency) !== undefined
    && billingCurrencyAmount(price, currency) === amount;
}

export function billingCurrencyMismatch() {
  return Object.assign(new Error("The target Price does not support the subscription currency. Start a separate billing agreement to change currency."), {
    code: "TEAM_BILLING_CURRENCY_MISMATCH",
    hint: "Choose a Price supporting the existing subscription currency.",
  });
}

const PRICE_ID_PATTERN = /^price_[A-Za-z0-9_]{1,249}$/;
const PRODUCT_ID_PATTERN = /^prod_[A-Za-z0-9_]{1,240}$/;
const PORTAL_CONFIGURATION_ID_PATTERN = /^bpc_[A-Za-z0-9_]{1,240}$/;

export function validTeamBillingInterval(value: any): value is string {
  if (typeof value !== "string") return false;
  const match = /^(day|week|month|year):([1-9][0-9]{0,3})$/.exec(value);
  return Boolean(match && Number(match[2]) <= ({ day: 1095, week: 156, month: 36, year: 3 } as Facts)[match[1]]);
}

export function teamBillingPrices(binding: any): Facts[] {
  if (!binding) return [];
  return binding.prices
    ? Object.entries(binding.prices).map(([interval, price]: any) => ({ interval, ...price }))
    : [{ priceId: binding.priceId, ...(binding.currency ? { currency: binding.currency, unitAmount: binding.unitAmount, ...(binding.currencyOptions ? { currencyOptions: binding.currencyOptions } : {}) } : {}) }];
}

export function teamBillingPrice(binding: any, interval: any) {
  if (!binding) return null;
  if (binding.prices) return typeof interval === "string" && Object.hasOwn(binding.prices, interval)
    ? { interval, ...binding.prices[interval] } : null;
  return interval === undefined ? teamBillingPrices(binding)[0] : null;
}

export function teamBillingPriceById(binding: any, priceId: any) {
  return teamBillingPrices(binding).find((price) => price.priceId === priceId) ?? null;
}

export function normalizeModeBinding(value: any, invalidDeclaration: () => Error) {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !["priceId", "prices", "productId", "portalConfigurationId", "currency", "unitAmount", "currencyOptions"].includes(key))
    || (value.productId !== undefined && (typeof value.productId !== "string" || !PRODUCT_ID_PATTERN.test(value.productId)))
    || (value.portalConfigurationId !== undefined && (typeof value.portalConfigurationId !== "string" || !PORTAL_CONFIGURATION_ID_PATTERN.test(value.portalConfigurationId)))) throw invalidDeclaration();
  let priceBinding: Facts;
  if (Object.hasOwn(value, "prices")) {
    if (["priceId", "currency", "unitAmount", "currencyOptions"].some(key => Object.hasOwn(value, key)) || !isRecord(value.prices)
      || Object.keys(value.prices).length < 1 || Object.keys(value.prices).length > 32) throw invalidDeclaration();
    const prices: Facts = {};
    for (const [interval, price] of Object.entries(value.prices)) {
      if (!validTeamBillingInterval(interval) || !isRecord(price) || Object.keys(price).some(key => !["priceId", "currency", "unitAmount", "currencyOptions"].includes(key))
        || typeof price.priceId !== "string" || !PRICE_ID_PATTERN.test(price.priceId)) throw invalidDeclaration();
      prices[interval] = Object.freeze({ priceId: price.priceId, ...normalizeBillingCurrency(price, invalidDeclaration) });
    }
    priceBinding = { prices: Object.freeze(prices) };
  } else {
    if (typeof value.priceId !== "string" || !PRICE_ID_PATTERN.test(value.priceId)) throw invalidDeclaration();
    priceBinding = { priceId: value.priceId, ...normalizeBillingCurrency(value, invalidDeclaration) };
  }
  return Object.freeze({ ...priceBinding, ...(value.productId ? { productId: value.productId } : {}), ...(value.portalConfigurationId ? { portalConfigurationId: value.portalConfigurationId } : {}) });
}


function isRecord(value: any): value is Facts {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function matchesBillingPriceAmount(actual: any, expected: number): boolean {
  return actual?.unit_amount === expected && actual.custom_unit_amount == null && actual.tiers == null
    && (actual.unit_amount_decimal == null || typeof actual.unit_amount_decimal === "string"
      && /^\d+(?:\.0+)?$/.test(actual.unit_amount_decimal) && Number(actual.unit_amount_decimal) === expected);
}
