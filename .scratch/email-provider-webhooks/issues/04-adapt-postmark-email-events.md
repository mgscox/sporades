# 04 — Adapt Postmark email events

**What to build:** A Capsule can consume verified Postmark delivery lifecycle
events through the same consolidated dispatcher and the same single
provider-neutral subscription already used for Mailjet. Postmark-specific
payload and verification details remain inside its adapter.

**Blocked by:** 01 — Dispatch Mailjet verified email events.

**Status:** done

- [x] A configured Postmark integration exposes its provider-facing route only
      when enabled and rejects callbacks that fail Postmark verification.
- [x] Postmark lifecycle callbacks normalize into the existing
      `VerifiedEmailEvent` contract, including provider identity and raw
      per-event JSON.
- [x] A Capsule handler receives equivalent normalized events through the
      existing dispatcher without a Postmark-specific app interface.
- [x] Live account validation confirms all six Postmark-generated synthetic
      payload families, callback authentication, and removal of the temporary
      webhook. One real send used only the approved recipient; it remained
      `Sent` without a Delivery event, so provider retry timing remains an
      explicitly documented live limit while stable replay identity is covered
      by duplicate-fixture tests.
