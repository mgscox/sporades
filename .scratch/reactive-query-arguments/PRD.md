# Argument-bearing reactive queries

Status: ready-for-agent

Architectural context: the existing Sporades client transport remains the sole
realtime seam. The feature is compatible with the decisions that App messages
use SDK interfaces over that transport, Dev and deployed Capsules run Bundles,
and deployed server Bundles remain self-contained.

## Problem Statement

Capsule authors can declare reactive server queries, and client code can keep
those queries subscribed across reconnects and successful mutation refreshes.
However, a query subscription can currently identify only a query name. It
cannot carry the positional inputs required to read an explicitly identified
resource.

This blocks Capsules whose read target must be selected independently by each
browser context. In particular, a Team-scoped Capsule must let two tabs name two
different Team IDs without storing a mutable current Team in server state or
turning reads into mutations. Directly invoking a query handler with a Team ID
does not solve the problem because the shipped browser transport cannot carry
that ID.

Adding arguments only to the server handler would leave the public client
interface, reconnect behavior, mutation refresh, channel sharing, framework
adapters, generated runtime, and published declarations out of agreement. The
feature therefore needs one backwards-compatible contract across the complete
reactive query path.

## Solution

Sporades will support JSON-compatible positional arguments on declared Custom
query subscriptions. Capsule authors can declare typed server query arguments,
and every exported client query adapter can pass those arguments after the
query name. Framework-neutral subscriptions retain the listener in its existing
position and place query arguments after it. Existing argument-free calls remain
unchanged.

The generated client runtime will normalize query arguments into an immutable
canonical JSON snapshot, a stable argument identity, and an exact byte count.
Canonical equality ignores object-key insertion order while preserving array
order. Channels are looked up structurally by query name and then argument
identity, so equal tuples share an existing channel and different tuples remain
independent. Reconnect, refresh, and unsubscribe operate on the stored snapshot
rather than caller-owned references.

The server runtime will independently validate and snapshot the received
argument array before query lookup. It will reject malformed, non-JSON, or
oversized inputs generically and will never execute a handler for an invalid
payload. Declared Custom queries receive the validated tuple after their normal
Capsule context. Runtime-owned and implicit query paths remain argument-free.

The principal acceptance seam is the public reactive query interface over the
real WebSocket client transport through to the declared server handler. Focused
type and normalization tests supplement that seam where compile-time behavior
or pre-serialization JavaScript values cannot be observed after JSON parsing.

## User Stories

1. As a Capsule author, I want a declared query to accept typed positional arguments, so that reads can target explicit resources.
2. As a Capsule author, I want a Team ID passed explicitly to a Team-scoped query, so that authorization never depends on mutable current-Team state.
3. As a Capsule author, I want query arguments constrained to JSON values, so that the declared interface matches what the transport can preserve.
4. As a Capsule author, I want server handler parameter types inferred from my query declaration, so that incorrect handler use is caught during type checking.
5. As a Capsule author, I want existing argument-free query declarations to remain valid, so that adopting the new release does not force unrelated edits.
6. As a React author, I want to pass query arguments after the query name, so that parameterized reads remain natural inside components.
7. As a Preact author, I want the same query convention as React, so that the shared hook adapter remains source-compatible.
8. As a Vanilla TypeScript author, I want to pass query arguments after the existing subscription listener, so that framework-neutral clients can use parameterized reads.
9. As a Vue author, I want composables to propagate query arguments, so that Vue Capsules receive the same server behavior.
10. As a SolidJS author, I want query primitives to propagate query arguments, so that Solid Capsules do not require a transport escape hatch.
11. As a Lit author, I want query controllers to propagate query arguments, so that Web Components can subscribe to explicit resources.
12. As an Inferno author, I want query adapters to propagate query arguments, so that class-component lifecycle behavior remains complete.
13. As a Svelte author, I want query stores to propagate query arguments, so that Svelte subscriptions remain native and reactive.
14. As an existing Capsule author, I want every name-only query call to behave exactly as before, so that the package change is backwards compatible.
15. As an existing transport client, I want a subscription frame without an argument field to mean an empty tuple, so that old clients continue to work.
16. As a Custom query author, I want validated arguments spread after the Capsule context, so that query handlers follow the same positional style as mutations.
17. As a browser user, I want two subscriptions to the same query with different arguments to remain independent, so that one view cannot replace another view's target.
18. As a browser user, I want two tabs to name different Team IDs concurrently, so that changing one tab does not retarget the other.
19. As a client-runtime maintainer, I want equal query names and equal argument tuples to share one wire subscription, so that existing channel-sharing efficiency is preserved.
20. As a client-runtime maintainer, I want object key insertion order ignored when comparing arguments, so that semantically equal inline objects do not create duplicate channels.
21. As a client-runtime maintainer, I want array order preserved in argument identity, so that positional and ordered values remain distinct.
22. As a React or Preact author, I want a deep-equal inline argument object to avoid subscription churn on rerender, so that ordinary component syntax remains efficient.
23. As a React or Preact author, I want a changed argument tuple to unsubscribe the previous channel and subscribe the new channel, so that the displayed state follows current props.
24. As a framework author, I want query argument handling to respect native lifecycle cleanup, so that parameterized queries do not leak subscriptions.
25. As a reconnecting browser, I want each active query to resend its original argument snapshot, so that connection recovery preserves the selected resource.
26. As a mutation caller, I want a successful mutation to refresh every active query with that query's own arguments, so that reactive state remains correct across targets.
27. As a subscriber, I want unsubscribing one argument tuple to leave other tuples active, so that cleanup is scoped to the exact channel.
28. As a subscriber, I want duplicate unsubscribe calls to remain harmless, so that existing idempotent lifecycle behavior is preserved.
29. As a Capsule author, I want caller-owned argument objects copied at subscription time, so that later mutation cannot silently retarget reconnect or refresh.
30. As a Capsule author, I want the initial frame, reconnect frame, and mutation refresh to use the same immutable snapshot, so that subscription identity and execution cannot diverge.
31. As a security reviewer, I want non-array argument payloads rejected before query lookup, so that malformed input cannot reach a handler or reveal query existence.
32. As a security reviewer, I want functions, undefined values, symbols, bigint values, non-finite numbers, cyclic structures, dates, and custom class instances rejected in client JavaScript, so that serialization never changes query meaning silently.
33. As a security reviewer, I want the server to perform independent authoritative validation, so that a handcrafted client cannot bypass client checks.
34. As a security reviewer, I want invalid query argument errors to remain generic, so that validation does not disclose handler or table details.
35. As an operator, I want query arguments bounded to 64 KiB of canonical UTF-8 JSON, so that a subscription cannot retain an unbounded argument tuple.
36. As an international Capsule author, I want the size limit measured in UTF-8 bytes rather than JavaScript code units, so that multibyte values have deterministic behavior.
37. As a client author, I want a payload at the exact limit accepted and a payload one byte over rejected, so that the interface has a precise boundary.
38. As a security reviewer, I want canonical objects to preserve hostile-looking JSON keys safely, so that normalization cannot mutate an object prototype.
39. As a Capsule author, I want `__proto__`, `constructor`, and `prototype` preserved as ordinary own JSON properties, so that valid JSON is not corrupted by normalization.
40. As a security reviewer, I want canonicalization to create no inherited pollution, so that one subscription cannot affect later code.
41. As a client-runtime maintainer, I want query names and argument identities stored in nested maps, so that delimiter-like query names cannot collide with serialized arguments.
42. As a Capsule author, I want query names containing punctuation or JSON-like text to remain distinct, so that the full existing string-name space stays safe.
43. As a Capsule author, I want implicit table queries to reject non-empty arguments, so that unsupported inputs are never silently ignored.
44. As a Capsule author, I want runtime-owned query paths to reject non-empty arguments, so that their existing meaning remains explicit.
45. As a legacy transport user, I want the rows-style subscription path to remain argument-free and compatible, so that the new direct-query capability does not redefine the old path.
46. As a runtime caller, I want direct query execution without an argument parameter to continue working, so that internal tests and trusted callers remain compatible.
47. As a TypeScript client author, I want client arguments constrained to JSON values without a false promise of per-name arity inference, so that declarations are honest about the available type information.
48. As a documentation reader, I want the calling convention, validation rules, equality semantics, size limit, and built-in-query behavior documented together, so that correct use does not depend on reading runtime code.
49. As a maintainer, I want one pure client argument normalizer shared by public subscriptions and framework adapters, so that validation and identity rules do not drift.
50. As a maintainer, I want the React and Preact hook dependency derived from the canonical identity, so that lifecycle correctness does not depend on caller object identity.
51. As a maintainer, I want a newly created channel to store an already normalized result without repeating normalization, so that identity and snapshot creation have one implementation.
52. As a maintainer, I want the server subscription to store its validated snapshot, so that refresh behavior does not reconstruct or lose arguments.
53. As a release maintainer, I want source declarations, generated runtime output, generated documentation, and packaged files to agree, so that consumers receive the reviewed capability rather than source-only intent.
54. As a release maintainer, I want the complete Node 22 gate run before accepting a candidate, so that evidence uses the supported runtime baseline.
55. As a release maintainer, I want the packed package inspected before publication, so that exported declarations and shipped runtime code are verified at the package boundary.
56. As a reviewer, I want an immutable commit and package candidate reviewed independently, so that later edits cannot inherit stale approval.
57. As a package owner, I want implementation to stop at a reviewed candidate by default, so that green tests do not silently authorize npm publication.
58. As a package owner, I want npm publication to require separate explicit authority, so that an external release is deliberate.
59. As a downstream maintainer, I want Client Input Chaser integration to require separate authority, so that a Sporades package change does not silently modify another repository.
60. As a downstream reviewer, I want real browser proof with concurrent Team targets after publication, so that the shipped package—not a direct handler test—unblocks Team-scoped work.

## Implementation Decisions

- The existing public reactive query interface and WebSocket client transport
  remain the external seam. This feature deepens that module rather than adding
  an endpoint, a second socket, or a Team-specific transport.
- Hook, composable, primitive, store, controller, and adapter query interfaces
  accept positional arguments after the query name. Framework-neutral query
  subscriptions retain the listener as their second parameter and accept
  positional arguments after it.
- Existing name-only calls are source- and runtime-compatible. A missing
  argument field in a subscription frame defaults to an empty array.
- Server query declarations accept a JSON-value tuple type and infer the
  declared handler parameters. Client declarations constrain arguments to JSON
  values but do not infer per-query arity from an arbitrary query-name string.
  A typed name-to-handler registry is a separate design.
- Declared Custom query handlers receive the validated positional tuple after
  the normal Capsule context.
- One shared pure client argument-normalization implementation validates an
  argument array and returns an immutable deep JSON snapshot, a canonical
  argument identity, and the UTF-8 byte length of the snapshot's JSON encoding.
- Canonical equality is deep JSON equality. Array order is significant. Object
  key order is insignificant, so keys are sorted recursively before identity is
  derived. Numbers use their JSON representation, so values that JSON itself
  normalizes identically have one identity.
- Normalization rejects values that JSON cannot represent without loss or
  transformation, including undefined values, functions, symbols, bigint,
  non-finite numbers, cyclic structures, dates, and custom class instances.
- Canonical snapshots retain no caller-owned array or object references and are
  immutable after normalization. Caller mutation after subscription cannot
  change identity, initial transmission, reconnect, or refresh execution.
- Canonical objects are created with null prototypes or safe own-property
  definition. They are never populated through assignment that could invoke the
  legacy prototype setter. The JSON keys `__proto__`, `constructor`, and
  `prototype` remain ordinary own properties.
- React and Preact query hooks normalize on every render to derive the canonical
  dependency identity. Their subscription effect depends on query name and that
  identity, then passes the already normalized result to the internal normalized
  subscription function. A new channel stores that result directly and does not
  normalize it again.
- Public framework-neutral subscriptions normalize once before calling the same
  internal normalized subscription function. Other framework adapters use that
  common interface while preserving their established lifecycle behavior.
- Client query channels use a nested structural lookup from query name to
  canonical argument identity to channel. Query names and serialized argument
  text are never joined with a delimiter.
- A shared channel owns one immutable argument snapshot, latest query state, and
  listener set. Its initial subscribe frame and every reconnect frame contain
  that snapshot. The last listener's idempotent unsubscribe removes only that
  nested channel and sends one wire unsubscribe.
- A successful mutation refreshes every active server subscription by invoking
  its query with its stored argument snapshot. Existing generation checks still
  prevent stale asynchronous results from replacing newer results.
- The server independently normalizes every supplied argument array before
  selecting a query path. Missing arguments become an empty tuple. Invalid or
  oversized values fail before query lookup and handler execution with a generic
  error that does not reveal query existence.
- The exact argument limit is 65,536 UTF-8 bytes, measured over the JSON encoding
  of the canonical argument snapshot only. The client rejects larger arguments
  before sending; the server enforces the same rule authoritatively. This is not
  a general WebSocket-frame limit.
- Only declared Custom queries accept non-empty arguments. Runtime-owned query
  paths, implicit table queries, and legacy rows-style subscriptions require an
  empty tuple and reject non-empty arguments rather than ignoring them.
- Direct trusted runtime query execution gains an optional JSON argument tuple
  whose default is empty, preserving all existing three-argument calls.
- Public reference material, getting-started guidance, generated interface
  documentation, generated runtime output, and package contents must describe
  and contain the same behavior. Generated files are produced by their owning
  build steps rather than edited by hand.
- The implementation remains general Sporades query capability. It introduces
  no Team state, Client Input Chaser terminology, or application authorization
  policy into the platform.
- The implementation stage ends at a tested, packaged, commit-pinned,
  independently accepted release candidate. npm publication requires separate
  explicit authority. Downstream package adoption and browser verification
  require another explicit authorization.

## Testing Decisions

- Tests prefer the highest existing seam: a public client query subscription
  sends a real WebSocket frame, the server runtime validates and stores the
  tuple, and a declared Custom query handler receives it. Assertions cover
  observable frames, query results, errors, and subscription behavior rather
  than private helper call order.
- Focused declaration tests compile valid typed server query tuples, reject
  incorrect server handler arity and types where supported, accept JSON-valued
  client arguments, and reject statically non-JSON client arguments. They do not
  claim query-name-based client arity inference.
- Focused client-normalizer tests cover JavaScript values that cannot survive a
  real JSON frame: undefined values, functions, symbols, bigint, non-finite
  numbers, cycles, dates, custom instances, and caller mutation after entry.
- Prototype-safety tests preserve `__proto__`, `constructor`, and `prototype` as
  own JSON properties, prove no prototype mutation or inherited pollution,
  prove key-order-independent identity, and observe those keys in initial and
  reconnect snapshots.
- Channel tests prove same name plus canonically equal arguments shares one wire
  subscription, while different tuples remain separate. Query names containing
  brackets, quotes, commas, pipes, and argument-like JSON text prove the nested
  map cannot produce composite-key collisions.
- Real WebSocket tests prove missing arguments default to empty, a string Team
  ID reaches the handler, malformed non-array input is rejected before handler
  execution, and two simultaneous Team-ID tuples receive their own results.
- Size-boundary tests accept exactly 65,536 UTF-8 bytes and reject 65,537 bytes
  on both client and server. Multibyte characters prove the implementation
  counts bytes rather than JavaScript code units.
- Query-path tests prove non-empty arguments are rejected for runtime-owned,
  implicit table, and legacy rows-style queries while empty and missing
  arguments preserve existing behavior.
- Mutation-refresh tests subscribe to the same query with distinct tuples,
  complete a successful mutation, and observe each subscription rerun with its
  own immutable tuple.
- Reconnect tests close and re-establish the shared page connection and observe
  the original immutable tuples on the new subscription frames. Mutating the
  caller's original input after subscribing must not alter those frames.
- Unsubscribe tests prove removing one argument channel leaves another active,
  shared listeners keep their wire channel until the last listener leaves, and
  repeated teardown remains harmless.
- React and Preact adapter tests prove changed canonical arguments replace the
  old subscription while deep-equal inline objects do not churn. Existing
  lifecycle harnesses provide prior art for effect cleanup.
- Vue, SolidJS, Lit, Inferno, and Svelte adapter harnesses prove equivalent
  argument propagation while retaining their existing native cleanup and state
  semantics.
- Direct runtime tests prove query execution without an argument parameter still
  runs an argument-free query unchanged, while explicit arguments reach only a
  declared Custom query.
- Existing client-runtime tests provide prior art for shared query channels,
  latest-state delivery, reconnect, and idempotent unsubscribe. Existing server
  transport and database-adapter tests provide prior art for real query handler
  execution and mutation-triggered refresh. Existing adapter harnesses provide
  the framework lifecycle seams.
- The complete supported Node 22 test and build gates must pass, including type
  declarations, client runtime, server runtime and Bundle execution, framework
  adapters, documentation, generated-file parity, packaging, and prepublish
  behavior. Configured database-adapter skips must be reported explicitly.
- The package tarball is inspected as the final Stage 1 seam. Its exported
  declarations, generated client runtime, server runtime, documentation, and
  version identity must match the reviewed commit.
- A source-only test, direct handler invocation, or green framework mock is not
  sufficient evidence that the feature is complete.

## Out of Scope

- Hidden current-Team, current-workspace, tenant, or other mutable server-side
  selection state.
- Team-specific behavior, Team authorization policy, or Client Input Chaser
  domain logic inside Sporades.
- Client-side arity or result inference from arbitrary query-name strings.
- Arguments for implicit table queries, runtime-owned query paths, or legacy
  rows-style subscriptions.
- A general WebSocket message or frame-size limit. This spec bounds only the
  canonical query argument tuple.
- Changing mutation argument typing or transport behavior beyond preserving the
  existing refresh of parameterized queries.
- Server-side query-result caching, persistence of query subscriptions, or
  cross-page channel sharing.
- Binary, streaming, cyclic, class-instance, date, bigint, undefined, function,
  symbol, or non-finite-number query arguments.
- npm publication without separate explicit authority.
- Updating Client Input Chaser, accepting its blocked Team ticket, or performing
  downstream browser proof without separate explicit authority.
- Introducing a second client transport, raw WebSocket access for Capsule code,
  or a Custom endpoint as a substitute for reactive queries.

## Further Notes

- The planning baseline is the published Sporades 0.8.3 release. The likely
  candidate version is the next patch release, but the implementation agent must
  verify current checkout, tags, registry state, and release conventions before
  preparing it.
- The downstream product invariant is that every Team-scoped operation names its
  Team ID explicitly. Active Team selection affects presentation and targeting;
  it does not grant authority.
- The downstream application remains blocked until an exact published Sporades
  package is installed and two concurrent browser subscriptions are observed
  targeting different Teams through the real runtime.
- ADR 0014 supports keeping application behavior behind SDK interfaces on the
  existing client transport. ADR 0004 requires Dev and deployed behavior to run
  through Bundles. ADRs 0040 and 0041 require server runtime changes and their
  helpers to travel through the self-contained module graph and generated
  package surfaces. This specification does not contradict those decisions.
- Any change to package bytes after the immutable candidate review invalidates
  that review and requires a new commit pin, package inspection, and acceptance.
