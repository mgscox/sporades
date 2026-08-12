# 06 — Adapt SMTP2GO email events

**What to build:** A Capsule can consume verified SMTP2GO email lifecycle
events through the existing consolidated dispatcher and provider-neutral
subscription. SMTP2GO-specific Bearer verification, JSON payload validation,
event names, identity fields, and optional correlation headers remain inside
its adapter.

**Blocked by:** 01 — Dispatch Mailjet verified email events.

**Status:** done

- [x] A configured SMTP2GO integration exposes its runtime-owned route only when
      enabled, requires the configured Bearer secret, and never mints a Sporades
      user or Session.
- [x] SMTP2GO's documented email event payloads normalize into the existing
      `VerifiedEmailEvent` contract with exact raw JSON.
- [x] Invalid callbacks fail for retry, unknown event names are acknowledged,
      and the Capsule handler uses the same Privileged dispatcher as Mailjet.
- [x] The Mail guide documents secure JSON/Bearer setup, mappings, retry timing,
      and manual external registration without exposing account API keys.
- [x] A live SMTP2GO account test confirms the documented callback shape and
      authentication contract without committing or printing credentials.
