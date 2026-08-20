# 04 — Ship browser Access-key management

**What to build:** Let a Capsule render its own Access-key management experience using one framework-neutral browser module, while Sporades owns the secure Session-only lifecycle operations, typed results, one-time secret disclosure, and error handling underneath it.

**Blocked by:** 03 — Complete immutable owner lifecycle and recovery

**Status:** complete

- [x] `sporades/client` exports an `accessKeys` singleton with exactly `list`, `issue`, `rotate`, `revoke`, and `delete`, plus the agreed public lifecycle, summary, input, page, secret-result, and error-code types.
- [x] Every browser operation travels through the existing authenticated client transport, returns `Promise<SporadesResult<...>>`, and enforces a live linked Session rather than trusting client-supplied owner identity or Credential provenance.
- [x] Issue and rotate disclose the complete token only in the resolving result; the client runtime does not persist, subscribe to, replay, log, cache, or copy it into Auth/framework adapter state.
- [x] Listing computes effective scopes against the current Capsule declaration and never asks Capsule UI code to reproduce wildcard matching, status derivation, or lifecycle rules.
- [x] An Access-key-authenticated Custom endpoint cannot invoke the current-user management projection even though its AuthContext represents the owner.
- [x] A documented framework-neutral management flow lists keys, issues or rotates one, renders a transient copy-once disclosure, clears it when dismissed, and refreshes metadata after mutations without introducing a framework-owned page or component.
- [x] Client declarations, runtime template, package export, generated artifacts, client transport tests, one-time response-loss tests, and packed-package import proof remain synchronized.

## Evidence

- Implementation and review repairs: `7859ecd`, `e3d42d1`, `a9ed599`.
- Focused source, client, type, package, docs, and generated tests: 102/102 passed; real Auth transport: 15/15 passed; generated Bundle integrations: 16/16 applicable tests passed with the Postgres case skipped by configuration.
- Independent Standards and Spec re-reviews at `a9ed599`: clean, with no actionable findings.
