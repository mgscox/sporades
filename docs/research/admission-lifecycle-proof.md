# Container and Hosted admission lifecycle proof

Status: pending. This is the remaining verification plan for
[issue #73](https://github.com/mgscox/sporades/issues/73), not an execution report
or evidence that request admission is complete.

Regression fixture fixes and regression-suite results on the draft PR do not
prove the lifecycle scenarios below. The PR does not close #73 and must remain
an unmerged draft while the dependency and acceptance work are outstanding.

## Dependency gate

On 2026-10-02, GitHub's native dependency graph still marked
[issue #72](https://github.com/mgscox/sporades/issues/72) open. It supplies the
bounded, redacted counters, policy digest, reload health and existing inspection
surfaces needed to prove this lifecycle. Recheck that dependency before starting
the acceptance run. A planning-only draft must not be merged as completion
of #73.

## Local harness

Use real running Capsule processes in Docker for both Container and Hosted
sessions. The Hosted harness must include the actual local Host helper and Caddy
route publication path; mocked Host commands alone cannot prove this boundary.
Use a Capsule fixture with observable HTTP handler entry, exact response bytes,
streamed chunks and WebSocket handshake/message handling, so rejected requests
can be shown never to reach application code.

Keep all CLI configuration, policy fixtures and run evidence inside the
worktree. Set `SPORADES_CONFIG_DIR` for every Sporades command. Use uniquely named
containers and Compose projects, available local ports outside 4000, 4100,
4500–4699, 4317 and 5317, and remove only resources created by the run. Do not
connect to a real Host, SSH target, cloud provider or production telemetry sink.
The mandatory scenario must require no Cloudflare, Appwrite or paid account.

## Required scenarios and evidence

Run each applicable scenario in both session kinds. Record the commit, generated
artifact digests, Base image, session kind, active policy digest, observations and
cleanup result. No row below is currently proved by this document.

| Scenario | Evidence required before #73 can be completed |
| --- | --- |
| Authorized add, change and removal | Publish through the deployer-owned path; demonstrate each valid change within 10 seconds. Retain the application artifact digest and container identity to show no rebuild or redeploy. |
| Concurrent replacement | Maintain traffic while replacing policy; correlate every decision with one complete old or new generation. Reject any partial-generation observation. |
| Truncated and malformed hot replacement | Show continued last-known-good enforcement, degraded inspection health and failure evidence. Publish a valid generation and show health recovery and recovery evidence. |
| Invalid configured cold start | Show that ordinary HTTP and WebSocket traffic cannot reach application handlers before policy validation succeeds. |
| HTTP and WebSocket decisions | Exercise admit, opaque deny and rate limit before handler entry or upgrade acceptance. Assert exact caller-facing bytes/status and retry semantics from the completed contract. |
| Client identity | Hosted: prove trusted Caddy client-address derivation and rejection of forged forwarding headers. Container: prove non-address enforcement and the contract's pinned behavior when trusted address identity is missing. |
| Runtime tampering | Attempt policy write, truncate, rename, unlink and replacement from Capsule runtime code through its mounted or exposed path. Show unchanged deployer policy digest and enforcement. |
| Hostile input and high rate | Exercise published file/parser/state/bucket bounds and eviction behavior. Assert exact unsampled counters, bounded log output and measured memory behavior under sustained load, including recovery visibility. |
| No declared policy | Compare exact response bytes, route ordering, streaming, WebSocket behavior, logs and generated Bundle behavior with the baseline. Record the agreed latency threshold and measured results; do not invent a threshold or call ordinary unit tests this proof. |
| Provider independence | Execute the entire mandatory run using local Docker/Caddy. Treat Cloudflare-origin coverage as optional and document the capabilities used without assuming a paid plan. |
| Operator documentation | Reconcile the shipped commands and supported security contributions with observed behavior. State limits explicitly; do not claim comprehensive OWASP Top 10:2025 protection or generic signature-WAF coverage. |

## Completion handoff

After #72 closes, implement an executable lifecycle harness and retain its
reproducible invocation and measured evidence. Pin response/retry semantics,
missing-identity behavior, resource limits and the latency budget to the completed
contract before asserting them. Update shipped operator documentation and any
public/generated surfaces affected by implementation, then run the build,
typecheck and full regression suite in addition to the boundary scenarios.

The [request-admission research](./capsule-request-admission-waf.md) provides the
design rationale and security limitations. It is not a substitute for execution
evidence. The draft remains blocked until every required scenario has actual
results and the prerequisite inspection surfaces are available.
