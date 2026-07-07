# Database writes use intended transaction boundaries

Sporades verifies database write safety by naming the intended Transaction boundary for each runtime-owned write workflow, not by wrapping every individual write statement. Multi-write workflows that must succeed or fail as one unit use Database adapter transactions; single-statement writes may remain explicitly classified as database-atomic, and Host server registry writes remain outside this policy because they use Host server locking and atomic replacement rather than Database adapter state.

Workflow-level transaction semantics are verified above the Database adapter so they remain engine-agnostic, while SQLite, libSQL, and future service-backed adapter mechanics are verified at the adapter boundary unless an audit finding exposes engine-specific workflow behavior.
