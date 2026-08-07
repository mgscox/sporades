import assert from "node:assert/strict";
import test from "node:test";

import { SERVER_RUNTIME_SOURCE_FUNCTIONS } from "../dist/server-runtime-source.js";
import { POSTGRES_SKIP_REASON, withLibsqlAdapter, withPostgresAdapter, withSqliteAdapter } from "./support/database-adapter-engines.js";

// The construction behind ADR-0036's ordering field, checked where it is generated rather than
// only through the order it produces.
//
// The conformance specification asserts that every engine returns the Log index in the same order.
// That is the behaviour, and it is only as trustworthy as the field underneath it: an ordering
// value that ties, that loses digits on the way to storage, or that restarts from an arbitrary
// origin would satisfy a single ordering assertion and then leave the order undefined in the case
// nobody wrote a case for. Each property below is one of the three ways that could happen.

function runtimeFunction(name) {
  const fn = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((candidate) => candidate.name === name);
  assert.ok(fn, `${name} is not a server runtime source function`);
  return fn;
}

const nextLogIndexSequence = runtimeFunction("nextLogIndexSequence");
const formatLogIndexSequence = runtimeFunction("formatLogIndexSequence");
const backfilledLogIndexSequence = runtimeFunction("backfilledLogIndexSequence");

const SEQUENCE_WIDTH = 20;
const NANOS_PER_MILLISECOND = 1_000_000n;

const ENGINES = [
  { name: "SQLite", skip: false, withAdapter: withSqliteAdapter },
  { name: "libSQL", skip: false, withAdapter: withLibsqlAdapter },
  { name: "Postgres", skip: POSTGRES_SKIP_REASON, withAdapter: withPostgresAdapter },
];

function logEvent(message, timestamp) {
  return {
    timestamp,
    category: "app",
    event: "ctx.log",
    level: "info",
    message,
    capsule: { name: "log-index-sequence", id: "capsule-sequence" },
    release: { id: "release-1" },
    request: { id: "request-1" },
    correlation: { id: "correlation-1" },
  };
}

test("the Log index sequence is strictly increasing within a process", () => {
  // Monotonic by construction, not merely high-resolution. A field that ties rarely leaves the
  // order undefined in the rare case, which is the blind spot ADR-0036 exists to remove rather
  // than to make less likely — and it would make the conformance ordering assertion flaky.
  const sequences = Array.from({ length: 20_000 }, () => nextLogIndexSequence());

  const strictlyIncreasing = sequences.every((sequence, index) => index === 0 || sequences[index - 1] < sequence);
  assert.equal(strictlyIncreasing, true, "the Log index sequence repeated or went backwards within one process");
  assert.equal(new Set(sequences).size, sequences.length);

  // Compared as text, because that is how the engines compare the stored column.
  assert.deepEqual([...sequences].sort(), sequences);
});

test("the Log index sequence is fixed-width zero-padded text that sorts lexicographically", () => {
  const sequence = nextLogIndexSequence();

  assert.equal(sequence.length, SEQUENCE_WIDTH);
  assert.match(sequence, /^[0-9]{20}$/);

  // The padding is what keeps lexicographic order equal to numeric order, and the width is only
  // safe while it does not change. Nanoseconds since the epoch is a 19-digit number today, so the
  // leading character is a zero with a whole digit of headroom — around three thousand years of it.
  assert.equal(sequence.startsWith("0"), true, "the sequence has grown into its padding, so the fixed width is no longer safe");
  assert.equal(formatLogIndexSequence(1n), "00000000000000000001");
  assert.equal(formatLogIndexSequence(99_999_999_999_999_999_999n).length, SEQUENCE_WIDTH);

  // Ordering survives a change of digit count only because of the padding: unpadded, "9" would
  // sort after "10".
  assert.equal(formatLogIndexSequence(9n) < formatLogIndexSequence(10n), true);
});

test("the Log index sequence would lose distinct instants if it were stored as a number", () => {
  // Why the column is TEXT rather than BIGINT. The Postgres adapter coerces oids 20, 21 and 23
  // through `Number(value)`, and at this magnitude a double cannot represent adjacent nanoseconds:
  // two events the field deliberately separated would come back equal, which is the defect class
  // this feature exists to eliminate rather than to reintroduce one layer down.
  const first = nextLogIndexSequence();
  const second = formatLogIndexSequence(BigInt(first) + 1n);

  assert.notEqual(first, second);
  assert.equal(BigInt(first) < BigInt(second), true);
  assert.equal(Number(first), Number(second), "a double is expected to collapse adjacent nanoseconds at this magnitude");
  assert.equal(Number(first) > Number.MAX_SAFE_INTEGER, true);
});

test("the Log index sequence is anchored to the wall clock, so it orders across a restart", () => {
  // Within a process the monotonic clock supplies the ordering; across processes only the wall
  // clock can, because the monotonic clock's origin is arbitrary per process. Anchoring one to the
  // other is what makes a sequence written by an earlier run sort before one written by a later
  // run, which a bare `process.hrtime.bigint()` would not.
  const sequence = BigInt(nextLogIndexSequence());
  const wallNanos = BigInt(Date.now()) * NANOS_PER_MILLISECOND;

  const driftNanos = sequence > wallNanos ? sequence - wallNanos : wallNanos - sequence;
  assert.equal(driftNanos < 60n * 1_000_000_000n, true, `the sequence is ${driftNanos}ns from the wall clock rather than tracking it`);

  // Stated as the property that matters: a sequence the same construction would have produced a
  // minute ago sorts before this one, and a minute from now sorts after it.
  const aMinuteAgo = formatLogIndexSequence(wallNanos - 60n * 1_000_000_000n);
  const aMinuteAhead = formatLogIndexSequence(wallNanos + 60n * 1_000_000_000n);
  assert.equal(aMinuteAgo < formatLogIndexSequence(sequence), true);
  assert.equal(formatLogIndexSequence(sequence) < aMinuteAhead, true);
});

test("a backfilled sequence is the stored timestamp in the same units as a live one", () => {
  // The backfill has to place rows written before the field existed on the same scale as rows
  // written after it, or a bound applied after the migration would keep the wrong subset.
  assert.equal(backfilledLogIndexSequence("2026-07-04T10:00:00.000Z"), 1_783_159_200_000_000_000n);
  assert.equal(
    formatLogIndexSequence(backfilledLogIndexSequence("2026-07-04T10:00:00.000Z")).length,
    SEQUENCE_WIDTH,
  );

  // Order among backfilled rows follows the timestamps they did record.
  assert.equal(
    backfilledLogIndexSequence("2026-07-04T10:00:00.000Z") < backfilledLogIndexSequence("2026-07-04T10:00:00.001Z"),
    true,
  );

  // A row whose timestamp cannot be read is placed at the very beginning rather than dropped or
  // left null, because a null would put the ordering back in the engines' hands.
  assert.equal(backfilledLogIndexSequence("not a timestamp"), 0n);
  assert.equal(backfilledLogIndexSequence(null), 0n);
});

for (const engine of ENGINES) {
  test(`the Log index ordering column round trips as fixed-width text: ${engine.name}`, { skip: engine.skip }, async () => {
    await engine.withAdapter(async (adapter) => {
      await adapter.ensureLogStorage();

      await adapter.insertLogIndexEvent(logEvent("sequence-first", "2026-07-04T10:00:00.000Z"));
      await adapter.insertLogIndexEvent(logEvent("sequence-second", "2026-07-04T10:00:00.000Z"));

      // Read back under the declared camelCase spelling. Every identifier the runtime emits is
      // quoted through the dialect (ADR-0039), so Postgres stores `"indexSequence"` case-preserved
      // and hands it straight back — the read path issue 03's missing `verifierHash` entry broke
      // silently, asserted here rather than assumed.
      const rows = await adapter
        .prepare(
          adapter.dialect.sql("SELECT [message], [indexSequence] FROM [sporades_log_events] ORDER BY [indexSequence] ASC"),
        )
        .all();
      assert.deepEqual(rows.map((row) => row.message), ["sequence-first", "sequence-second"]);

      for (const row of rows) {
        assert.equal(typeof row.indexSequence, "string", `${engine.name} handed the ordering column back as ${typeof row.indexSequence}`);
        assert.match(row.indexSequence, /^[0-9]{20}$/);
      }

      // The two values are distinct and their exact digits survive storage. A `BIGINT` column read
      // through the Postgres adapter's `Number(value)` coercion would have collapsed them.
      const [first, second] = rows.map((row) => row.indexSequence);
      assert.notEqual(first, second);
      assert.equal(first < second, true);
      assert.equal(BigInt(second) - BigInt(first) > 0n, true);
    }, { appTableNames: [] });
  });
}
