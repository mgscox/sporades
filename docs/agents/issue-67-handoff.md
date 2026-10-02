# Issue #67: exact-path HTTP admission enforcement

This is an implementation handoff, not a shipped runtime contract. HTTP
request-admission enforcement for [issue #67](https://github.com/mgscox/sporades/issues/67)
remains unimplemented.

## Prerequisite

At the 2026-10-02 dependency check, GitHub's native blocking relationship lists
[issue #66](https://github.com/mgscox/sporades/issues/66) as open. Its implementation,
[PR #189](https://github.com/mgscox/sporades/pull/189), is also open. Issue #67 depends
on the validated immutable policy generation, ordered-rule contract, and
reserved-path validation supplied by #66. Recheck these states before resuming.

## Remaining implementation

After #66 closes and its implementation is available on `main`:

1. Add focused `node --test` coverage proving that an enabled exact canonical
   pathname deny rule prevents Capsule application code from running, while a
   non-matching request passes through unchanged.
2. Consume the validated immutable generation before normal HTTP application
   routing. Preserve ordered first-match semantics and skip disabled rules.
3. Return an opaque `403` with constant bounded response bytes and
   `Cache-Control: no-store`. Disclose no rule ID, reason, or matched value.
4. Keep genuine Host-authenticated runtime-health and connection-token control
   routes outside Capsule admission. Prove they remain reachable and that
   targeting their reserved paths fails during policy-generation validation.
5. Prove unchanged behavior without a declared policy and document and verify
   an explicit latency budget for that path.
6. Update the corresponding source, shipped types, generated artifacts,
   canonical runtime documentation, and focused parity tests together. Run
   `npm run build`, `npm run typecheck`, and the full `npm test` before review.

## Draft review status

The draft containing this handoff must remain draft until runtime enforcement
and its acceptance tests are implemented. Validation of this documentation
does not establish that issue #67's acceptance criteria pass.

The handoff PR references #67 without issue-closing metadata. Keep it draft
until #66 is merged, all enforcement criteria above are implemented, and a
complete validation run passes. Round-one QA reported macOS archive-fixture
metadata failures and a gateway cancellation-observation race; passing isolated
retries do not replace the required clean complete suite.

Run every Sporades command with `SPORADES_CONFIG_DIR` pointing inside the
worktree. Validation must use isolated local state and avoid real Host servers
and live Stripe, OAuth, or SMTP calls.
