# 04 — Ship browser Access-key management

**What to build:** Let a Capsule render its own Access-key management experience using one framework-neutral browser module, while Sporades owns the secure Session-only lifecycle operations, typed results, one-time secret disclosure, and error handling underneath it.

**Blocked by:** 03 — Complete immutable owner lifecycle and recovery

**Status:** ready-for-agent

- [ ] `sporades/client` exports an `accessKeys` singleton with exactly `list`, `issue`, `rotate`, `revoke`, and `delete`, plus the agreed public lifecycle, summary, input, page, secret-result, and error-code types.
- [ ] Every browser operation travels through the existing authenticated client transport, returns `Promise<SporadesResult<...>>`, and enforces a live linked Session rather than trusting client-supplied owner identity or Credential provenance.
- [ ] Issue and rotate disclose the complete token only in the resolving result; the client runtime does not persist, subscribe to, replay, log, cache, or copy it into Auth/framework adapter state.
- [ ] Listing computes effective scopes against the current Capsule declaration and never asks Capsule UI code to reproduce wildcard matching, status derivation, or lifecycle rules.
- [ ] An Access-key-authenticated Custom endpoint cannot invoke the current-user management projection even though its AuthContext represents the owner.
- [ ] A documented framework-neutral management flow lists keys, issues or rotates one, renders a transient copy-once disclosure, clears it when dismissed, and refreshes metadata after mutations without introducing a framework-owned page or component.
- [ ] Client declarations, runtime template, package export, generated artifacts, client transport tests, one-time response-loss tests, and packed-package import proof remain synchronized.
