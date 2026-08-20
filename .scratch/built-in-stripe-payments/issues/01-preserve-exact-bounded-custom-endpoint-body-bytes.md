# 01 — Preserve exact bounded Custom endpoint body bytes

**What to build:** Let a Custom endpoint inspect the exact bounded bytes received from its HTTP request alongside the existing parsed body, so signed integrations can verify the original payload without weakening request limits, redaction, or existing endpoint behavior.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] Every Custom endpoint receives an immutable exact-byte representation of the request body in addition to the existing parsed body value.
- [x] JSON endpoints continue to receive the same parsed body behavior, including the existing structured invalid-JSON failure.
- [x] Empty, textual, form-encoded, and JSON bodies retain their exact received bytes without normalization, re-encoding, whitespace changes, or key reordering.
- [x] Exact bytes and parsed bodies share the existing bounded request read; the runtime never buffers the incoming body twice from the network or permits either representation to exceed the limit.
- [x] Two byte-distinct JSON bodies that parse to the same value remain distinguishable through the exact-byte representation.
- [x] Exact request bytes are available only to server endpoint processing and never cross the client transport.
- [x] Runtime logs, HTTP failure logs, CLI output, and safe error envelopes do not include exact body bytes automatically.
- [x] Context middleware and Custom endpoint handlers observe one stable public request contract without receiving mutable access to the runtime's internal buffer.
- [x] Dev sessions, Container sessions, and the shipped server Bundle expose identical exact-body behavior.
- [x] Public declarations, canonical endpoint documentation, generated artifacts, and focused Bundle-level tests agree on the additive contract.
- [x] Existing Custom endpoint tests continue to pass without requiring Capsule changes.
