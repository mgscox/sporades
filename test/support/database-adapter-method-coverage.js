// Coverage enforcement for the Database adapter conformance specification (ADR-0035).
//
// ADR-0035 ends with "adding a method to the Database adapter without adding it to the conformance
// specification leaves the work incomplete". This module is what turns that sentence into
// something the build insists on: it enumerates the method set the Database adapter exposes and
// reports the methods no conformance case exercises.
//
// Coverage is measured, not declared. A method counts as covered when a conformance case calls it
// directly on a live adapter, which is observed by replaying every surface's cases through a
// recording Proxy. Nothing here reads a list of method names a contributor wrote down, because a
// list is satisfied by typing a name and the defect class this feature exists to close was never
// about names. Two consequences follow deliberately:
//
// - A method reached only while a surface prepares its storage is not covered. Storage preparation
//   asserts nothing, and a method that returns a plausible wrong value while seeding is exactly the
//   shape that shipped six times.
// - A method reached only as another method's internal step is not covered either. The recorder
//   counts a call only at the outermost depth, so `completeFileUpload` calling `selectFileById`
//   covers `completeFileUpload` and leaves `selectFileById` to earn its own case.

// The only reasons a Database adapter method may be left out of the conformance specification.
// ADR-0035 names exactly these three as the mechanics that stay in per-engine tests, and the
// vocabulary is closed so that a fourth reason cannot be introduced by writing a new string in the
// exemption list below — it would have to change the assertion in the coverage test that pins this
// object to ADR-0035.
//
// One reason is deliberately absent, and its absence is the point of this check rather than an
// oversight. **Being overridden by an engine is not a reason.** ADR-0034 describes the await-shim:
// an override that emits the same SQL as the shared definition purely to resolve a result before
// deriving from it. Where one exists the shared definition is still wrong and merely dormant, so it
// needs a conformance case more than an unshadowed method does. Six such shims were removed while
// this feature was built and all six shared bodies were genuinely broken underneath; a rule that
// excused "the engines override this anyway" would have excused precisely those six.
export const CONFORMANCE_EXEMPTION_CATEGORIES = {
  "connection-lifecycle": "Opening, probing and closing an engine connection (ADR-0035).",
  "sql-dialect-emission": "Emitting statement text that differs because the dialects differ (ADR-0035).",
  "transaction-session": "Transaction session mechanics such as the libSQL baton (ADR-0035).",
};

// Each entry is a visible decision in a diff: the method, which of the three mechanics it is, and
// why that applies to this method in particular.
export const CONFORMANCE_EXEMPT_METHODS = [
  {
    method: "exec",
    category: "sql-dialect-emission",
    reason:
      "A statement primitive. Its argument is engine-specific SQL supplied by the caller, so it has " +
      "no engine-agnostic answer to assert; ADR-0034 places engine-specific behaviour here on purpose.",
  },
  {
    method: "prepare",
    category: "sql-dialect-emission",
    reason:
      "The other statement primitive, and the seam the dual-mode return convention is built on. " +
      "Conformance cases use it to seed and to read raw rows, but what it answers is the engine's " +
      "own result shape rather than a behaviour defined once above it.",
  },
  {
    method: "withTransaction",
    category: "transaction-session",
    reason:
      "Transaction session mechanics: BEGIN/COMMIT on a shared synchronous connection for SQLite " +
      "against the libSQL baton. ADR-0026 keeps workflow-level Transaction boundaries verified " +
      "above the adapter and ADR-0035 leaves the session mechanics to the per-engine tests.",
  },
  {
    method: "withReadOnlySnapshot",
    category: "transaction-session",
    reason:
      "The read-only form of the same mechanics — `PRAGMA query_only` against a read-only " +
      "transaction session — and equally per-engine.",
  },
  {
    method: "close",
    category: "connection-lifecycle",
    reason:
      "Connection lifecycle. Every conformance run closes its adapter during teardown, but what " +
      "closing means, and what a closed adapter then does, is engine machinery rather than a " +
      "behaviour code above the adapter reads an answer from.",
  },
];

// The method set the Database adapter exposes: its own enumerable function properties. Overridden
// methods are indistinguishable from inherited ones here, and that is intended — the enumeration
// must not be able to drop a method on the grounds that an engine replaced it.
export function databaseAdapterMethodNames(adapter) {
  return Object.entries(adapter)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name)
    .sort();
}

// The methods `engineAdapter` replaces rather than borrowing from the shared definition. Compared
// by source text because each adapter factory builds fresh closures, so the shared methods of two
// adapter instances are equal in body and never identical by reference.
export function overriddenDatabaseAdapterMethodNames(sharedAdapter, engineAdapter) {
  return databaseAdapterMethodNames(engineAdapter).filter(
    (name) => typeof sharedAdapter[name] === "function" && String(sharedAdapter[name]) !== String(engineAdapter[name]),
  );
}

// Wraps an adapter so that every method a conformance case calls directly is recorded. Calls the
// adapter makes into itself are not recorded: the depth counter is raised for the duration of a
// call, so a sibling-method call reached from inside a method body arrives at depth one and is
// skipped. A method has to be exercised by a case in its own right to count as covered.
//
// The depth counter's invariant: it is only sound while the outer method returns synchronously.
// `finally { depth -= 1 }` runs when the wrapped function returns, which for an `async` method is
// its first `await` rather than its completion, so any sibling call that method makes afterwards
// would be recorded at depth zero and credited as if a case had made it.
//
// Two shared methods reach that path. `migrateAppSchema` and `migrateExistingAppTable` route their
// work through `withTransaction`, so on every engine they return at the transaction's first
// `await`. What that costs is bounded and was measured rather than assumed: the whole migration
// body runs synchronously on SQLite before that `await`, so every sibling method it calls is still
// recorded below depth zero, and the only call that lands in the resumed continuation is the
// transaction's own closing `exec`. `exec` is exempt, so no method earns coverage it has not been
// exercised for. That bound is a property of these two methods and not of the counter: a shared
// method that awaited partway through its own body and then called a sibling would quietly inflate
// coverage, and the fix at that point is to track depth per asynchronous context rather than in one
// counter.
export function recordDirectAdapterCalls(adapter, calledMethodNames) {
  let depth = 0;
  const recording = new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") {
        return value;
      }
      return function recorded(...args) {
        if (depth === 0) {
          calledMethodNames.add(property);
        }
        const callArgs = property === "withTransaction" && typeof args[0] === "function"
          ? [
              (transactionAdapter, ...callbackArgs) =>
                args[0](recordDirectAdapterCalls(transactionAdapter, calledMethodNames), ...callbackArgs),
              ...args.slice(1),
            ]
          : args;
        depth += 1;
        try {
          return value.apply(this === recording ? receiver : this, callArgs);
        } finally {
          depth -= 1;
        }
      };
    },
  });
  return recording;
}

// The check itself, kept as a pure function so its own failure can be tested without an adapter or
// a database. Everything it reports is a way for the specification and the method set to have
// drifted apart.
export function reviewConformanceMethodCoverage({
  methodNames,
  coveredMethodNames,
  exemptions = CONFORMANCE_EXEMPT_METHODS,
  categories = CONFORMANCE_EXEMPTION_CATEGORIES,
}) {
  const covered = new Set(coveredMethodNames);
  const exemptNames = new Set(exemptions.map((exemption) => exemption.method));

  return {
    // A method the Database adapter exposes that no conformance case exercises and no exemption
    // accounts for. This is the failure the ticket exists to produce.
    uncovered: methodNames.filter((name) => !covered.has(name) && !exemptNames.has(name)),
    // An exemption for a method that no longer exists, which would otherwise silently keep
    // excusing a name after the method behind it was renamed or removed.
    staleExemptions: exemptions.filter((exemption) => !methodNames.includes(exemption.method)).map((e) => e.method),
    // An exemption claiming a reason outside the three ADR-0035 mechanics.
    unknownCategories: exemptions
      .filter((exemption) => !Object.hasOwn(categories, exemption.category))
      .map((exemption) => `${exemption.method}: ${exemption.category}`),
    // An exemption with no recorded reason is a silent omission wearing an entry's clothes.
    missingReasons: exemptions
      .filter((exemption) => typeof exemption.reason !== "string" || exemption.reason.trim().length === 0)
      .map((exemption) => exemption.method),
    covered: methodNames.filter((name) => covered.has(name)),
  };
}
