# Database Adapter Engine Conformance

Status: ready-for-agent

## Source Planning

- `docs/adr/0021-database-adapter-is-internal-runtime-boundary.md`
- `docs/adr/0022-acl-rules-are-runtime-policy-functions.md`
- `docs/adr/0026-database-writes-use-intended-transaction-boundaries.md`
- `docs/adr/0033-runtime-owned-password-reset-links.md`
- `.scratch/database-adapter/PRD.md`
- `.scratch/database-adapter/issues/06-make-database-adapter-runtime-path-awaitable.md`
- `CONTEXT.md`

## Problem Statement

A Capsule that works correctly in a Dev session silently misbehaves when the same
code runs against a Capsule service database. The Capsule author changes no code,
sees no error, and gets no failed request — they get wrong answers.

Six confirmed instances, all in shipped code, all invisible until someone looked:

- Email sign-up was impossible on Postgres and libSQL. Every attempt returned
  "Email is already registered", including against an empty database.
- `Reference()` integrity checks accepted references to rows that do not exist.
- Completing an Upload call for a new file never wrote its File metadata row, so
  the upload reported success and the file was not there.
- The reserved Privileged server role user was readable as an ordinary Sporades
  user through Session and email credential lookups.
- The ADR-0033 cap on outstanding Reset codes per email never tripped, leaving
  reset-code issuance unbounded on those engines.

The cause is one mechanism, not six mistakes. The Database adapter method set is
defined once on the SQLite adapter and borrowed by the Postgres and libSQL
adapters, which override the statement primitives with asynchronous versions.
Method bodies written against a synchronous `prepare()` therefore derive their
result from an unresolved query rather than from the row. `Boolean(pendingQuery)`
is always `true`; `Number(pendingQuery?.count ?? 0)` is always `0`; a branch on
`pendingQuery.changes` always takes the same path.

Every one of these failures produced a plausible wrong value rather than an
error, so nothing crashed and no test caught them. The existing per-engine tests
assert engine mechanics — connection handling, result normalization, transaction
sessions, migrations — while the behavioural assertions live only in
SQLite-backed tests. Behaviour that code above the adapter depends on is
currently specified for one engine and assumed for the others.

This also recurs. `authIdentityRowUnlessReserved` was already made
promise-aware pointwise before this work, and the ADR-0033 password reset
feature — recently written, carefully designed — introduced a fresh instance in
`countPasswordResetCodesForEmail` on its first new counting method. The pattern
generates instances faster than review finds them.

## Solution

The Database adapter commits to one explicit behavioural contract, and that
contract is verified by a single conformance specification executed against
every adapter.

Capsule authors get the guarantee ADR-0021 already promises in prose: behaviour
above the Database adapter does not depend on the selected engine. Choosing
Postgres or libSQL for a Capsule service becomes an operational decision with no
behavioural consequences.

Maintainers get a mechanical check. A Database adapter method that behaves
differently on one engine fails a test in the ordinary `npm test` run, on the
commit that introduces it, rather than reaching a Hosted Capsule and surfacing as
a Capsule author's bug report.

The contract keeps the dual-mode calling convention established by the completed
`06-make-database-adapter-runtime-path-awaitable` issue. That issue made runtime
call sites awaitable, which is necessary but not sufficient: awaiting at the call
site does not help when the wrong value is computed inside the method. The rule
this spec adds governs the inside of the method.

## User Stories

1. As a Capsule author, I want email sign-up to work on every database engine, so that choosing a Capsule service does not silently disable account creation.
2. As a Capsule author, I want `Reference()` fields to reject references to rows that do not exist regardless of engine, so that my data integrity constraints mean the same thing everywhere.
3. As a Capsule author, I want an Upload call that reports success to have written its File metadata, so that files I believe are stored are actually retrievable.
4. As a Capsule author, I want password reset limits to hold on every engine, so that the protections ADR-0033 specifies are real in production and not only in a Dev session.
5. As a Capsule author, I want to move a Capsule from the default SQLite store to a Postgres or libSQL Capsule service without auditing my app for behavioural differences.
6. As a Capsule author, I want a Dev session to be a faithful rehearsal of a Hosted Capsule, so that local green means deployed green.
7. As a security-conscious Capsule author, I want the reserved Privileged server role identity to be unreadable as an ordinary user on every engine, so that runtime identity guards are not engine-dependent.
8. As a Sporades maintainer, I want one behavioural specification for the Database adapter, so that adapter behaviour is defined in a single place rather than implied by whichever engine a test happened to use.
9. As a Sporades maintainer, I want that specification executed against every adapter, so that engine divergence is a test failure rather than a production discovery.
10. As a Sporades maintainer, I want the conformance run to cover at least two engines without external infrastructure, so that divergence is caught in an ordinary local or CI test run.
11. As a Sporades maintainer, I want conformance assertions to compare against expected values rather than merely asserting that a call did not throw, because five of the six known defects returned a plausible wrong value without throwing.
12. As a Sporades maintainer, I want the rule that a Database adapter method must resolve its query result before deriving any decision from it stated as a decision I can point at in review.
13. As a Sporades maintainer adding a Database adapter method, I want conformance coverage to be part of what "done" means, so that new methods cannot repeat this class of defect.
14. As a Sporades maintainer, I want a method that inspects its own query result to be visibly distinguishable from one that merely returns it, so that the risky shape is obvious while reading a diff.
15. As a future implementer of a new engine adapter, I want an executable definition of correct adapter behaviour, so that I can build against a specification rather than reverse-engineering the SQLite adapter.
16. As a future implementer, I want the conformance spec to tell me which methods my adapter must implement and what each must return, so that partial adapters fail loudly and early.
17. As an agent working in this repo, I want the adapter contract recorded as an ADR, so that I do not reintroduce the pattern while following the surrounding code's style.
18. As a maintainer reviewing an agent's adapter change, I want a single command that proves engine parity, so that review does not depend on spotting a subtle synchronous-result bug by eye.
19. As a maintainer, I want the Postgres conformance run to use the same specification as the others even though it stays gated on external infrastructure, so that gating affects only when it runs and never what it checks.
20. As a maintainer, I want the known-divergent behaviour of synchronous ACL rules against asynchronous adapter reads recorded, so that a real portability gap is tracked rather than forgotten.

## Implementation Decisions

### The Database adapter behavioural contract

- The Database adapter method set is engine-agnostic and defined once. Engine-specific behaviour belongs in the statement primitives and connection handling, not in per-engine copies of the method set.
- A Database adapter method may return either a plain value or a Promise. This dual-mode calling convention is retained deliberately, not by inertia: ADR-0022's ACL context exposes `ctx.acl.db.get()` and `ctx.acl.storage.get()` to ACL rules that may be written synchronously, and those helpers fail closed when an adapter read is asynchronous. Requiring every adapter method to return a Promise would make every synchronous ACL rule fail closed on every engine, which is a Capsule-facing breaking change.
- The invariant: a Database adapter method must never derive a value, a branch, or a guard from an unresolved query result. It may return a query result directly, and the caller awaits it. It may not test it, count it, coerce it, or read a property off it without resolving it first.
- Methods that need to inspect a result use the runtime's existing promise-aware helper rather than assuming a synchronous statement primitive, so one definition is correct under both synchronous and asynchronous engines.
- This narrows rather than reverses `06-make-database-adapter-runtime-path-awaitable`. That issue governs how call sites consume adapter methods; this invariant governs how adapter methods consume their own statement primitives.

### Conformance specification

- One conformance specification is parameterised by a Database adapter factory and executed once per engine. It is the single seam for this work; behaviour is asserted at the Database adapter boundary that ADR-0021 defines, not duplicated at a higher runtime seam.
- The specification runs against the SQLite adapter directly, against the libSQL adapter through the existing in-process fake libSQL service harness, and against the Postgres adapter when a Postgres URL is configured in the environment. Gating controls only whether the Postgres run happens, never what it asserts.
- At least two engines must run in an ordinary `npm test` invocation with no external infrastructure, so engine divergence is caught locally and in CI rather than only in an environment that happens to have a database service.
- Every assertion compares an observed value against an expected value. "Did not throw" is not an assertion, because the known defects did not throw.
- Coverage prioritises methods that derive a value from a query result, since that is the shape that produced every known defect: existence checks, counts, guards that suppress a row, and multi-step methods that branch on an intermediate result.
- Coverage includes each method's negative case. An existence check must be exercised against both a present and an absent row, and a count against a known non-zero quantity; a defect that always returns `true` or always returns `0` passes any single-case assertion.
- Methods whose behaviour is genuinely engine-specific — connection lifecycle, SQL dialect emission, transaction session mechanics such as the libSQL baton — remain covered by the existing per-engine tests and are out of the shared specification.
- Adding a method to the Database adapter without adding it to the conformance specification leaves the work incomplete.

### Architecture decision records

- Record the adapter behavioural contract as an ADR: the method set is engine-agnostic and defined once, the dual-mode return convention is deliberate and why, and the invariant that a method must resolve a query result before deriving anything from it. State the ACL fail-closed interaction as the reason async-first was rejected, so a future reader does not reopen it without that constraint.
- Record the conformance specification as an ADR: one behavioural specification is the verification contract for the Database adapter boundary, executed against every adapter, with engine mechanics remaining in per-engine tests. Note that it is the executable form of the agnosticism ADR-0021 asserts in prose.
- Both follow the existing ADR house style: a decision-stating title and prose paragraphs, using `CONTEXT.md` vocabulary, with no status or consequences headings.
- Neither ADR contradicts an existing decision. Both extend ADR-0021, and the first records a constraint that ADR-0022 imposes on the adapter boundary.

### Domain vocabulary

- `CONTEXT.md` defines the Database adapter as mapping the Sporades table API and runtime storage "onto one database engine's connection behavior and SQL dialect", with code above it remaining agnostic. That definition already implies this contract; consider whether the engine-agnostic method set and the conformance obligation deserve to be explicit there.

## Testing Decisions

### What makes a good test here

- Assert observable behaviour of the Database adapter boundary: what a method returns for a given stored state. Do not assert how a method reaches that answer, whether it returned a Promise, or which helper it used internally — a correct adapter must be free to satisfy the contract either way.
- Compare against expected values. Every known defect returned a plausible wrong value while throwing nothing, so smoke-style coverage would have passed on all six.
- Exercise both sides of every predicate. An always-`true` existence check and an always-`0` count each satisfy a single positive assertion.
- Prefer one specification executed many times over parallel per-engine suites that drift. A per-engine test that asserts behaviour is a place where engines are allowed to disagree.
- Drive real adapters against real storage. The libSQL harness is a genuine HTTP service in-process, which is what makes its asynchronous statement primitives exercise the code path that SQLite's synchronous ones hide.

### Modules under test

- The Database adapter factories for SQLite, Postgres, and libSQL, at the adapter boundary.
- The runtime-owned storage surfaces reached through that boundary: auth storage including Sessions, email credentials and Reset codes; File metadata storage; app table reads and writes; reference integrity; system metadata; and the Log index.

### Prior art in this codebase

- `test/database-adapter.test.js` already drives the libSQL adapter through the fake service and the Postgres adapter behind an environment gate; it is the natural host for the conformance runs and shows the established setup and teardown shape.
- `test/database-adapter-service-backed-spike.test.js` is the closest existing precedent for the intended structure: one sequence of representative runtime paths executed against a non-default adapter.
- `test/support/libsql-http-service.js` provides the in-process libSQL service, including a `beforeStatement` hook used by existing tests to interleave statements deterministically.
- `test/support/service-backed-sqlite-adapter.js` and `test/support/sqlite-http-service.js` show how an adapter with asynchronous primitives is assembled for tests.
- The regression tests added alongside the six fixes — covering email auth end to end, reference integrity, File metadata insertion, the reserved-user guards, and the Reset code cap — are the seed cases for the shared specification.

## Out of Scope

- Migrating the Database adapter to an async-first contract where every method returns a Promise. Rejected for this spec because of the ACL fail-closed interaction described above; reopening it requires deciding what happens to synchronous ACL rules.
- Redesigning how ACL rules handle asynchronous adapter reads. The fail-closed behaviour of synchronous ACL rules against asynchronous engines is a real portability gap and is noted below, but it is an ADR-0022 question and needs its own spec.
- A public Database adapter or plugin API. ADR-0021 defers this and nothing here changes that.
- Adding new database engines, or broadening SQL dialect portability.
- Host server registry state, which ADR-0026 keeps outside Database adapter policy.
- Transaction isolation semantics on a shared synchronous connection. Related, but a separate concern from result resolution.
- Changing `ctx.db`, the Sporades DB API, or any Capsule authoring surface. This work is invisible to Capsule code by design.

## Implementation Issues

- `issues/01-record-adapter-contract-and-conformance-adrs.md`
- `issues/02-run-conformance-specification-against-every-adapter.md`
- `issues/07-open-a-conflict-free-conformance-extension-seam.md`
- `issues/03-extend-conformance-coverage-to-auth-storage.md`
- `issues/04-extend-conformance-coverage-to-file-metadata-storage.md`
- `issues/05-extend-conformance-coverage-to-app-tables-and-runtime-metadata.md`
- `issues/06-require-conformance-coverage-for-every-adapter-method.md`
- `issues/08-map-every-runtime-column-name-on-postgres.md`
- `issues/09-route-shared-schema-migration-through-a-transaction.md`
- `issues/10-sequence-the-log-index-for-engine-independent-order.md`
- `issues/11-extract-the-shared-method-set-behind-an-engine-seam.md`
- `issues/12-quote-identifiers-consistently-in-emitted-sql.md`
- `issues/13-emitted-bundle-must-define-every-identifier-it-references.md`
- `issues/14-guard-the-log-index-additive-migration.md`
- `issues/15-teach-the-sql-skipper-about-dollar-quoted-strings.md`
- `issues/16-serialize-the-bundle-preamble-constants.md`

## Running the Postgres leg locally

The Postgres conformance run is gated on `SPORADES_POSTGRES_TEST_URL`. It is not
optional detail: three defects in this feature shipped as reasoned-but-unverified
because nobody had run it, and the first real run found a fourth.

    docker run -d --name sporades-conformance-pg \
      -e POSTGRES_PASSWORD=sporades -e POSTGRES_USER=sporades \
      -e POSTGRES_DB=sporades_conformance -p 55432:5432 postgres:16-alpine

    export SPORADES_POSTGRES_TEST_URL="postgres://sporades:sporades@127.0.0.1:55432/sporades_conformance"

`postgres:16-alpine` matches the image the Capsule service compose uses. The
suite resets the runtime tables on entry, so the database can be reused between
runs, and `npm test` serialises files so concurrent resets cannot collide.

## Further Notes

The six defects described in the problem statement are already fixed on
`claude/sweet-hellman-d2b597`, each with a regression test that fails without the
fix. That branch resolves the immediate breakage; this spec addresses the
mechanism that produced it and would otherwise produce the next one.

The strongest argument for the conformance suite is the sixth defect. The
password reset work is recent, deliberately designed code whose ADR reasons
explicitly about constant-time comparison, selector/verifier splits and
enumeration resistance — and it still introduced a fresh instance of this defect
on its first new counting method. The author had no way to see it: the method is
correct where it is written and only becomes wrong when a different adapter
borrows it. Review has now failed to catch this pattern at least seven times,
counting the pointwise fix that predates this work. It needs a mechanical check.

One related divergence was found and deliberately left unfixed: a synchronous ACL
rule calling `ctx.acl.db.get()` fails closed when the adapter read is
asynchronous, so a Capsule whose ACL rules are synchronous can deny access on
Postgres or libSQL where it would allow on SQLite. This is fail-closed and
therefore safe, but it is a genuine portability difference between engines and is
tracked here so it is not rediscovered as a bug.

The conformance suite should be expected to fail when first written against all
three engines. Any failure it surfaces beyond the six known defects is the point
of building it.
