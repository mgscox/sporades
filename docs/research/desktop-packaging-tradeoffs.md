# Desktop packaging alternatives to Electron

Status: research note accompanying the Sporades Hub concept
Last updated: 2026-08-08

## Purpose

The Sporades Hub concept document ([sporades-hub-concept.md](./sporades-hub-concept.md))
nominates Electron as the "pragmatic initial shell" and explicitly states that "the
shell is replaceable" (Principle 8). The concept also lists "Electron packaging,
signing, notarisation, and auto-update mechanism" under deferred decisions.

This document researches the tradeoffs between desktop packaging/distribution
systems that produce universal binaries for cross-platform desktop applications,
excluding Electron itself. The goal is to inform the deferred decision — not to
replace Electron prematurely.

## Context: what Hub needs from a shell

From the concept document, the desktop shell must provide:

1. **PTY integration** — tiled terminals with local shells and SSH-backed
   sessions (xterm.js or equivalent rendering).
2. **OpenSSH integration** — narrow SSH surface for Host helper operations.
3. **Filesystem access** — local project `sporades.json` editing, scaffold
   creation.
4. **Cross-platform window management** — macOS, Windows, Linux.
5. **Sandboxed renderer** — context isolation, no Node integration in renderer,
   allow-listed preload IPC.
6. **Packaging** — code signing, notarisation (macOS), auto-update.
7. **TypeScript/Node.js affinity** — Sporades is a Node.js/TypeScript codebase;
   the operations module is TypeScript.

These requirements are the evaluation lens. A framework that produces tiny
binaries but cannot embed a PTY or talk to OpenSSH without significant custom
native work is not a drop-in replacement for Electron in Hub's context.

## Frameworks evaluated

### Summary table

| Framework | Backend lang | Web engine | Min bundle | Typical app | Idle RAM | PTY support | Mobile | Maturity |
|-----------|-------------|------------|------------|-------------|----------|-------------|--------|----------|
| **Tauri 2.x** | Rust | System WebView | ~3 MB | 5–15 MB | 20–80 MB | Plugin exists | iOS+Android | Production |
| **Wails 3** | Go | System WebView | ~8 MB | 10–20 MB | 30–90 MB | DIY (Go PTY libs) | iOS+Android | Beta |
| **NeutralinoJS** | C++ (extensible) | System WebView | ~2 MB | 2–5 MB | 15–50 MB | No built-in | No | Stable but niche |
| **Electrobun** | TypeScript (Bun) | System WebView | ~12 MB | 15–30 MB | 40–100 MB | DIY | No | Early/experimental |
| **MōBrowser** | TypeScript (Node) | Bundled Chromium | ~80 MB | 100–150 MB | 100–200 MB | DIY | No | Commercial |
| **NW.js** | JavaScript (Node) | Bundled Chromium | ~80 MB | 100–200 MB | 100–300 MB | DIY | No | Legacy |
| **Flutter Desktop** | Dart | Skia (custom render) | ~20 MB | 25–40 MB | 50–120 MB | xterm.dart package | iOS+Android | Stable |
| **Qt 6.8** | C++ (or PySide) | Qt WebEngine or native widgets | ~30 MB | 40–80 MB | 40–100 MB | QProcess + custom | Android | Very mature |
| **Slint** | Rust/C++ | Custom render | ~5 MB | 5–10 MB | 15–40 MB | DIY | Android | Growing |
| **egui** | Rust | Custom render (wgpu) | ~3 MB | 3–8 MB | 10–30 MB | DIY | No | Stable but niche |

---

## 1. Tauri 2.x (Rust + system WebView)

### Architecture
Rust backend process + OS-native WebView (WebView2 on Windows, WKWebView on
macOS, WebKitGTK on Linux). No bundled browser engine. Frontend is any web
framework (React, Vue, Svelte, etc.). IPC via a custom Rust-WebView JSON bridge.

### Performance profile
- Hello World bundle: **3.2 MB** vs Electron's 85 MB (96% smaller)
- Complex 6-window app: **8.6 MB** vs 244 MB
- Cold startup: **380 ms** vs 1,420 ms (3.7× faster)
- Idle memory: **42 MB** vs 168 MB (75% less)
- IPC latency: **0.12 ms** vs 0.45 ms (3.75× faster)
- Build time is the one劣势: ~48 s initial (Rust compilation) vs 22 s for Electron

### Security model
Capability-based permission system in `tauri.conf.json`. APIs are
deny-by-default — you explicitly declare `fs:read`, `http:request`, etc. Rust's
memory safety eliminates buffer overflows, use-after-free, null deref classes.
Smaller attack surface than bundled Chromium.

### PTY / terminal support
**`tauri-plugin-pty`** exists as a community plugin (crates.io). Uses
`portable-pty` Rust crate under the hood. Integrates with xterm.js in the
frontend:
```typescript
import { Terminal } from "xterm"
import { spawn } from "tauri-pty"
const pty = spawn("bash", [], { cols, rows })
pty.onData(d => term.write(d))
term.onData(d => pty.write(d))
```
This is a proven pattern — `tauri-terminal` is a reference implementation.

### Node.js sidecar support
Tauri supports embedding external binaries as "sidecars." A Node.js process
can be bundled and spawned from the Rust backend. This means the Sporades
operations module (TypeScript) could run as a sidecar while Tauri's Rust core
handles window/PTY/IPC. However, this reintroduces a Node.js runtime
dependency and the architecture becomes more complex than Electron's native
Node.js.

### Packaging
- Tauri CLI produces `.msi`/`.exe` (Windows), `.dmg`/`.app` (macOS with
  universal binary support), `.deb`/`.AppImage` (Linux).
- Auto-updater is first-class (built-in plugin, delta updates ~1–5 MB).
- Code signing and notarisation supported on macOS.
- **Known issue**: `.appx`/`.msix` for Microsoft Store not supported — only
  `.exe`/`.msi`. macOS universal binary code-signing has reported quirks.

### WebView consistency risk
WebView2 (Windows), WKWebView (macOS), and WebKitGTK (Linux) do not implement
web standards identically. CSS, fonts, media behavior, and some web APIs may
differ. Cross-platform QA is part of the deal. On Windows (WebView2 =
Chromium-based), memory usage is similar to Electron — the "system WebView =
less memory" advantage is primarily a macOS/Linux benefit.

### Fit for Hub
| Requirement | Tauri fit |
|------------|-----------|
| PTY integration | ✅ Plugin exists, xterm.js compatible |
| OpenSSH | ✅ Rust ecosystem (ssh2, russh crates) or sidecar |
| Filesystem | ✅ Built-in fs plugin with scoped permissions |
| Cross-platform windows | ✅ Win+mac+Linux |
| Sandboxed renderer | ✅ Capability-based, deny-by-default |
| Packaging/signing/auto-update | ✅ First-class, smaller deltas |
| TypeScript affinity | ⚠️ Frontend yes; backend is Rust. Operations module would need a sidecar or rewrite |

**Key tradeoff**: Tauri's Rust backend is a language mismatch with Sporades'
TypeScript operations module. The operations module could run as a Node.js
sidecar, but that adds a process boundary and a bundled Node runtime,
partially eroding the bundle-size advantage. Alternatively, critical operations
could be reimplemented in Rust, but that violates the "one operations module"
principle unless the Rust code becomes the canonical implementation and the CLI
becomes a thin caller.

---

## 2. Wails 3 (Go + system WebView)

### Architecture
Go backend + OS-native WebView (same as Tauri: WebView2, WKWebView, WebKitGTK).
Go methods are auto-bound to JavaScript — the frontend can call Go functions
directly through generated bindings. No IPC string channels to manage.

### What's new in v3
- More direct application model with richer Go-to-JS bindings
- Frameless window support with custom title bars
- Mobile support (iOS + Android) — Go binary compiled for mobile target
- Extension/plugin system
- Native tray, clipboard, dialogs

### Performance profile
- Bundle: ~8–20 MB (Go binary + web assets, no browser engine)
- Idle RAM: ~30–90 MB
- Startup: fast (Go binary, no JVM/Node warmup)
- Build time: fast (Go compilation is quicker than Rust)

### PTY / terminal support
No first-party PTY plugin. However, Go has mature PTY libraries:
- `creack/pty` — widely used, production-grade
- `aymanbagabas/go-pty` — newer, cross-platform

Building a terminal in Wails is proven: **aimuxterm** is a Warp-inspired
terminal manager built with Wails v2 + Go + Vue 3, supporting local PTY and SSH
multi-tab terminals. This validates the pattern.

### SSH support
Go's `golang.org/x/crypto/ssh` is a first-class, mature SSH implementation.
No need to shell out to OpenSSH binary (though you can). This is actually a
potential advantage over Electron, which relies on system SSH.

### Packaging
- Wails CLI builds native installers for Win/mac/Linux
- Code signing supported
- Auto-update: not first-class in v3 yet — needs custom implementation
- Universal binaries: macOS supported via `GOARCH=arm64,amd64`

### Fit for Hub
| Requirement | Wails fit |
|------------|-----------|
| PTY integration | ⚠️ DIY but proven pattern (aimuxterm) |
| OpenSSH | ✅ Go x/crypto/ssh is excellent |
| Filesystem | ✅ Go native |
| Cross-platform windows | ✅ Win+mac+Linux+mobile |
| Sandboxed renderer | ⚠️ Less mature permission model than Tauri |
| Packaging/signing/auto-update | ⚠️ Packaging yes; auto-update needs work |
| TypeScript affinity | ❌ Backend is Go. Same sidecar problem as Tauri but with Go instead of Rust |

**Key tradeoff**: Go is yet another language outside the Sporades TypeScript
orbit. The SSH story is arguably better than Electron's, but the operations
module would need to either run as a sidecar (Node.js bundled) or be reimplemented
in Go. Wails v3 is still in beta, which carries risk for a product that needs
stable packaging and auto-update.

---

## 3. NeutralinoJS (C++ core + system WebView)

### Architecture
Minimal C++ backend that hosts the system WebView. Extensions written in
JavaScript/TypeScript. Designed to be the lightest possible web-to-desktop
wrapper.

### Performance profile
- Smallest bundles in the category: ~2–5 MB
- Lowest idle memory: ~15–50 MB
- Fast startup

### Limitations
- **No built-in PTY support**. No first-party terminal plugin. You would need
  to write a C++ extension or spawn external processes.
- **No mobile support**.
- **Limited native API surface** — filesystem, OS dialogs, clipboard, but
  nothing like Electron's rich API for tray, global shortcuts, deep OS
  integration.
- **Small ecosystem** — fewer plugins, fewer examples, fewer production
  deployments.
- **Permission model** exists but is less mature than Tauri's capability system.

### Fit for Hub
NeutralinoJS is too thin for Hub's requirements. The PTY and SSH needs alone
would require substantial custom C++ work. It excels at lightweight web-wrapper
apps (menu bar utilities, simple dashboards), not terminal-heavy developer
tools. **Not a serious candidate for Hub.**

---

## 4. Electrobun (TypeScript/Bun + system WebView)

### Architecture
Bun-based main runtime + system WebView. "Like Tauri, but with TypeScript
instead of Rust and Bun instead of Node.js." Type-safe IPC.

### Performance profile
- Bundle: ~12–30 MB (needs to bundle Bun runtime + dependencies, ~60 MB
  overhead in some configurations)
- Larger than Tauri but smaller than Electron
- Idle memory: ~40–100 MB

### PTY / terminal support
DIY. Bun has `Bun.spawn` with stdio streaming, which can approximate PTY
behavior for simple cases, but true PTY (with TTY allocation, resize, signal
handling) would need a native addon. No community plugin exists yet.

### Maturity
**This is the critical issue.** Electrobun is the youngest framework in this
list (developed since 2024). The API surface is far from Electron's. The
ecosystem is minimal. The Bun runtime itself, while maturing, is newer than
Node.js in production desktop contexts. Operational patterns, edge-case
answers, and plugin examples are scarce.

### Fit for Hub
Electrobun's TypeScript-first approach is architecturally aligned with
Sporades, but the framework is too young to bet a product surface on. The
concept document's "the shell is replaceable" principle means Electrobun could
be a future migration target if it matures, but it is not a viable initial shell
in 2026. **Worth watching, not worth choosing now.**

---

## 5. Flutter Desktop (Dart + Skia)

### Architecture
Dart backend + Skia rendering engine (not a WebView — Flutter draws its own UI).
Cross-platform from a single codebase: Windows, macOS, Linux, iOS, Android, web.

### Performance profile
- Bundle: ~20–40 MB (includes Flutter engine)
- Idle RAM: ~50–120 MB
- Startup: moderate
- Custom rendering means consistent visual output across platforms (no WebView
  inconsistency)

### PTY / terminal support
**`xterm.dart`** is a mature, fast terminal emulator widget for Flutter with
support for desktop and mobile. Works with local PTY backends or SSH. This is
a proven path — terminal emulators have been built and shipped with this
package.

### SSH support
**`dartssh2`** is a pure-Dart SSH client implementation (TerminalStudio, same
as xterm.dart). Can open SSH channels, execute commands, do port forwarding.
No dependency on system OpenSSH.

### The fundamental mismatch
Flutter Desktop does not use web technologies for the UI. Hub's concept
document implies a web-tech renderer (preload, context isolation, IPC — these
are Electron/WebView concepts). Flutter's widget system is Dart-native. The
operations module (TypeScript) would need to either:
- Be reimplemented in Dart, or
- Run as a sidecar process with IPC over stdin/stdout or a local socket

Neither is aligned with the "one operations module" principle. Additionally,
the Sporades team's expertise is TypeScript/Node.js, not Dart.

### Fit for Hub
Flutter has excellent terminal and SSH libraries and produces real universal
binaries, but it requires abandoning the web-tech renderer model and adopting
Dart. This is a fundamental architectural shift, not a shell swap. **Not
aligned with Hub's design constraints.**

---

## 6. Qt 6.8 (C++ + Qt WebEngine or native widgets)

### Architecture
Mature C++ application framework. Can embed a WebView via Qt WebEngine
(Chromium-based) or build fully native widgets. Python bindings via PySide6.
Cross-platform: Windows, macOS, Linux, Android, iOS (limited).

### Performance profile
- Bundle: ~30–80 MB (Qt libraries + WebEngine if used)
- Idle RAM: ~40–100 MB (native widgets) to ~100–200 MB (with WebEngine)
- Very fast startup for native widget apps

### PTY / terminal support
`QProcess` provides process management. For true PTY, third-party libraries
like `qptty` or custom pseudoterminal code are needed. Not as turnkey as
Tauri's plugin. However, Qt's maturity means every low-level OS API is
accessible from C++.

### SSH support
No first-party SSH module. Would use libssh2 or libssh via C++ bindings.

### Packaging
Very mature: Qt Installer Framework, WiX on Windows, DMG on macOS, deployment
tools for Linux. Code signing and notarisation supported. Auto-update via
Qt Installer Framework or custom.

### Fit for Hub
Qt is the most mature desktop framework in existence, but it requires C++ (or
Python via PySide6). This is the furthest language departure from Sporades'
TypeScript. The operations module would need a sidecar or rewrite. Qt
WebEngine is also bundled Chromium — so if you use the WebView path, you're
back to Electron-class bundle sizes with a less web-friendly API. **Not aligned
with Hub's design constraints**, though it is the most battle-tested option for
truly native desktop applications.

---

## 7. Slint (Rust/C++ + custom render)

### Architecture
Lightweight UI toolkit with a custom DSL for declaring UI. Renders via software,
OpenGL, or wgpu. Rust or C++ backend. No WebView — pure custom rendering.

### Performance profile
- Bundle: ~5–10 MB
- Idle RAM: ~15–40 MB
- Very fast startup
- Extremely lightweight

### PTY / terminal support
DIY. Would need to embed a terminal emulator widget (no first-party one) and
wire up a Rust PTY crate. No xterm.js since there's no WebView.

### Fit for Hub
Slint is designed for embedded and lightweight desktop apps, not web-tech
dashboards. No WebView means no xterm.js, no React/Vue renderer, no preload/IPC
model. Hub's concept is fundamentally web-renderer-based. **Not aligned.**

---

## 8. egui (Rust + wgpu custom render)

### Architecture
Immediate-mode GUI in Rust, rendered via wgpu. No WebView, no DOM.

### Performance profile
- Bundle: ~3–8 MB (one of the smallest)
- Idle RAM: ~10–30 MB
- Extremely fast

### PTY / terminal support
DIY. `portable-pty` for PTY, custom terminal widget for rendering (no xterm.js).
Some community examples exist but nothing production-grade for a terminal
emulator.

### Fit for Hub
Same fundamental mismatch as Slint: no WebView, no web-tech renderer, no
xterm.js. egui is excellent for tools and debug UIs but not for the rich
dashboard/management surfaces Hub needs. **Not aligned.**

---

## 9. NW.js (JavaScript/Node.js + bundled Chromium)

### Architecture
Chromium + Node.js, but unlike Electron, Node.js APIs are available directly
in the web page context (not just in a separate main process). Simpler for
small apps — no IPC layer needed.

### Performance profile
Similar to Electron: ~80–200 MB bundle, ~100–300 MB idle RAM. Same bundled
Chromium overhead.

### Security concern
The direct Node.js access in the renderer is a security liability. A
compromised or untrusted page can access the filesystem, run commands, and read
environment data. The MōBrowser blog correctly notes: "If you load third-party
content into a Node-enabled NW.js context, that page is no longer just a web
page." Hub loads only local content, but the security model is fundamentally
less safe than Electron's process-separated approach.

### Ecosystem
NW.js is legacy. The desktop conversation in 2026 centers on Electron, Tauri,
and newer frameworks. Fewer examples, fewer integrations, less fresh production
guidance.

### Fit for Hub
NW.js offers no meaningful advantage over Electron for Hub's use case. Same
bundle size, worse security model, smaller ecosystem. **Not a candidate.**

---

## 10. MōBrowser (TypeScript/Node.js + bundled Chromium)

### Architecture
Chromium-based, like Electron, but with TypeScript-first design, Protocol
Buffers for type-safe IPC, built-in source code protection (encryption at build
time), and commercial support with SLAs.

### Performance profile
Similar to Electron: ~80–150 MB bundle, ~100–200 MB idle RAM (bundled
Chromium).

### Distinguishing features
- **Type-safe, contract-based IPC** via Protocol Buffers (generated TypeScript
  code, not handwritten string channels)
- **Source code protection** — files encrypted at build time, decrypted on
  demand at runtime
- **Native module system** — C++ or Rust modules with contract-based Protocol
  Buffers communication, no ABI compatibility issues
- **Commercial support with SLAs** — dedicated team, feature requests fulfilled
  within days

### Tradeoffs
- **Licensing**: Free for non-commercial use; commercial license required for
  commercial software. This is the only non-free-opensource option in this list.
- **Bundle size**: Same as Electron (bundled Chromium)
- **Ecosystem**: Small — no big community, but the framework team fills the gap
  with direct support
- **API surface**: Not as rich as Electron's, but covers most use cases

### Fit for Hub
MōBrowser addresses some of Electron's pain points (IPC safety, source
protection, commercial support) but does not solve the bundle size / memory
problem, which is the primary motivation for leaving Electron. The commercial
licensing model is a consideration for an open-source project like Sporades.
**Potentially interesting if Hub evolves into a commercial product, but not
aligned with Sporades' open-source model.**

---

## Comparative analysis against Hub's requirements

### The PTY test

Hub's tiled terminals are a hard requirement, not a nice-to-have. This
eliminates or complicates several candidates:

| Framework | PTY path | Effort |
|-----------|----------|--------|
| Tauri | `tauri-plugin-pty` + xterm.js | **Low** — plugin + xterm.js, proven |
| Wails | Go PTY lib + xterm.js | **Medium** — DIY but proven (aimuxterm) |
| Flutter | `xterm.dart` + pty backend | **Low** — but requires Dart rewrite |
| Qt | QProcess + custom PTY | **High** — C++ custom work |
| Electrobun | Bun.spawn (not true PTY) | **High** — needs native addon |
| Neutralino | None | **Very high** — C++ extension |
| Slint/egui | Custom widget + PTY crate | **Very high** — no terminal widget |

Tauri is the clear leader on the PTY test among non-Electron options.

### The TypeScript alignment test

The operations module is TypeScript. The "one operations module" principle
means the desktop shell should call into it, not reimplement it.

| Framework | TS alignment | Approach |
|-----------|-------------|----------|
| Electrobun | ✅ Native | Run operations module directly — but framework too young |
| MōBrowser | ✅ Native | Run operations module directly — but commercial license |
| Tauri | ⚠️ Sidecar | Bundle Node.js sidecar for operations module |
| Wails | ⚠️ Sidecar | Bundle Node.js sidecar for operations module |
| Flutter | ❌ Reimpl or sidecar | Dart can't run TS directly |
| Qt | ❌ Reimpl or sidecar | C++ can't run TS directly |
| Slint/egui | ❌ Reimpl or sidecar | Rust can't run TS directly |

Only Electrobun and MōBrowser offer native TypeScript backends, and both have
significant disqualifying issues (maturity and licensing respectively). Every
other non-Electron option requires a sidecar pattern, which adds complexity.

### The packaging/distribution test

| Framework | Signing | Notarisation | Auto-update | Universal binary |
|-----------|---------|-------------|-------------|-----------------|
| Tauri | ✅ | ✅ | ✅ First-class | ✅ macOS (with quirks) |
| Wails | ✅ | ✅ | ⚠️ DIY | ✅ macOS |
| Flutter | ✅ | ✅ | ⚠️ DIY | ✅ |
| Qt | ✅ | ✅ | ✅ Qt IFW | ✅ |
| Electrobun | ⚠️ | ⚠️ | ❌ | ⚠️ |
| Neutralino | ⚠️ | ⚠️ | ❌ | ⚠️ |

Tauri has the most complete packaging story among non-Electron options, with
first-class auto-update and delta updates (1–5 MB vs Electron's 80–150 MB
full updates).

### The security model test

Hub's concept document specifies: sandboxed renderer, context isolation, no
Node integration in renderer, allow-listed preload, typed schema-validated IPC.

| Framework | Security model |
|-----------|---------------|
| Tauri | **Best fit** — capability-based, deny-by-default, Rust memory safety |
| MōBrowser | Good — typed IPC (Protobuf), source protection |
| Wails | Moderate — less mature permission model |
| NW.js | **Worst** — Node.js in renderer context |
| Electrobun | Unknown — too young to evaluate thoroughly |

---

## Recommendation

### For the initial Hub implementation: Electron remains correct

The concept document's choice of Electron as the "pragmatic initial shell" is
well-justified:

1. **TypeScript native** — the operations module runs in-process, no sidecar
   complexity.
2. **PTY ecosystem** — `node-pty` is battle-tested, xterm.js is the standard,
   and the Electron+node-pty+xterm.js pattern is proven by VS Code.
3. **Mature packaging** — electron-builder handles signing, notarisation,
   auto-update, and universal binaries for all three platforms.
4. **Ecosystem depth** — every desktop integration need has a battle-tested
   npm package.
5. **Principle 8** — "the shell is replaceable" means the choice is not
   irreversible.

The cost is bundle size (~120–250 MB) and memory (~100–300 MB idle). For a
developer tool that manages remote server infrastructure, this is acceptable —
the user is a developer who already runs Docker, IDEs, and other heavy tools.

### For a future shell migration: Tauri is the strongest candidate

If Hub later migrates off Electron (e.g., for a lighter "companion" mode, or
because bundle size becomes a competitive issue), Tauri 2.x is the best
successor:

1. **PTY support** is already proven via `tauri-plugin-pty` + xterm.js.
2. **Security model** is superior (capability-based, deny-by-default, Rust
   memory safety) — aligned with Hub's sandboxed renderer requirement.
3. **Bundle size** is ~96% smaller — meaningful for distribution bandwidth and
   user perception.
4. **Auto-update** is first-class with tiny delta updates.
5. **Mobile support** (iOS + Android) is a bonus if Hub ever needs a mobile
   companion.

The migration cost is the Rust backend language mismatch. The operations module
would need to either:
- Run as a Node.js sidecar (bundled with the app), or
- Be progressively ported to Rust (with the CLI calling the Rust implementation)

Neither is trivial. But the concept's "the shell is replaceable" principle and
the shared operations module architecture make this migration structurally
possible — the desktop adapter is a thin layer over the operations module, so
swapping the shell means rewriting the adapter, not the operations.

### Watch list

- **Electrobun**: If it matures and Bun stabilises in desktop contexts, it
  could offer the TypeScript-native, small-binary combination that Tauri
  can't. Check again in 12–18 months.
- **Wails v3**: If it reaches stable and adds first-class auto-update, it
  becomes a viable alternative for Go-comfortable teams. The SSH story (Go
  x/crypto/ssh) is compelling.
- **Flutter Desktop**: Only if Hub ever fundamentally rethinks its renderer
  model away from web technologies.

---

## Sources

- "Tauri vs Electron [2026]: 96% Smaller Apps, 1 Winner" — tech-insider.org
- "Top 5 Electron alternatives in 2026" — teamdev.com/mobrowser/blog
- "Cross-Platform Desktop Apps 2026 Deep Dive" — youngju.dev
- "Desktop Apps from Web: Tauri vs Electron vs Deno 2026" — digitalapplied.com
- "Best Desktop App Frameworks 2026" — pkgpulse.com
- `tauri-plugin-pty` — github.com/Tnze/tauri-plugin-pty
- `tauri-terminal` reference — github.com/marc2332/tauri-terminal
- Tauri sidecar docs — v2.tauri.app/develop/sidecar
- Wails v3 — v3.wails.io
- `aimuxterm` (Wails terminal manager) — github.com/solosw/aimuxterm
- `xterm.dart` — github.com/TerminalStudio/xterm.dart
- `dartssh2` — github.com/TerminalStudio/dartssh2
- DoltHub Electron vs Tauri migration report — dolthub.com/blog