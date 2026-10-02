# Building the Client

The client SDK provides subscribed queries, mutations, authentication state,
files, preferences, App messages, and Journey state over the Sporades transport.

Build the first screen around one subscribed query and one mutation. Queries
remain subscribed across reconnects; mutations trigger the normal connected
refresh path. Own subscription cleanup through the adapter for your framework,
or call `unsubscribe()` when using the framework-neutral client directly.

Start with
[queries, mutations, and auth state](../reference/client-auth-and-preferences.md#building-the-client-side).
Framework adapters bind that same transport to each admitted framework; they do
not change the server contract. See
[Choose a client framework](./projects.md#choose-a-client-framework) for all
eight supported choices and their scaffolded reactivity model.

## Project public files

Place explicitly public files in the optional project `public/` directory.
`public/favicon.ico`, `public/sitemap.xml`, and `public/robots.txt` are served at
`/favicon.ico`, `/sitemap.xml`, and `/robots.txt`; nested files retain their paths
and exact bytes. Sporades merges them into the normalized release tree with both
esbuild and Vite. XML is served as `application/xml; charset=utf-8`, ICO as
`image/x-icon`, and TXT as `text/plain; charset=utf-8`, for GET and HEAD.

These assets are unauthenticated. Keep secrets, Server env, and private resources
out of `public/`. Files outside that directory are not included. Symlinks, unsafe
paths, the reserved `__sporades` namespace, collisions (including case aliases)
with generated output (including `index.html`), and combined output-limit
violations reject the build.
The limits are 512 files, 16 MiB per file, 64 MiB total, and 240 UTF-8 bytes per
relative path. Dev observes additions, edits, and deletions, keeping the last
successful tree after a failed candidate. Container and Hosted releases include
the same files; restart and rollback use the release tree without a source mount.
Sporades does not generate sitemap content or crawler rules.

## Public asset caching

The generated Capsule server serves Vite-style content-hashed assets beneath
`/assets/` with `Cache-Control: public, max-age=31536000, immutable`. This applies
to filenames ending in `-<hash>.<extension>` (and their `.map` files), where
`<hash>` is the eight-character URL-safe hash emitted by the Vite pipeline.
Nested asset directories are supported. Keep this naming convention reserved
for content-versioned output: changed bytes must receive a new URL.

HTML always receives `Cache-Control: no-store` and `Pragma: no-cache`, including
the `/` and `/index.html` entry document that carries a fresh connection token
on document navigation. Other assets receive `Cache-Control: no-cache`, requiring
revalidation instead of an edge's default freshness lifetime. A query string or
placement inside `/assets/` alone does not make an asset immutable. Unversioned
esbuild output such as `client.js` also uses this conservative policy.

The policy is shared by Dev, Container and Hosted Capsules through the generated
server Bundle; no per-app proxy configuration is needed.

## Build static prerender fragments

A Vite-backed Capsule can publish useful static HTML before its client starts.
Declare ordered, uniquely named project-relative render modules in `sporades.json`:

```json
{
  "client": {
    "framework": "react",
    "toolchain": "vite",
    "prerender": [
      { "name": "landing", "module": "client/render/landing.ts" },
      { "name": "footer", "module": "client/render/footer.ts" }
    ]
  }
}
```

Each module default-exports a zero-argument function returning an HTML string or
`Promise<string>`. Names start with a letter and contain at most 64 letters,
digits, underscores or hyphens. Modules execute sequentially in declaration
order during the Bundle pipeline. This configuration is rejected for esbuild clients.

Use `<!-- sporades:prerender landing -->` to place one named fragment, or
`<!-- sporades:prerender -->` to place all fragments in declaration order.
Markers can appear in the head or body and may coexist or repeat. With no
markers, all fragments appear immediately after the opening body element;
fallback placement fails if that element is absent. Source HTML is never rewritten.
The Sporades transform runs after project HTML plugins. Renderer output is inserted
verbatim once and surrounded by private comments, without wrapper elements.

Repeated placements, configured but unused fragments, and unknown marker names
produce successful builds with warnings. Unknown markers remain comments. Human
CLI output prints the warning text; structured Dev, Container and Hosted build
results expose `warnings` entries with `code`, `fragment` and `message`.
Codes are `PRERENDER_DUPLICATE_PLACEMENT`, `PRERENDER_UNUSED_FRAGMENT`, and
`PRERENDER_UNKNOWN_MARKER`. Duplicate configured names and renderer failures are
errors; a failed candidate does not replace the last successful public tree.

Renderers are trusted build code, with the same filesystem/network authority as
project Vite configuration. Sporades supplies no Server runtime, Session, Database
or Server-env context and does not load project environment files into the client
build. This is static generation, not SSR or hydration. Returned HTML is not
sanitized; active markup retains normal browser behavior. Renderer imports do not
create a second public asset graph: local CSS, images and fonts must already be
emitted by the ordinary Vite client graph.
See the [render-module contract](../reference/prerender-modules.md) for CommonJS,
ESM, Worker isolation and literal dynamic-import requirements. Dev tracks renderer
modules and their transitive code imports through its existing rebuild watcher.

### Hand over to the interactive client

Fragments remain visible until the Capsule explicitly dismisses them. After your
interactive screen is ready, use the framework-neutral client API:

```ts
import { prerender } from "sporades/client";

const snapshot = prerender.discover();
for (const boundary of snapshot.filter((item) => item.name === "landing")) {
  boundary.dismiss();
}
prerender.dismiss("footer"); // Every current placement with this name.
prerender.dismiss(); // Every current fragment, in head and body.
```

Discovery returns a readonly snapshot with one opaque handle per placement. A
handle exposes only its name and an idempotent `dismiss()` operation. Unknown
names and repeated dismissal are harmless. Importing the SDK, connecting, and
framework mounting do not dismiss anything automatically. Preserve the static
shell until your replacement content is ready; without JavaScript it stays
visible. Dismissal removes nodes, not effects of scripts that already ran. This
is deliberate static-shell replacement, not framework hydration.
Sporades boundary comments are private and reserved. Actual boundary comments in
renderer output, source HTML, or an HTML plugin fail the build, even when
prerender is disabled. This prevents embedded delimiters from truncating dismissal
or claiming author-owned content. Use only the public discovery and dismissal API.

Next: [authentication](./auth.md), [files](./files.md), or [realtime features](./realtime.md).
