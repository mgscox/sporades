# User-owned HTML builds to a normalized public tree

Sporades treats `index.html` in the Capsule project as author-owned source and
the validated public asset tree in the Runtime directory as executable release
output. Every client toolchain must emit a required `public/index.html` and may
emit safe nested JavaScript, CSS, source-map, font, image, and other imported
asset paths beneath `public/`. Dev sessions, Container sessions, Hosted Capsule
packaging, Host server installation, rollback, verification, inspection, and
doctor consume this tree without depending on the framework or toolchain that
produced it.

The esbuild adapter preserves existing Capsules by copying the source HTML and
emitting `public/client.js`, so `/client.js` remains supported. Toolchains such
as Vite may instead transform the source HTML and emit hashed chunks or
extracted assets. Sporades may apply its bounded page-connection bootstrap when
serving the built HTML, but it does not replace or rewrite the author's source
file. Static serving does not imply SPA fallback routing.

Client toolchains are internal Bundle pipeline adapters. The Sporades Dev
session remains responsible for watching, structured rebuild events, and
browser refresh; a Vite adapter does not start a separate development server,
watcher, HTML middleware, or HMR WebSocket. Client builds are validated before
atomically replacing the last successful public tree, and receive neither
Server env nor unrestricted environment-file loading.

Public trees are recursive but bounded release inputs. Absolute or escaping
paths, ambiguous decoded paths, symlinks, normalization collisions, excess
files, and excess bytes are rejected before serving, mounting, packaging, or
installation. Container sessions mount the tree read-only, and Hosted Capsule
rollback switches the complete release directory so HTML and referenced assets
cannot cross release boundaries.

## Considered Options

- Keeping one fixed `/client.js` output was rejected because Vue, Svelte,
  SolidJS, and asset-producing toolchains require HTML transformation, compiler
  plugins, CSS extraction, or multiple linked files.
- Letting every toolchain expose its native output shape to downstream runtime
  and Host code was rejected because it would multiply Dev, Container, Hosted,
  verification, and security paths by framework.
- Giving Vite ownership of the Dev server was rejected because Sporades already
  owns runtime restart, security policy, inspection routes, the client
  WebSocket, JSONL lifecycle events, and execution parity.
- Generating the entire HTML shell was rejected because author ownership of
  metadata, analytics, fonts, semantic Journey markers, and custom markup
  remains valuable across frameworks.

## Consequences

- Infrastructure code must stop requiring individual `client.js` and
  `index.html` release mounts and instead consume the normalized public tree.
- Existing React and Preact Capsules retain their source contract and public
  URL while new toolchains may emit different internal filenames.
- Framework and toolchain admission is gated by one public-tree conformance
  suite rather than by adding special cases to every execution mode.
- Project-local Vite configuration and state-preserving HMR remain outside the
  initial supported contract.

This decision supersedes ADR 0010. ADR 0010's author-ownership principle is
preserved; its fixed, untransformed `index.html` plus `/client.js` runtime
contract is replaced.
