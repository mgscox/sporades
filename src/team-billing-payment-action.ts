/** Accept Stripe's account/token invoice paths and documented email-source query. */
export function validTeamBillingHostedInvoiceUrl(value: unknown): value is string {
  return typeof value === "string" && value === value.trim()
    && /^https:\/\/invoice\.stripe\.com\/i\/(?:acct_[A-Za-z0-9]{1,120}\/)?[A-Za-z0-9_~=-]{4,2048}(?:\?s=em)?$/.test(value);
}
