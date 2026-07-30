# 05 — Prove production runtime and documentation parity

**What to build:** Make SMTP mail a production-ready Sporades capability across Dev sessions, local Container sessions, and Hosted Capsules. The completed feature must preserve generated Server Bundle parity, close transport resources cleanly, expose useful secret-safe diagnostics, and teach app authors when to send directly versus enqueue a durable Job.

**Blocked by:** 02 — Support Postmark SMTP extensions; 03 — Support Mailgun SMTP extensions; 04 — Support portable SMTP providers and SMTP2GO.

**Status:** ready-for-agent

- [ ] The same Capsule server source and `sporades.json` contract work unchanged in Dev, local Container, and Hosted Capsule execution.
- [ ] Generated Server Bundles include every mail runtime helper and dependency required by the source runtime, with no source-only global or helper assumptions.
- [ ] Runtime shutdown closes pooled or active SMTP transport resources without delaying normal Dev restart, Container replacement, or Hosted Capsule shutdown.
- [ ] Mail timeouts are bounded and a stalled SMTP peer cannot indefinitely hold a handler or shutdown path.
- [ ] Runtime logs record vendor, recipient counts, latency, result category, and safe message identity while excluding addresses, bodies, provider payloads, credentials, Server env values, and raw SMTP authentication details.
- [ ] Structured failures exposed to Capsule code and clients contain only stable mail codes, messages, and actionable hints.
- [ ] Type tests prove valid use from every trusted server context and reject use from client code, table ACL contexts, and Schedule payload factories.
- [ ] Runtime tests prove `ctx.mail` survives context middleware and derived Privileged context construction without leaking into excluded contexts.
- [ ] Generated-output checks cover the distributed CLI, runtime Bundle, public server declarations, and generated API documentation.
- [ ] The PRD, architecture documentation, configuration reference, server guide, and public API documentation describe SMTP mail as implemented scope.
- [ ] Documentation includes Postmark, Mailgun, SMTP2GO, and generic SMTP examples and explains that `provider` values become validated SMTP headers rather than arbitrary provider API payloads.
- [ ] Documentation demonstrates a durable Job calling `ctx.mail.send(...)`, explains at-least-once delivery and application-level idempotency, and warns that a direct send cannot roll back with a failed database transaction.
- [ ] The full repository test suite, strict typecheck, documentation build, and generated-artifact parity checks pass.
