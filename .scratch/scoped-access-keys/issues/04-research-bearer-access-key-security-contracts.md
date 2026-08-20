# Research bearer Access-key security contracts

Status: closed
Label: wayfinder:research
Parent: [Chart user-owned scoped Access keys](./00-chart-user-owned-scoped-access-keys.md)
Assignee: codex

**Blocked by:** None — can start immediately.

## Question

Which primary-source security guidance should constrain Access-key entropy, wire format, lookup and hashing, constant-time verification, expiry, one-time disclosure, rotation, revocation, redaction, rate limiting, caching, and failure behavior for Sporades' HTTP runtime?

## Comments

### Resolution — 2026-08-20

The primary-source findings and derived Sporades contract are recorded in [Bearer Access-key security contracts](../research/bearer-access-key-security-contracts.md).

Sporades adopts the useful HTTP Bearer transport and threat-model constraints without pretending its owner-issued Access keys are OAuth tokens. The proposed v1 credential is a recognisable, versioned `Authorization: Bearer` selector/verifier value with 128-bit selector and 256-bit verifier search spaces. Only the selector and a domain-separated SHA-256 verifier digest persist; verification uses strict bounded parsing, one indexed lookup, a dummy digest for unknown selectors, and equal-length constant-time comparison.

The contract requires protected transport outside an explicit loopback-development exception, header-only presentation, one-time secret disclosure, no-store issuance/rotation responses, atomic no-overlap rotation, terminal revocation and expiry, earliest-boundary redaction, bounded failed-admission throttles, and opaque lifecycle failures. Successful workload quotas remain Capsule/operator policy rather than inferred Access-key policing.

HTTP behavior retains the agreed `UNAUTHENTICATED` 401 versus `FORBIDDEN` 403 split. Every Access-key 401 carries a Bearer challenge; invalid keys use the non-descriptive `invalid_token` category, while 403 responses omit scope details. Admission throttling returns non-cacheable 429. Unwrapped Custom endpoints remain outside the contract and keep ownership of their own Authorization schemes.

The research deliberately leaves HMAC peppering, limiter thresholds and trusted-proxy derivation, the production realm, successful-response cache overrides, and audit retention to their owning storage/operations decisions. It also records current runtime seams that later implementation must extend: the existing Reset-code selector/verifier pattern, shared log redaction, and the endpoint writer's missing 403/challenge/no-store behavior.
