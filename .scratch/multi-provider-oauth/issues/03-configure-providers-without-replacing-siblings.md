# 03 — Configure providers without replacing enabled siblings

**What to build:** Let operators configure and inspect OAuth providers through one provider-neutral CLI and configuration contract. Adding credentials for one provider preserves every already-enabled provider, normal status output remains secret-safe, and generated Capsule clients can render sign-in choices from runtime-reported provider availability.

**Blocked by:** 02 — Deepen runtime-owned OAuth behind a provider seam.

**Status:** done

- [x] Multi-provider auth configuration can describe anonymous, email, Google, Microsoft, Apple, and Facebook providers while preserving legacy Google configuration compatibility.
- [x] `sporades auth set <provider>` merges the selected provider into existing auth configuration instead of replacing sibling providers or disabling Anonymous sessions.
- [x] Provider-specific credential-file parsing remains behind the provider configuration seam.
- [x] Provider secret values remain in Server env or Sealed Server env; project configuration stores only provider shape, non-secret options, and env-var names.
- [x] Auth status reports each provider's enabled, configured, and runtime-availability state without exposing credential values.
- [x] Misconfigured or partially configured providers fail with structured, provider-specific guidance that includes the exact callback URL an operator must register where safe.
- [x] A running Dev session clearly reports that it must restart after provider configuration changes.
- [x] The public client auth state reports all enabled providers through the existing provider-generic shape.
- [x] Scaffolded provider sign-in controls are derived from enabled and configured runtime providers and call only the Sporades client SDK.
- [x] CLI JSON output remains stable and machine-readable for agents, including mixed configured and unconfigured providers.
- [x] Tests cover merge preservation, legacy configuration, explicit disablement, credential-file parsing, secret redaction, status, generated clients, and an all-providers configuration without requiring live credentials.
- [x] Operator and product documentation describe the multi-provider configuration contract and retain the server-owned full-page redirect model.
