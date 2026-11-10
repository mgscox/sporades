// Stripe's hosted-invoice-page documentation uses /i/acct_…/test_…?s=em.
export const hostedInvoiceUrls = [
  "https://invoice.stripe.com/i/acct_abcdefghijklmno/test_YWNjdF8xRGZ3UzJDbENJS2xqV3Zz?s=em",
  "https://invoice.stripe.com/i/acct_abcdefghijklmno/YWNjdF8xRGZ3UzJDbENJS2xqV3Zz",
  "https://invoice.stripe.com/i/in_legacy_hosted",
];

export const unsafeHostedInvoiceUrls = [
  "https://pay.example.test/i/acct_test/test_hosted?s=em",
  "https://invoice.stripe.com.evil.test/i/acct_test/test_hosted?s=em",
  "http://invoice.stripe.com/i/acct_test/test_hosted?s=em",
  "https://invoice.stripe.com@evil.test/i/acct_test/test_hosted",
  "https://user@invoice.stripe.com/i/acct_test/test_hosted",
  "https://invoice.stripe.com:443/i/acct_test/test_hosted",
  "https://invoice.stripe.com:8443/i/acct_test/test_hosted",
  "https://invoice.stripe.com/not-i/acct_test/test_hosted",
  "https://invoice.stripe.com/i/acct_test/test_hosted?redirect=https://evil.test",
  "https://invoice.stripe.com/i/acct_test/test_hosted?s=em&redirect=evil",
  "https://invoice.stripe.com/i/acct_test/test_hosted#evil",
  "https://invoice.stripe.com/i/acct_test/../test_hosted",
  "https://invoice.stripe.com/i/acct_test%2ftest_hosted",
  "https://invoice.stripe.com/i/acct_test/test_hosted/extra",
  "https://invoice.stripe.com/i/acct_test/test_hosted\n",
  `https://invoice.stripe.com/i/acct_test/${"a".repeat(2049)}`,
];
