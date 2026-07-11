# Multi-framework client toolchains

Status: ready-for-agent

Planning source: `docs/ROADMAP.md` (Recommended Next Features: Multi-framework
client toolchains)

Architectural decision: `docs/adr/0032-user-owned-html-builds-to-a-normalized-public-tree.md`

## Problem Statement

Capsule authors can currently choose React or Preact, but both choices are
compiled by one React-shaped esbuild path into one fixed `/client.js` file.
The public `sporades/client` interface exposes query, mutation, and auth state
through `createHooks`, whose lifecycle contract fits React and Preact but not
Vue composables, Svelte stores, SolidJS signals, Lit reactive controllers, or
framework-neutral TypeScript.

This limitation is wider than the compiler invocation. The Bundle pipeline,
Dev session HTTP server, Container session mounts, Hosted Capsule release
archive and validation, Host server helper, inspection, verification, and
doctor checks all assume that a client release is exactly a user-owned
`index.html` plus `/client.js`. Frameworks that require compiler plugins, CSS
extraction, imported assets, or hashed chunks cannot fit that contract without
special cases leaking into every downstream execution path.

Capsule authors need framework-native client authoring while Sporades continues
to own one deterministic CLI, Bundle pipeline, Dev feedback loop, Container
contract, and Hosted release contract. Choosing a framework must not create a
second application model, expose Server env, or make Dev behavior diverge from
the release that runs in a Container session or Hosted Capsule.

## Solution

Sporades will admit client frameworks through an internal client-toolchain
adapter seam. The initial supported frameworks are Vanilla TypeScript, React,
Preact, Vue, Svelte, SolidJS, Lit, and Inferno. esbuild remains the compatible
default for existing React and Preact Capsules and the initial Vanilla
TypeScript path. Vite is added where its compiler-plugin and asset-graph model
is useful, without replacing esbuild for the Server Bundle or creating a
separate Vite-owned development server.

Every client toolchain produces the same normalized public asset tree. The
tree has a required HTML entry and may contain JavaScript chunks, CSS, source
maps, fonts, images, and other imported assets at safe relative paths. Dev,
Container, and Hosted execution consume that tree without knowing which
framework or toolchain produced it. Existing Capsules remain compatible: their
user-owned source HTML still loads `/client.js`, and the esbuild adapter emits
that path inside the normalized tree.

The user continues to own the source HTML shell. A client toolchain may
transform that source during the build, and Sporades may inject its connection
bootstrap into the built HTML while serving it, but Sporades does not replace
the author's source with a generated framework shell. This supersedes ADR 0010,
whose fixed runtime file contract cannot represent multi-file client output.

The public client SDK gains framework-neutral query subscriptions, mutation
execution, and auth-state observation over the existing transport. React and
Preact retain `createHooks`. Each other reactive framework receives a native
adapter over the same public primitives rather than an emulation of React
hooks. Existing framework-neutral commands for auth, preferences, Files, App
messages, and Journey remain shared directly.

The principal acceptance seam is a framework/toolchain matrix that scaffolds a
Capsule, builds it through the real Bundle pipeline, observes structured Dev
rebuild behavior, and verifies that the same normalized public tree is served
and packaged safely for Dev, Container, and Hosted execution.

## User Stories

1. As a Capsule author, I want to choose a supported client framework, so that I can use the reactivity and component model appropriate to my Capsule.
2. As an existing React Capsule author, I want my Capsule to keep using esbuild when no toolchain is configured, so that this feature does not force a migration.
3. As an existing Preact Capsule author, I want my Capsule to keep using esbuild when no toolchain is configured, so that existing projects remain deterministic.
4. As a React author, I want to opt into Vite, so that I can use its client asset and plugin model without changing the Sporades runtime model.
5. As a Preact author, I want to opt into Vite, so that I can use Vite while retaining Preact's JSX runtime and dependencies.
6. As a Vanilla TypeScript author, I want an immediately runnable framework-neutral scaffold, so that a Capsule does not require a component framework.
7. As a Vue author, I want to use Single-File Components and scoped styles, so that Sporades supports idiomatic Vue authoring.
8. As a Svelte author, I want to compile Svelte components and component styles, so that Sporades supports idiomatic Svelte authoring.
9. As a SolidJS author, I want the supported JSX transform and Vite integration, so that the client uses Solid's reactive model rather than React behavior.
10. As a Lit author, I want to author Web Components with Lit, so that the client can use reactive controllers and standard custom elements.
11. As an Inferno author, I want Inferno-specific JSX and lifecycle behavior, so that compatibility does not secretly depend on React.
12. As a Capsule author, I want unsupported framework and toolchain combinations rejected before building, so that failures include structured, actionable guidance.
13. As a Capsule author, I want the scaffold to select the normal toolchain for my framework, so that I do not need to understand the compiler matrix before starting.
14. As a Capsule author, I want to override the normal toolchain only where the combination is supported, so that configuration remains explicit and validated.
15. As a Capsule author, I want `sporades create` to install the exact framework and toolchain dependencies needed by my selection, so that the scaffold runs immediately.
16. As a Capsule author, I want every supported template available for every admitted framework, so that choosing Vue or Svelte does not silently reduce the product surface.
17. As a Capsule author, I want generated client code to be idiomatic for its selected framework, so that the scaffold teaches the correct lifecycle model.
18. As a Capsule author, I want generated agent instructions to name the selected framework and supported client APIs, so that an AFK agent does not apply React assumptions to another framework.
19. As a Capsule author, I want to retain ownership of my source HTML, so that I can control metadata, fonts, analytics, semantic Journey markers, and custom markup.
20. As a Capsule author, I want the client toolchain to transform my source HTML when required, so that framework entry modules and built asset URLs are correct.
21. As an existing React or Preact author opting into Vite, I want an actionable HTML-entry migration error, so that Sporades does not produce a release whose script URL cannot load.
22. As an existing Capsule author, I want `/client.js` to continue working, so that the normalized public tree is backwards compatible.
23. As a Capsule author, I want imported CSS and static assets included in the release, so that client output is not limited to one JavaScript file.
24. As a Capsule author, I want nested and hashed asset paths served with correct content types, so that production output behaves as built.
25. As a Capsule author, I want source maps handled consistently by the selected toolchain, so that client diagnostics remain useful without changing the release contract.
26. As a Capsule author, I want a failed client build to preserve the last successful Dev output, so that a syntax error does not turn the running Dev session into a partial release.
27. As a Capsule author, I want corrected edits to rebuild successfully without restarting the CLI, so that the Dev feedback loop remains continuous.
28. As a Capsule author, I want a successful client rebuild to refresh connected browsers, so that edits become visible without a second development server.
29. As a Capsule author, I want structured build success and failure events to identify the client toolchain, so that agents can diagnose compiler failures deterministically.
30. As a Capsule author, I want framework compiler diagnostics normalized into Sporades errors and hints, so that JSONL output remains toolchain-independent.
31. As a Capsule author, I want Dev sessions to own file watching and refresh behavior, so that Vite does not introduce a competing lifecycle or WebSocket endpoint.
32. As a Capsule author, I want Dev, Container, and Hosted execution to serve the same built public files, so that local success predicts release behavior.
33. As a Capsule author, I want Container sessions to mount the public tree read-only, so that client assets retain the existing runtime hardening boundary.
34. As a Host server operator, I want Hosted release validation to accept safe multi-file public trees, so that framework assets can be deployed without weakening archive validation.
35. As a Host server operator, I want unsafe paths, symlinks, duplicate entries, and unexpected release files rejected, so that recursive asset packaging does not create traversal or overwrite risks.
36. As a Host server operator, I want Hosted Capsule rollback to restore one complete public tree, so that HTML and its hashed assets cannot come from different releases.
37. As an operator, I want doctor and inspection output to report the effective framework, toolchain, HTML entry, and public asset summary, so that I can diagnose a release without assuming `/client.js`.
38. As an AFK agent, I want build, package, and verification results available as structured data, so that framework failures do not require scraping terminal prose.
39. As a Capsule author, I want client output to exclude Server env values, so that adopting Vite does not create an environment-variable leak.
40. As a Capsule author, I want Sporades to own the supported Vite configuration and plugins, so that project-local Vite configuration cannot make Dev and Hosted builds disagree.
41. As a Capsule author, I want client dependencies resolved from my Capsule project, so that framework versions are explicit in the project rather than hidden in the global CLI.
42. As a Vanilla TypeScript author, I want to subscribe to query state without React hooks, so that transport state can drive plain DOM code.
43. As a Vanilla TypeScript author, I want to run mutations through a public framework-neutral command, so that data changes do not require an adapter.
44. As a Vanilla TypeScript author, I want to observe auth state with an explicit unsubscribe handle, so that page lifecycle cleanup is deterministic.
45. As a client-framework adapter author, I want query listeners to receive the same data, loading, and error semantics as existing hooks, so that adapters do not reinterpret transport results.
46. As a client-framework adapter author, I want mutation execution to preserve the standard Sporades result envelope, so that framework-native state never hides server failures.
47. As a client-framework adapter author, I want auth observation to deliver the latest known state and later changes, so that newly mounted UI converges immediately.
48. As a Vue author, I want Sporades query, mutation, and auth state exposed through Vue-native composables, so that subscription cleanup follows Vue scope disposal.
49. As a Svelte author, I want Sporades state exposed through Svelte-native stores, so that subscriptions start and stop through the store lifecycle.
50. As a SolidJS author, I want Sporades state exposed through signals or resources, so that ownership and cleanup follow Solid's reactive root.
51. As a Lit author, I want Sporades state exposed through reactive controllers, so that subscriptions follow host connection and disconnection.
52. As an Inferno author, I want a native adapter with Inferno lifecycle cleanup, so that query and auth subscriptions do not leak after unmount.
53. As a React or Preact author, I want `createHooks` to remain source-compatible, so that framework-neutral primitives do not break existing client code.
54. As a Capsule author, I want preferences, Files, App messages, and Journey commands to remain framework-neutral, so that adapters stay narrow and coherent.
55. As a Capsule author, I want Journey navigation and semantic interaction capture to remain in the browser client runtime, so that every framework observes the same privacy and consent contract.
56. As a security reviewer, I want static serving to decode and validate request paths before file access, so that nested public assets do not permit traversal.
57. As a security reviewer, I want the HTML connection bootstrap applied only to the selected HTML response, so that arbitrary assets are never rewritten as HTML.
58. As a security reviewer, I want generated and copied public files bounded by release validation rules, so that a malformed toolchain output cannot produce an unbounded archive.
59. As a release maintainer, I want the package manifest and public type declarations to cover every supported client subpath, so that source, generated output, and published tarballs agree.
60. As a documentation reader, I want one capability matrix of supported framework and toolchain combinations, so that examples do not over-promise unsupported pairings.
61. As a maintainer, I want each framework admitted through the same toolchain and public-asset interfaces, so that framework support does not become a switch statement across the platform.
62. As a maintainer, I want the Server Bundle to remain on the existing esbuild path, so that client framework work does not destabilize server compilation.
63. As a maintainer, I want one high-level conformance suite for the framework matrix, so that adding an adapter proves the whole Capsule lifecycle rather than isolated compiler output.
64. As a maintainer, I want representative real-runtime smoke coverage for both esbuild and Vite releases, so that mocked packaging tests do not conceal execution drift.
65. As a maintainer, I want the roadmap and ADR history to describe the final contract, so that `/client.js` assumptions do not survive as contradictory architecture.

## Implementation Decisions

- The supported framework/toolchain matrix is:
  - Vanilla TypeScript: esbuild by default.
  - React: esbuild by default; Vite supported explicitly.
  - Preact: esbuild by default; Vite supported explicitly.
  - Vue: Vite.
  - Svelte: Vite.
  - SolidJS: Vite.
  - Lit: Vite. esbuild may be admitted later only through the same conformance bar.
  - Inferno: esbuild by default; Vite supported explicitly.
- `sporades.json` remains the durable project configuration boundary. Its client
  configuration records the framework and may record the toolchain. Missing
  toolchain configuration preserves the legacy esbuild default for existing
  React and Preact Capsules; new scaffolds write the resolved choice explicitly.
- `sporades create` accepts framework and toolchain selection, validates the
  matrix before writing files, and records the resolved pair. Unsupported
  combinations fail with the existing structured command-error shape.
- The Server Bundle remains compiled with esbuild. Vite is a client-toolchain
  adapter, not a replacement for the entire Bundle pipeline.
- The Bundle pipeline owns an internal client-toolchain interface. An adapter
  receives normalized Capsule configuration, the project root, source HTML,
  client entry, output location, and a diagnostic sink. It returns one
  normalized public asset result rather than exposing esbuild or Vite output
  objects to Dev, Container, or Host code.
- The normalized release contract is a Server Bundle plus a `public` asset
  tree and runtime configuration. The public tree must contain `index.html`.
  All other files are optional safe relative paths. Directories are packaged
  recursively; symlinks and paths that are absolute, escape the tree, decode
  ambiguously, or collide after normalization are rejected.
- The esbuild adapter emits the existing client Bundle as `public/client.js`
  and copies the user-owned source HTML to `public/index.html`. Existing source
  HTML and `/client.js` behavior therefore remain compatible.
- Vite scaffolds write a module reference to the project client entry in source
  HTML so Vite can follow the source graph and rewrite it to built assets.
  Selecting Vite for an existing `/client.js` HTML shell fails before release
  creation with guidance to update the script entry; Sporades does not silently
  mutate the author's source file.
- Vite uses the user-owned source HTML as its build entry and emits transformed
  HTML plus chunks, extracted CSS, and imported assets into the public tree.
  Sporades owns Vite's programmatic configuration and supported compiler
  plugins. Project-local Vite configuration files are not consumed in this
  scope because they would make the release contract and support matrix open
  ended.
- Vite environment-file loading is disabled. The client build receives no
  `.env.sporades.server`, Sealed Server env, Host secrets, or unrestricted
  process environment. Any future public client configuration requires a
  separate explicit Sporades contract.
- Client builds write to a fresh temporary public tree and replace the last
  successful tree only after validation. A failed rebuild reports diagnostics
  and leaves the last successful public tree intact.
- The Dev session remains the sole owner of project watching, debounce,
  structured JSONL lifecycle events, and browser refresh. Vite's development
  server, watcher, HTML middleware, and HMR WebSocket are not started. V1 uses
  Sporades full-page refresh after a successful client rebuild and does not
  promise state-preserving HMR.
- Dev static serving resolves URL pathnames beneath the public root, serves
  known safe files with correct content types, and returns 404 for missing
  assets. `/` resolves to the required HTML entry. Sporades applies its
  per-page connection bootstrap only when serving that HTML. This feature does
  not add implicit SPA fallback routing.
- Container sessions mount the entire validated public tree read-only at one
  directory boundary rather than mounting individual client files. Hosted
  release creation, helper validation, installation, rollback, and inspection
  use the same recursive tree contract and preserve atomic release-directory
  switching.
- Release validation adds explicit bounds for file count, individual file size,
  aggregate public bytes, and relative path length. The implementation selects
  limits consistent with existing release and request bounds and exposes limit
  failures as structured errors; it must not accept an unbounded archive merely
  because the files are static.
- The public framework-neutral SDK adds `queries.subscribe(name, listener)`,
  `mutations.run(name, ...args)`, `auth.get()`, and
  `auth.subscribe(listener)`. Subscriptions return the existing idempotent
  `unsubscribe()` handle. Query and auth listeners receive an immediate latest
  state when known and subsequent complete state replacements; mutation calls
  retain the standard Sporades result envelope.
- React and Preact retain the existing `createHooks` export and behavior. It is
  implemented over, or kept contractually coherent with, the new public
  primitives without a source-breaking change.
- Framework-native adapters are exposed through explicit client subpaths for
  Vue, Svelte, SolidJS, Lit, and Inferno. Each subpath owns only the reactive
  binding and lifecycle cleanup; the transport, auth commands, preferences,
  Files, App messages, and Journey behavior remain in `sporades/client`.
- Native adapters use their framework's actual disposal boundary. They must
  not mimic React's `{ useState, useEffect }` interface or create independent
  WebSocket connections.
- The internal client runtime remains a singleton connection per page. All
  framework-neutral primitives and adapters share its reconnect, session,
  request, subscription, App-message, preferences, File, and Journey behavior.
- Framework and compiler packages belong to the scaffolded Capsule project.
  Sporades declares compatible dependency versions and resolves them from that
  project. The published Sporades package exposes required client subpaths and
  declarations without making every framework a runtime dependency of every
  Capsule.
- Structured Dev events and command errors identify the build phase, framework,
  and toolchain while normalizing compiler-specific diagnostics into bounded
  messages and hints. Raw compiler objects and absolute secret-bearing paths
  are not public JSON contracts.
- Public declarations, generated client runtime output, package export maps,
  scaffold documentation, user documentation, API documentation, doctor
  checks, and the roadmap must agree with the implemented capability matrix.
- ADR 0032 supersedes ADR 0010. The preserved decision is author ownership of
  source HTML; the replaced decision is that runtime client output must be one
  untransformed `index.html` plus `/client.js`.

## Testing Decisions

- Good tests assert Capsule-visible behavior and release contracts rather than
  the private shape of esbuild or Vite result objects. A compiler invocation is
  not sufficient proof; the built Capsule must be served or packaged through a
  real Sporades boundary.
- The highest test seam is a table-driven framework/toolchain conformance suite.
  Each supported pair is scaffolded, built through the Bundle pipeline, and
  checked for a valid public tree, loadable HTML entry, expected framework
  runtime, framework-neutral client operations, and absence of Server env.
- The same conformance fixtures exercise Dev startup, a failed edit followed by
  recovery, structured JSONL events, browser refresh notification, nested asset
  serving, content types, and traversal rejection.
- Release-contract tests feed normalized public trees containing nested hashed
  JavaScript, CSS, images, fonts, and source maps through Container mounts,
  Hosted archive creation, Host helper validation and installation, doctor,
  inspection, verification, and rollback.
- At least one esbuild framework and one Vite framework run as real Container
  sessions and Hosted Capsules in smoke coverage. Every supported pair must
  cross the same packaging and helper-validation code; the smoke matrix may use
  representative real runtimes where exercising every framework remotely would
  duplicate the already shared release seam.
- Framework-neutral SDK tests use the generated browser client runtime and a
  real WebSocket test server. They assert initial query/auth state, subsequent
  replacements, mutation results, reconnect resubscription, idempotent cleanup,
  and one shared connection.
- Adapter tests mount and dispose actual minimal components in their supported
  framework test environments. They assert native reactive updates and cleanup
  against the shared SDK contract, not adapter implementation fields.
- Existing React and Preact scaffold, Dev session, `createHooks`, Container,
  Host push, release verification, doctor, Journey, auth, Files, preferences,
  and App-message tests are regression prior art and remain green.
- Existing security tests for Hosted archive allowlists, unsafe entries, unsafe
  paths, read-only mounts, CSP, CORS, WebSocket origin validation, and Server env
  isolation are extended to the public-tree contract.
- Generated-output and publication tests verify source runtime parity, type
  declarations, export-map coverage, packaged files, and regenerated API docs
  for all public client entrypoints.
- Documentation tests verify that ADR 0010 is marked superseded, ADR 0032 is the
  active contract, the roadmap links this PRD, and the capability matrix is
  stated consistently without describing Vite as the Server bundler.

## Out of Scope

- Angular, because its workspace and builder model would be a separate platform
  integration rather than a contained Sporades client-toolchain adapter.
- Next.js, Nuxt, SvelteKit, SolidStart, Remix, Astro server rendering, and other
  server-owning meta-framework modes that would replace the Capsule server and
  routing model.
- Server-side rendering, static-site generation, React Server Components,
  hydration contracts, and framework-owned server routes.
- Replacing esbuild for the Server Bundle.
- A standalone Vite development server, Vite-owned file watcher, Vite HTML
  middleware, or a second public port.
- State-preserving hot module replacement. V1 guarantees rebuild recovery and
  full-page refresh after successful client builds.
- Arbitrary project-local Vite plugins or `vite.config.*` execution. Additional
  compiler plugins require deliberate admission to the supported matrix.
- A general-purpose user static-directory feature unrelated to client build
  output.
- Changing Sporades routing or adding implicit SPA history fallback.
- Public client environment variables or exposing Server env through Vite
  conventions.
- Cross-framework component interoperability or automatic conversion of an
  existing React client to another framework.
- Exact version-upgrade policy for framework majors beyond declaring and
  testing the supported dependency ranges shipped by each Sporades release.

## Further Notes

- The current implementation has one concentrated build seam but many leaked
  file assumptions. The first implementation slice must normalize the public
  tree for existing React/esbuild Capsules before Vite or another framework is
  admitted.
- The internal WebSocket runtime already owns query subscription, mutation, and
  auth observation behavior. Publishing narrow framework-neutral wrappers is
  preferable to creating a second transport abstraction.
- The implementation issues already published beneath this PRD remain the
  delivery graph. Their dependency order intentionally establishes the public
  asset contract and framework-neutral SDK before adding compiler-heavy
  frameworks, then contracts remaining `/client.js` assumptions at the end.
- Implementation completion must update `docs/ROADMAP.md` from `ready` to
  `implemented` and move the feature into Recently Implemented while retaining
  this PRD for traceability.
