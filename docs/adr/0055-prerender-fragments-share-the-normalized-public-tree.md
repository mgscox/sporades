# ADR-0055: Prerender fragments share the normalized public tree

Status: Accepted

## Context

Client Input Chaser demonstrated a useful static landing page with a project Vite
plugin. Capsules need the capability without adopting its framework or creating
a second HTML lifecycle. Sporades deliberately does not provide request-time SSR.

## Decision

The Bundle pipeline's Vite adapter owns ordered, explicit, project-relative
render modules and a single placement transform over Vite's fully composed HTML,
including deferred project-plugin tag descriptors. Source HTML
remains author-owned and byte-for-byte unchanged. Named/bare comment markers or
body fallback place trusted HTML verbatim, bounded by private comments without
wrappers. Duplicate/unused/unknown placements warn; invalid configuration and
renderer failures reject the candidate. Reserved boundary comments cannot be
returned as fragment delimiters.

Renderer code is trusted like project Vite configuration. It receives no Server
runtime, Session, Database, query, mutation or Server-env context. Disposable
Workers isolate execution caches and globals without claiming a security sandbox.
Code dependencies are bundled; retained computed dynamic imports are rejected
instead of resolving from the CLI directory. Ordinary Vite client inputs own
CSS/images/fonts, with no renderer-owned asset graph.

Final normalized-tree path, collision, symlink, count and byte limits remain
authoritative. Dev observes renderer code dependencies with its existing watcher
and retains last-successful output after failure. Container and Hosted release
packaging/install/inspection/switching carry the same tree; neither adds rendering
logic. No live Hosted Capsule is required to prove release conformance.

The framework-neutral browser `prerender` API discovers readonly snapshots of
opaque named boundaries and supports individual, named and complete idempotent
dismissal. Nothing dismisses automatically. Capsules decide when interactive
content is ready; without JavaScript, static output remains. Removing script nodes
does not undo effects already executed. This is static-shell handover, not SSR,
personalization, hydration or component-state reconciliation.

## Evidence and consequences

One shared Capsule fixture covers Dev rebuild/failure recovery, initial HTML and
hashed assets in a real Container, and local Hosted archive installation and
atomic switching. Bundle placement tests cover ordered/duplicate/head/body
placements and warnings; DOM tests cover deliberate handover. Public definitions,
generated API docs and shipped artifacts travel with the implementation.

Client Input Chaser is prior art, not a test dependency. Migrating that application,
adding esbuild support, route crawling and automatic fragment dismissal remain
separate work.
