# 01 — Scaffold from a complete user-defined template directory

**What to build:** A developer runs `sporades create myapp --template ./my-project` pointing at a local directory that contains a complete project (including `sporades.json` and `package.json`). Sporades detects the directory, copies its file tree honouring the template's `.gitignore` (always skipping `.git/` and `.env.sporades.server`), overrides the `name` in `sporades.json`, merges the Sporades dev dependency and `dev`/`deploy` scripts into `package.json`, regenerates a blank `.env.sporades.server`, reports the resolved path in `--json` output, updates CLI help to mention directory support, and guards against scaffolding into the same directory as the template source. The existing built-in template behaviour and the existing "unsupported template" error are completely unchanged.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] `--template` value resolving to an existing directory is detected and used as a user-defined template; a `templateDir` option is set to the resolved absolute path.
- [x] Values that are not directories fall through to the existing built-in template name check — `--template blog` with no local `blog/` directory still produces the existing structured error.
- [x] The template directory's `.gitignore` is read and every matched path is skipped during copy, using a gitignore-style matching library.
- [x] `.git/` and `.env.sporades.server` are always skipped regardless of `.gitignore` contents.
- [x] The template's `.gitignore` itself is copied into the new project (unless the template's own `.gitignore` explicitly excludes it).
- [x] If the template includes `sporades.json`, its `name` field is overridden with the new project name; all other fields are preserved.
- [x] If the template includes `package.json`, the Sporades dev dependency, `typescript` dev dep, and `dev`/`deploy` scripts are merged in; all existing dependencies, scripts, and metadata are preserved.
- [x] `.env.sporades.server` is always regenerated as a blank default, never copied from source.
- [x] A self-reference guard rejects the case where the resolved template directory equals the resolved project directory with a structured error and hint.
- [x] `--json` output `data.template` reports the resolved directory path for user-defined templates.
- [x] CLI help for `create` mentions that `--template` accepts a local directory path in addition to built-in names.
- [x] `createProject` dispatches to the new scaffold-from-directory path when `templateDir` is set; otherwise calls the existing scaffold function unchanged.
- [x] A gitignore-style matching library is added as a project dependency.
- [x] Test: basic copy — a template dir with `sporades.json`, `package.json`, `server/index.ts`, `client/index.tsx`, `shared/types.ts`, `index.html` produces a scaffold with all files copied, correct name, and Sporades dep merged.
- [x] Test: `.gitignore` filtering — a `.gitignore` listing `node_modules/`, `.sporades/`, `package-lock.json`, `*.local` causes matching files to be absent from the scaffold; `.gitignore` itself is copied.
- [x] Test: no `.gitignore` fallback — a template with no `.gitignore` but containing `.git/` and `.env.sporades.server` with test content has `.git/` absent and `.env.sporades.server` as a blank default; all other files are copied.
- [x] Test: previously-scaffolded source — a project created by `sporades create` with a built-in template, then modified with a custom file, can be used as `--template`; the custom file is copied and `.sporades/`/`node_modules/` are not.
- [x] Test: non-existent path fallback — existing `--template blog` rejection test continues to pass.
- [x] Test: self-reference guard — `--template .` when the project name resolves to the same directory produces a structured error.
- [x] Test: `--json` output reports the resolved path.
- [x] Test: `--help` output mentions directory path support.
