# 02 — Build the dormant blank-Capsule payment foundation

**What to build:** Make every newly created blank Capsule contain a production-shaped but disabled Stripe payment foundation, so derived work starts with payment configuration, server wiring, Job and query placeholders, shared state, dependencies, and activation guidance without requiring credentials or exposing payment authority.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] A newly generated blank Capsule includes the built-in Stripe payment foundation as ordinary scaffold output rather than as a dedicated template or later codemod.
- [x] The foundation contains disabled Stripe project configuration, server-side payment wiring, named payment Job declarations, bounded known-Job query behavior, shared payment state, an empty server-owned Price catalogue, and clear activation instructions.
- [x] The provider implementation remains Sporades-owned behind a separately exported server-only integration module; generated files contain Capsule wiring and policy placeholders rather than copied transport code.
- [x] The integration module exposes only narrow payment operations and no generic provider request escape hatch.
- [x] The official Stripe server library is pinned to a tested compatible range and is never exposed to browser code.
- [x] A credential-free blank Capsule installs, typechecks, builds, and boots in its disabled state.
- [x] Disabled payment configuration registers no Stripe callback route, performs no provider request, and grants no payment operation authority.
- [x] Invoking dormant payment wiring produces a structured disabled result with an actionable activation hint and no secret-shaped diagnostics.
- [x] The scaffold writes no Stripe secret, webhook secret, live Price identity, Customer identity, or short-lived provider URL.
- [x] Existing Capsules with no payment configuration preserve their current behavior because the new configuration remains optional and disabled when absent.
- [x] Existing non-blank demonstration templates retain their current domain behavior and are not rewritten merely to add payment UI.
- [x] Generated agent guidance distinguishes platform-owned Stripe mechanics from Capsule-owned Prices, Customers, Teams, billing authority, entitlements, retention, export, and erasure.
- [x] Scaffold tests verify the complete generated project through the real CLI rather than testing generator helpers alone.
- [x] Public exports, project-configuration reference, blank-template documentation, and generated-package policy agree on the dormant foundation.
