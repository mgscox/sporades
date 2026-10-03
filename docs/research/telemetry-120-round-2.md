# PR #204: Poirot round 1 follow-up

Poirot confirmed a persistence regression at `b7099bd0`: a valid inventory could
receive HTTP 200, then its private expectation metadata pushed the stored file
past the reader's old wire-plus-envelope limit. Authenticated reads, discovery,
metrics, retry, restart and subsequent stop acknowledgement then failed.

## Fix and regression coverage

The public wire limit remains 1 MiB and 2,000 Capsules. The private envelope
budgets a second wire-sized block for duplicated Capsule IDs and ISO timestamps,
plus 8 KiB of envelope headroom. Writes, `read()` and `list()` use the same bound.
The exact serialized UTF-8 bytes are validated before creating a temporary file
or replacing durable state; acknowledgement still follows atomic replacement
and fsync. Existing previously oversized valid envelopes fit the new bound.

Two authenticated HTTP regressions submit inventories within 300 bytes of the
wire limit, with short IDs and maximum valid 317-character IDs. Both reproduced
200 followed by 503 before the fix. After the fix they verify reads, discovery,
metrics, identical retries, retained expectation ages through restart, rejection
of an oversized revision without losing prior state, and a higher-revision stop
that removes active expectations and remains readable after another restart.

## Validation

- Focused inventory/availability/gateway/CLI suite: 31 passed, zero failed.
- Typecheck passed. Pretest rebuilt artifacts and checked generated-bin parity;
  rebuilding left tracked `dist` and `bin` unchanged. The standalone monitoring
  archive was regenerated locally and verified to contain the corrected store.
- Documentation: 53 tests passed and VitePress build passed.
- Packed installed-CLI private-CA Docker acceptance: one passed, zero failed,
  one optional pre-descriptor CLI skip because no legacy CLI was supplied.
- Fresh Docker availability drill passed: firing in **92,118 ms**, followed by
  recovery, runtime absence and acknowledged-stop removal. All task-owned Compose
  resources were removed; see [recorded evidence](./telemetry-120/round-2-docker-acceptance.json).
- Fresh full `npm test`: **2,732 passed, 2 failed, 207 skipped** (2,941 tests;
  21 minutes 45 seconds). This full-suite verdict remains **failed**. Both
  near-limit inventory regressions and the previously timed-out WebSocket
  mutation test passed within this run.
- Failures: `telemetry-jobs-bundle.test.js` pending queue age (sampling ratio 1)
  and `user-journey-expiry.test.js` consent after a second browser reconnect.
  A separate focused rerun passed all three selected cases (both Job sampling
  ratios and reconnect consent); this does **not** make the full run green.
  These test files and their compiled runtime/browser artifacts are unchanged
  by the persistence fix.

## Separate WebSocket result

Poirot's round-1 full suite failed: 2,731 passed, one WebSocket message timeout,
207 skipped. The isolated WebSocket rerun passed, but that retry does **not**
change the failed full-suite verdict. The fresh round-2 full-suite result is
reported separately above. This persistence change does not modify WebSocket,
scaffold or authentication behavior. The anonymous sign-in smoke failure remains
tracked by existing issue #194.
