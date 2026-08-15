# 02 — Carry Custom query arguments through the client transport

**What to build:** Let a framework-neutral client subscription send JSON-compatible positional arguments through the real Sporades WebSocket transport to a typed declared Custom query, while preserving argument-free clients and ensuring every subscription retains its own validated tuple across sharing, reconnect, mutation refresh, and teardown.

**Blocked by:** 01 — Normalize and structurally key query channels.

**Status:** ready-for-agent

- [ ] Capsule query declarations accept typed JSON-value positional tuples and infer the corresponding server handler parameters.
- [ ] Framework-neutral query subscriptions accept JSON-constrained positional arguments after the existing listener parameter without breaking name-only calls.
- [ ] A real direct-query subscription frame carries its arguments as an array, invokes the declared handler with the Capsule context followed by those arguments, and returns the handler result.
- [ ] A missing argument field defaults to an empty tuple and preserves existing argument-free handler behavior.
- [ ] The server independently validates and snapshots supplied arguments before query lookup or handler execution.
- [ ] Malformed, non-array, non-JSON, and oversized payloads receive a generic safe error, do not execute a handler, and do not reveal whether the query exists.
- [ ] The server accepts exactly 65,536 UTF-8 bytes of canonical argument JSON and rejects 65,537 bytes, including multibyte coverage.
- [ ] Non-empty arguments are rejected for runtime-owned queries, implicit table queries, and legacy rows-style subscriptions; empty and missing arguments remain compatible.
- [ ] Two simultaneous subscriptions to the same query with different tuples remain distinct and receive the correct results.
- [ ] The same query with canonically equal tuples, including differently ordered object keys, shares one client wire channel.
- [ ] Successful mutations refresh every active subscription with that subscription's stored immutable tuple.
- [ ] Reconnect resends each active subscription's original immutable tuple.
- [ ] Unsubscribing one tuple leaves other tuples active, shared listeners keep their exact channel alive, and repeated teardown remains harmless.
- [ ] Mutating caller-owned input after subscription cannot change the initial frame, reconnect frame, channel identity, or refreshed server arguments.
- [ ] Direct trusted runtime query execution accepts an optional JSON tuple whose empty default preserves every existing argument-free call.
- [ ] Client and server declarations constrain arguments honestly without claiming per-query client arity inference from arbitrary query-name strings.
- [ ] Focused reference documentation explains the framework-neutral convention, Custom-query restriction, validation behavior, canonical equality, and size limit.
- [ ] Source runtime, generated server Bundle behavior, public declarations, and existing argument-free suites agree.
