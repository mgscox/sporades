# 01 — Prove the external-side-effect contract

**What to build:** A deterministic experiment and recorded contract showing what a Capsule can safely promise when a Job coordinates database changes and an external side effect with another worker. Select a concrete implementable recovery and handoff design before downstream implementation begins.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

**Parent:** https://github.com/mgscox/sporades/issues/52

- [ ] Use two independent workers/connections and a controlled SMTP receiver to observe database authority, callback execution, and external acceptance separately.
- [ ] Pause worker A immediately before submission, including after its last ownership check; invalidate its database authority, allow worker B to acquire the resource, then resume A. Record whether A can still submit or mutate state.
- [ ] Exercise process death, a live but paused process, database connection loss, lease expiry, restart, and an accepted message whose acknowledgement is lost. Do not conflate these failure modes.
- [ ] Record a precise authority acquisition point, ownership-loss rule, recovery rule, external acceptance boundary, and retry/uncertainty policy. State whether the external destination must participate in fencing and what deployments can support that contract.
- [ ] Compare the proposed transaction scope with a durable conditional-update protocol and explain the selected shape. Do not infer a conditional write guarantee from ordinary filtered table updates.
- [ ] Capture the decision and relevant domain vocabulary in an ADR, respecting the existing distinction between database consequences and provider calls.
- [ ] Produce a concrete API and state-transition contract sufficient for tickets 02 and 06 to implement, including time bounds, operation eligibility, actor authorization, and escaped-capability behavior. Prototype code, if needed, remains clearly experimental and does not expose an unproven production promise.
- [ ] Clear this blocking edge only with a proven implementable design meeting the parent, or an explicitly approved contract amendment recorded with its rationale. If proof fails, record the unresolved requirement and keep dependent tickets blocked; do not silently substitute database-only fencing or close the parent.

**Validation prerequisites:** Follow the shared test-environment instructions. PostgreSQL experiments require the already-approved local Docker instance. Install dependencies in the worktree; symlinked `node_modules` cannot be used.
