# 07 — Contract Google-specific auth and prove provider coexistence

**What to build:** Finish the expand-contract migration by removing obsolete Google-only implementation paths while retaining deliberate compatibility at the public interface. A Capsule can enable Google, Microsoft, Apple, Facebook, email, and Anonymous sessions together and receives consistent identity, Session, error, and operator behavior across them.

**Blocked by:** 04 — Sign in and register with Microsoft; 05 — Sign in and register with Apple; 06 — Sign in and register with Facebook.

**Status:** done

- [x] Provider dispatch, callback orchestration, OAuth state, identity linking, configuration status, and error shaping have one authoritative provider-neutral implementation.
- [x] Obsolete Google-specific internal completion and profile-linking paths are removed rather than retained as a second implementation.
- [x] Any retained legacy Google message or configuration shape is an explicit compatibility shim that immediately crosses the provider-neutral seam and is documented as such.
- [x] Auth user profile data and Session provenance no longer depend on a single mutable provider field as identity authority.
- [x] Provider credentials can be added, updated, disabled, and reported independently without changing sibling provider state.
- [x] An all-providers Capsule exposes the correct configured choices and each sign-in intent reaches only its selected provider adapter.
- [x] Cross-provider account linking, returning identity sign-in, provider switching, same-email identities, absent-email identities, and cross-user conflicts have provider-neutral end-to-end coverage.
- [x] Auth changes consistently retire prior Journey state and refresh connected auth observers without bridging identity state between users.
- [x] Provider-specific test endpoint overrides are confined to an explicit test seam and cannot redirect production OAuth traffic through ambient process configuration.
- [x] Runtime, Database adapter, CLI, client SDK, scaffold, documentation, generated Bundle, Container session, and security tests pass together.
- [x] Generated `bin/`, `dist/`, API documentation, and rendered documentation remain in parity with their authoritative sources.
- [x] The runtime-owned provider-auth ADR and product documentation describe the final multi-provider design rather than the transitional Google implementation.
