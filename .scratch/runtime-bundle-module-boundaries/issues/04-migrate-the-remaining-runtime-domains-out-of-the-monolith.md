Status: ready-for-agent

# Migrate The Remaining Runtime Domains Out Of The Monolith

## Parent

.scratch/runtime-bundle-module-boundaries/PRD.md

## What to build

The rest of the runtime leaves the 14,148-line module and becomes modules, batch by batch,
until nothing but composition remains behind. The domains sitting in there together today
are mail, schedules, ACL, file and S3 storage, auth, jobs, HTTP handling, security policy
and the database adapters — none of which have any reason to share a file beyond the
bundling mechanism that required it.

**This ticket is a placeholder to be split.** Sizing the batches now would be guesswork;
the first migrate batch is what establishes the real blast radius of moving a domain — how
much incidental coupling has accumulated between neighbours that never had a boundary
between them, and how much of the emitted list a single domain touches. Split this into
one ticket per batch once that is known, and size the batches by what actually turns out
to be entangled rather than by the domain list above.

Run the batches as a linear chain, not in parallel. Every batch deletes from the same file
and edits the same emitted list, so concurrent batches conflict continuously — the pattern
that has already cost this codebase real time. A shared integration branch would avoid the
conflicts but defer green to the end, which is the opposite of what makes a batch
sequence safe. Sequenced, each batch is independently verifiable and independently
revertible.

Both bundles keep building throughout. That is what lets a batch land green: the domain
that just moved travels through the module graph, everything still behind travels as
stringified text, and the two bundles must answer identically after every batch.

Expect to find incidental coupling that the single file has been hiding — helpers reached
across domain lines, shared mutable state, constants used by two domains that belong to
neither. Untangling those is part of the work, and where a boundary is genuinely unclear,
record the decision rather than settling it silently in a diff.

## Acceptance criteria

- [ ] This ticket is split into per-batch tickets before implementation begins, sized by the blast radius the first migrate batch established.
- [ ] Every runtime domain lives in a module; the original runtime module retains composition and wiring only.
- [ ] Each batch lands green on its own, with both bundles building and answering identically after it.
- [ ] Batches are sequenced, not concurrent.
- [ ] Coupling discovered between domains is resolved deliberately, and any boundary that required a judgement call is recorded.
- [ ] No behavioural change to any runtime surface across the whole sequence.
- [ ] The emitted-list path still builds at the end of the last batch; deleting it is the next ticket, not this one.

## Blocked by

- .scratch/runtime-bundle-module-boundaries/issues/03-move-the-read-only-inspection-validator-into-a-module.md
