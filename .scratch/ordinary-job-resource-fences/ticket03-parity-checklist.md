# Ticket 03 Job and outer-resource parity checklist

This checklist records the implemented SQLite boundary at the current ticket-03
branch tip. It compares the resource scope itself, not unrelated Job scheduling
or HTTP transport behavior.

| Concern | Ordinary Job | Custom mutation and endpoint | Evidence / remaining work |
| --- | --- | --- | --- |
| Entry and identity | One first-operation scope uses the captured Job actor, exact claim token, canonical resource and durable receipt identity. | One first application DB operation joins the existing outer transaction with the request actor and the same canonical resource/receipt identity. | `test/resource-transactions.test.js` covers first-entry, actor binding, replay, mutation and endpoint paths. |
| Authority and locking | Dedicated SQLite `BEGIN IMMEDIATE` writer holds through resource commit. | The outer SQLite transaction holds the writer through its own settlement after the callback returns. | Same-runtime and independent-process contention tests pass. PostgreSQL lock ordering remains ticket 04. |
| Lifetime | Claim deadline reserves one second, watchdog revokes scope handles, and claim ownership is checked before commit. | Outer transaction has the same 30-second budget and one-second reserve; callback results stay provisional until outer commit or rollback. | Outer watchdog, deadline, and post-scope handle tests pass. |
| Allowed scope work | Bound database work, transactional child Job enqueue, receipt/log work; unsupported notification acceptance remains rejected. | The same bound database, enqueue and logging rules; parent aliases and escaped handles are invalid after scope closure. | Durable intent acceptance and sender lifecycle remain ticket 06. |
| Resource diagnostics | ACL checks run against the resource-owned scoped database and do not publish ordinary denial records. | From initial authorization through scoped reads and writes, ACL denial diagnostics are suppressed from JSONL and the log index; only bounded payload-free resource logs may publish after commit. | `resource attempts suppress ACL denial diagnostics from initial authorization and scoped work` covers caught and unawaited scoped denials in both outer contexts. |
| Post-commit settlement | Resource Jobs dispatch their committed children before their bounded JSONL resource-log publication. | A committed outer resource dispatches children, invalidates caches and settles its other post-commit work even when JSONL publication fails; callers receive redacted `RESOURCE_STORAGE_ERROR` and the durable receipt remains authoritative. | `postcommit JSONL publication failure still dispatches committed resource children` drains pre-existing fixture startup timers before each operation, then proves exactly one newly scheduled dispatch timer and fires only that ID. |
| Commit uncertainty | A lost resource COMMIT acknowledgement reports `RESOURCE_COMMIT_UNKNOWN`; a new authority reconciles through the receipt. | The same error is retained through the outer transaction; root SQLite access is quarantined until disposal and replacement both succeed. | Native-close and replacement-open fault tests cover root, new and cached statements; a separate adapter reads the durable receipt. |
| Non-opt-in behavior | Existing Jobs retain ordinary database behavior when they do not opt in. | Existing mutations and endpoints retain their ordinary behavior when they do not opt in. | Covered by the non-opt-in regression. |

## Outstanding boundaries

- Ticket 04 must prove the equivalent PostgreSQL transaction, lock ordering and
  connection-loss behavior against a real local test database.
- Ticket 05 retains explicit libSQL rejection; it does not add optional support.
- Ticket 06 owns durable notification intent acceptance, SMTP attempt records and
  retry recovery. `notifications.accept` is deliberately unsupported here.
- Ticket 07 owns the end-to-end Grant workflow and the final map between M1 and
  the original SMTP requirement. Ordinary SMTP fencing remains disproved by
  ADR-0054 and is not claimed by this checklist.
