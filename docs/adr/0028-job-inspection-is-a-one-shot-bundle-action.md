# Job inspection is a one-shot Bundle action

Job inspection uses the generated server Bundle's internal
`--sporades-action jobs.inspect` mode across Dev sessions, local Container
sessions, and Hosted Capsules. The Bundle branches before Capsule-module
evaluation or normal runtime startup, reads all Job state through the configured
Database adapter in one read-only snapshot, emits one bounded JSON envelope,
and exits. This keeps inspection runtime-owned and Bundle-consistent without an
HTTP/API route, generic SQL access, or a second inspector artifact; Container
and Host transports invoke the same action through `docker exec`.
