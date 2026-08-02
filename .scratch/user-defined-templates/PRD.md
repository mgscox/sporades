# User-defined Templates

Status: ready-for-agent

## Problem Statement

Sporades scaffold templates are a closed set of built-in exemplars — `blank`,
`todo`, `guestbook`, `photo-library`, and `campfire`. The `--template` flag
only accepts one of those names; anything else is rejected with a structured
error. Template file generation is a hardcoded switch with per-framework
layering, and there is no code path for reading files from an external source.

Developers who have curated their own starting project — their own defaults,
conventions, shared components, or internal boilerplate — cannot re-use it
through `sporades create`. They must scaffold a built-in template and then
manually replace files, or copy a project by hand and fix up `sporades.json`
and `package.json`.

A common workflow is: run `sporades create` with a built-in template, modify
the generated project into a personalised starting point, and then want to use
that modified project as the basis for future scaffolds. But the modified
project carries Sporades runtime artifacts (`.sporades/`, `node_modules/`,
`package-lock.json`, `.git/`, `.env.sporades.server` with real secrets) that
must not be copied into a new scaffold.

## Solution

Allow `--template` to accept a local directory path in addition to built-in
template names. When the value resolves to an existing directory, Sporades
treats it as a user-defined template: it copies the directory tree into the new
project, honouring the template's own `.gitignore` to skip excluded paths,
then ensures the Sporades wrapper configuration is correct.

The `--template` value is resolved against the filesystem first. If it points
to an existing directory, Sporades uses it as a user-defined template and skips
the built-in template name check. If it is not a directory, Sporades falls
through to the existing built-in name validation. This means existing workflows
passing built-in names like `--template todo` are unaffected, and a local
directory named `todo` takes precedence (intuitive — the user pointed at
something concrete).

## User Stories

1. As a developer, I want to point `--template` at a local folder containing my own project skeleton, so that I can scaffold new projects from my personalised defaults.
2. As a developer, I want `sporades create` to automatically detect that my `--template` value is a directory path, so that I don't need a separate flag to switch modes.
3. As a developer, I want built-in template names to still work when no matching local directory exists, so that my existing workflows are completely unaffected.
4. As a developer, I want Sporades to reject `--template` values that are neither a directory nor a built-in name, so that typos are caught at scaffold time.
5. As a developer, I want Sporades to skip every file matched by my template's `.gitignore`, so that runtime artifacts like `node_modules/` and `.sporades/` are never copied into the new scaffold.
6. As a developer, I want Sporades to always skip `.git/` regardless of `.gitignore` contents, so that version control history from the source project is never inherited.
7. As a developer, I want Sporades to always skip and regenerate `.env.sporades.server` as a blank default, so that secrets from the source project are never leaked into the new scaffold.
8. As a developer, I want Sporades to copy my template's `.gitignore` into the new project, so that my custom ignore patterns are preserved.
9. As a developer, I want Sporades to use my template's `sporades.json` if present, so that framework, toolchain, auth, and security settings are carried over.
10. As a developer, I want Sporades to override the `name` field in my template's `sporades.json` with the new project name, so that the scaffolded project has the correct identity.
11. As a developer, I want Sporades to generate a default `sporades.json` if my template doesn't include one, so that the scaffold is runnable without manual config.
12. As a developer, I want Sporades to merge the `sporades` dev dependency and `dev`/`deploy` scripts into my template's `package.json`, so that the Sporades CLI is available in the new project.
13. As a developer, I want Sporades to preserve all existing dependencies, scripts, and metadata in my template's `package.json`, so that my custom dependencies are not lost during the merge.
14. As a developer, I want Sporades to generate a `package.json` with framework-specific dependencies if my template doesn't include one, so that the scaffold is runnable out of the box.
15. As a developer, I want to override the framework with `--framework` even when using a user-defined template, so that I can scaffold the same template for a different framework.
16. As a developer, I want to override the toolchain with `--toolchain` even when using a user-defined template, so that I can control the build toolchain independently.
17. As a developer, I want Sporades to fall back to the framework declared in my template's `sporades.json` when I don't pass `--framework`, so that the template's intended framework is used by default.
18. As a developer, I want Sporades to default to React and esbuild when neither the CLI flag nor the template config specifies a framework, so that the scaffold works with zero configuration.
19. As a developer, I want Sporades to validate the resolved framework/toolchain against the client capability matrix, so that unsupported combinations are caught at scaffold time with a structured error and hint.
20. As a developer, I want Sporades to copy my template's custom files — components, utilities, assets, styles — verbatim, so that my personalised project structure is preserved exactly.
21. As a developer, I want Sporades to generate a default `index.html` with the correct script source for the resolved toolchain if my template doesn't include one, so that the scaffold has a valid HTML shell.
22. As a developer, I want Sporades to generate default `AGENTS.md` and `CLAUDE.md` files if my template doesn't include them, so that agent instructions are present in the new project.
23. As a developer, I want Sporades to generate a default `.gitignore` if my template doesn't include one, so that runtime artifacts are excluded in the new project.
24. As a developer, I want `--json` output to report the resolved template directory path in the `data.template` field, so that scripts and agents can verify which template was used.
25. As a developer, I want CLI help to mention that `--template` accepts a local directory path, so that the feature is discoverable without reading documentation.
26. As a developer who scaffolded a project with a built-in template and then customised it, I want to use that customised project as a template source, so that I can replicate my setup across multiple new projects.
27. As a developer, I want Sporades to reject scaffolding into the same directory as the template source, so that I don't accidentally copy a project into itself.
28. As an agent, I want to create a template directory programmatically and then scaffold from it in a single `sporades create` call, so that I can set up project structures without hardcoding file contents in the command.
29. As a developer, I want Sporades to ignore `package-lock.json` when my `.gitignore` excludes it, so that the lockfile from the source project doesn't conflict with the merged dependencies after `npm install`.
30. As a developer, I want Sporades to handle a template directory with no `.gitignore` by copying everything except `.git/` and `.env.sporades.server`, so that a minimal template directory works without requiring an ignore file.

## Implementation Decisions

### Template value resolution

The `--template` flag parser resolves the value against the filesystem before
checking the built-in template set. If the value resolves to an existing
directory (relative to CWD or absolute), it is treated as a user-defined
template: a `templateDir` option is set to the resolved absolute path and the
built-in name validation is skipped. If the value is not a directory, the
existing `SUPPORTED_TEMPLATES` check runs unchanged. Values that are neither a
directory nor a built-in name produce the same structured error as today.

A self-reference guard rejects the case where the resolved template directory
equals the resolved project directory, preventing a project from being copied
into itself.

### Ignored entries

The template root `.gitignore` is read if present and evaluated against every
file path relative to the template root using a gitignore-style matching
library (the `ignore` npm package or equivalent). Only the top-level
`.gitignore` is read; nested `.gitignore` files in subdirectories are not
evaluated in this version.

Two entries are always ignored regardless of `.gitignore`:
- `.git/` — version control history is never inherited.
- `.env.sporades.server` — may contain real secrets; always regenerated as a
  blank default.

The `.gitignore` file itself is copied into the new project (it is source
configuration), unless the template author has explicitly listed it in their
own ignore patterns.

### Framework and toolchain resolution

The resolved framework and toolchain are determined in priority order:
1. `--framework` / `--toolchain` CLI flags if provided.
2. The template's `sporades.json` `client.framework` / `client.toolchain` if
   present and no CLI flag was passed.
3. Default `react` / `esbuild`.

The resolved pair is validated against the client capability matrix (same
`clientCapability` check as built-in templates). Unsupported combinations
produce a structured error with an actionable hint, identical to the existing
behavior for built-in scaffolds.

### Wrapper configuration merge

- **`sporades.json`**: if the template includes one, it is parsed and the
  `name` field is overridden with the new project name. All other fields
  (client, auth, security, deploy, dev, services, etc.) are preserved. If
  absent, a default is generated with the same shape as built-in scaffolds
  (anonymous auth, resolved framework/toolchain, standard security/deploy/dev
  blocks) but with the `template` field omitted. If present and the source
  config includes a `template` field, it is preserved as-is.

- **`package.json`**: if the template includes one, it is parsed and the
  following are ensured:
  - `scripts.dev` is set to `"sporades dev"`
  - `scripts.deploy` is set to `"sporades deploy"`
  - `devDependencies.sporades` is set to the resolved Sporades version range
  - `devDependencies.typescript` is set to `"^5.8.0"`
  All existing dependencies, devDependencies, scripts, and metadata fields are
  preserved. If absent, a `package.json` is generated with framework-specific
  dependencies (same dependency maps as built-in scaffolds) plus the Sporades
  dev dependency and standard scripts.

- **`.env.sporades.server`**: always regenerated as a blank default, never
  copied from the source template.

### Gap-filling for missing files

If the template does not include any of the following, Sporades generates
defaults:
- `index.html` — with the correct script src for the resolved toolchain
  (`/client.js` for esbuild, `/client/<entry>` for Vite).
- `AGENTS.md` and `CLAUDE.md` — generated via the existing `agentsTemplate`
  helper with the resolved framework, toolchain, and template path.
- `.gitignore` — the standard default (`node_modules/`, `.sporades/`,
  `.env*.local`).

All other files from the template directory are copied verbatim with no
transformation.

### CLI output

The `--json` result envelope `data.template` field reports the resolved
template directory path for user-defined templates. For built-in templates,
the field reports the built-in name as before. The `data.path` field is
unchanged.

CLI help for the `create` command is updated so the `--template` line mentions
that a local directory path is also accepted in addition to built-in template
names.

### Module changes

- The CLI argument parser gains directory-path detection for `--template` and
  a self-reference guard.
- A new scaffold-from-directory function reads the template tree, applies
  ignore filtering, merges wrapper configuration, fills gaps, and returns the
  same file-map shape as the existing scaffold function.
- The `createProject` dispatch switches between the existing built-in
  scaffold function and the new directory-based one based on whether a
  `templateDir` was resolved.
- A gitignore-style matching library is added as a project dependency if one
  is not already available.

## Testing Decisions

### Testing philosophy

Tests assert only on external behavior: the scaffolded files on disk, the
JSON output envelope, and exit codes. No tests import internal modules or
assert on implementation details. This keeps tests stable through refactors
and ensures the feature works from the user's perspective.

### Seam

A single existing seam is used: the CLI subprocess tests in
`test/create.test.js`. These tests spawn the real CLI binary
(`bin/sporades.js`) as a child process, pass arguments, and assert on stdout
and the filesystem. This is the highest possible seam — it exercises the full
parse → resolve → scaffold → write path end-to-end with zero new test
infrastructure.

All existing `sporades create` tests in this file use a `runCli` helper to
spawn the binary and a `withTempDir` helper for filesystem isolation. The new
tests reuse both helpers and the same assertion patterns.

### Test cases

1. **Basic copy** — a template directory with `server/index.ts`,
   `client/index.tsx`, `shared/types.ts`, `index.html`, `sporades.json`, and
   `package.json`. Verify all files are copied, `sporades.json` has the new
   project name, and `package.json` has the Sporades dev dependency and
   scripts.
2. **Missing `sporades.json`** — template without `sporades.json`. Verify a
   default is generated with `react`/`esbuild` and the project name.
3. **Missing `package.json`** — template without `package.json`. Verify a
   generated one has framework-specific dependencies and the Sporades dev
   dependency.
4. **`--framework` override** — template `sporades.json` declares
   `react`; `--framework preact` is passed. Verify the generated config uses
   `preact` and `package.json` has Preact dependencies.
5. **`.gitignore` filtering** — template has a `.gitignore` listing
   `node_modules/`, `.sporades/`, `package-lock.json`, and a custom pattern
   like `*.local`. Matching files exist in the template. Verify none appear in
   the scaffolded project and `.gitignore` itself is copied.
6. **No `.gitignore` fallback** — template has no `.gitignore` but contains
   `.git/` and `.env.sporades.server` with test content. Verify `.git/` is not
   copied, `.env.sporades.server` is a blank default, and all other files are
   copied.
7. **Previously-scaffolded source reuse** — scaffold a built-in template into a
   temp directory, add a custom file (e.g. `client/components/Button.tsx`), then
   use that directory as `--template` for a second `sporades create`. Verify
   the custom file is copied and `.sporades/`/`node_modules/` (covered by the
   scaffold's own `.gitignore`) are not.
8. **Non-existent path fallback** — `--template blog` with no local `blog/`
   directory still produces the existing structured error. This is the existing
   test; it must continue to pass unchanged.
9. **Self-reference guard** — `--template .` when the project name resolves to
   the same directory produces a structured error with a clear message.

## Out of Scope

- Git URL or npm package template sources (deferred to a future iteration).
- Multi-framework layering for user-defined templates — a user-defined template
  targets one framework; the per-framework file-variant system used by built-in
  templates is not applied.
- Template manifests beyond `sporades.json` — the project configuration file is
  the manifest; no separate `template.json` or `sporades-template.json`.
- Template registries, marketplaces, or sharing infrastructure.
- Validation that the template contains required source files (server entry,
  client entry, `index.html`). Missing files surface as normal errors from
  `sporades dev` rather than scaffold-time rejection — the user owns the
  template contents.
- Nested `.gitignore` evaluation — only the template root `.gitignore` is read
  in this version.

## Further Notes

The feature is designed to be additive: existing built-in template workflows
are completely unaffected because directory-path resolution only activates
when the `--template` value actually resolves to a directory on disk. A
bare built-in name like `todo` with no local `todo/` directory falls through
to the existing path unchanged.

The `.gitignore`-driven ignore approach was chosen over a fixed hardcoded
ignore list because a template that was itself created by `sporades create`
already ships a `.gitignore` listing `node_modules/`, `.sporades/`, and
`.env*.local`. Honoring that file means the most common source of user-defined
templates — a previously scaffolded and then customised project — works
without any additional configuration. The two always-ignored entries (`.git/`
and `.env.sporades.server`) cover cases where the `.gitignore` might not
list them but they must never be inherited.
