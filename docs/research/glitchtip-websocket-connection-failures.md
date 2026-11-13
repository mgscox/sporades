# GlitchTip: why the browser runtime's `new WebSocket(url)` throws

Date: 2026-11-13. Author: Hypatia (research). Status: research only; no
production access beyond the GlitchTip summaries in the brief, no fixes filed.

## Question

What makes the Sporades browser connection's `new WebSocket(url)` throw
synchronously in production (saas-tickets groups 35, 36, 39; voxuse group 38),
and can a first-party code path produce it? The brief asks for each hypothesis
to be tested against the evidence: (a) a non-native `WebSocket` replacement,
(b) a page context whose location gives a URL the engine rejects, (c) the
unguarded throw reaching callers. It also asks whether error ingestion can
record coarse browser/OS context without breaking GDPR obligations.

## Summary

Neither error text can come from Sporades calling the browser's native
`WebSocket`. "Please use the 'new' operator" is Chromium's binding error for a
DOM constructor invoked *without* `new` [3]. Sporades always calls `new
WebSocket(url)`, so something must have replaced `window.WebSocket` with code
that calls the native constructor as a function. "…provided URL is invalid"
does not appear in the WebSocket constructor paths of Chromium, Firefox or
WebKit [1][4][5]. It could only follow from a URL the engine rejects, and
Sporades passes a URL it has already parsed successfully. Both apps enforce
`script-src 'self'` with nonces, so no third-party page script can make the
replacement. The likely source is an injector that bypasses page CSP: a
browser extension, an in-app browser, or an automation harness. **Verdict:
third-party trigger (moderate-to-high confidence for the "new" text, moderate
for the URL text), first-party impact.** Sporades lets the synchronous throw
escape `open()`. In the observed stack it escapes during the first connection,
which crashes a React 19 app with no error boundary (React removes the UI [10])
and leaves no retry loop. The same throw on a reconnect attempt stops automatic
retrying for good. This predates PR #343: the pre-#343 saas-tickets build shows
the same errors as the post-#343 voxuse build.

Coarse browser/OS context can be added safely. The collector already receives
the `User-Agent` and, on Chromium, low-entropy client hints [12]. It can reduce
these to family + major version + OS family and send them as Sentry `contexts`,
which GlitchTip keeps and turns into tags without a raw UA string [8][9]. Note
that browser events on Hosted Capsules currently carry `user.ip_address` by
design (docs/reference/errors-and-analytics.md), which conflicts with the
brief's "no IP" goal.

## Evidence used and its limits

From the brief (CEO's reading of GlitchTip; I did not access GlitchTip):

| Group | App | When (UTC) | Type / text | Stack |
|---|---|---|---|---|
| 35 | saas-tickets | 2026-11-10 10:20:28, 13:17:53 | TypeError, "Please use the 'new' operator" | 10 frames, innermost `ye` |
| 36 | saas-tickets | 2026-11-10 11:35:45 | same fingerprint | no frames |
| 39 | saas-tickets | 2026-11-13 08:42:33 | "provided URL is invalid" | line 71 frames → `Object.subscribe` → `Ut` → `vv` → `ye` (line 9) |
| 38 | voxuse | 2026-11-13 08:16:18 | SyntaxError, same text | innermost `P` (line 9) |

No event has browser, OS, UA or user context. What I could add locally:

- **Sporades versions in the releases (inferred).** The last saas-tickets
  `origin/main` commit before release `20261108T081843Z` (ec91213, 08:18:20Z)
  locks `sporades@0.9.42` plus a local patch that does not touch the client
  runtime. The last voxuse commit before `20261112T185549Z` (f48d399) locks
  `0.9.51`. PR #343 (b944ab0f) is in 0.9.44 and later and not in 0.9.42, so the
  errors occur both with and without #343. This assumes each release was built
  from the latest main commit at its timestamp.
- **No first-party `WebSocket` replacement.** Neither the Sporades source nor
  either app's client, shared, `index.html` or Vite config assigns
  `WebSocket`. Neither app has an error boundary or `onUncaughtError`, and both
  use React 19 `createRoot`.
- **A live Chromium experiment was not possible.** Chrome 157 and the
  Playwright headless shell both abort at launch in this sandbox. I modelled
  the stack-frame behaviour in Node 24 (V8) using a builtin constructor as a
  stand-in. That is indicative, not a DOM test.

## Findings

### 1. What the code does

`open()` (src/templates/client-runtime-template.ts:880–897) resolves
`/__sporades/ws` against `window.location.href`, changes `https:`→`wss:` and
everything else→`ws:`, adds `connectionToken`, increments
`automaticConnectionAttempts` (:895), and calls `new WebSocket(url)` (:897)
with a `URL` object and no `try`. Every retry is scheduled from the socket's
`close` listener (:990–1023 → `scheduleConnectionRetry` :1027), and that
listener is attached only *after* the constructor returns. Callers:

- `createConnection()` calls `open()` at :1453, the last step of construction,
  through `connect()` (:785–790). Every public API goes through `connect()`.
- `send()` (:1187), used by `request()`. The call runs inside a `new Promise`
  executor (:1235–1239), so a throw becomes a rejected promise.
- `subscribeNormalizedQuery` (:1604) and `journeySubscribe` (:1678) register
  the subscription first (:1603, :1677) and then call `open()`.
  `onMessage().subscribe` (:1443) adds the listener first.
- `startConnectionRetry` (:1070, PR #343), which runs from the retry
  `setTimeout`; `pageshow` (:859); the cached-return branch of `close` (:1009).

PR #343 did not change the constructor line, which has been unguarded since
25de6243. It replaced the old terminal error with an indefinitely retrying
loop, `connectionUnavailable` and the "Try again" button wiring
(`startConnectionRetry`). That loop is exactly the part a constructor throw
breaks.

### 2. Hypothesis (a): a non-native `WebSocket`

**"Please use the 'new' operator".** Chromium's bindings build this text from
`FailedToConstruct("WebSocket", "Please use the 'new' operator, this DOM object
constructor cannot be called as a function.")` [3]. Firefox says
"WebSocket constructor: 'new' is required" [6], so the event is
Chromium-family (Chrome, Edge, Brave, Opera, Samsung Internet or Android
WebView). Group 35's 10 frames also match V8's default `Error.stackTraceLimit`
of 10. Our minified call keeps `new WebSocket(...)` against the global, so the
error requires `window.WebSocket` to be something that ends up calling the
native constructor via `[[Call]]`. Typical shapes are an ES5 wrapper
(`function W(u,p){ return Native(u,p) }`, or `Native.call(this,…)`) or a
`Proxy` whose `construct` trap applies the target.

The stack detail narrows this. In the V8 model, a JavaScript wrapper or trap
leaves its own frame with coordinates (e.g. `new W (…:9:58)` or
`Object.construct (…)`). Sporades' frame parser (src/exception-stack.ts) keeps
such frames, so the wrapper would appear as the innermost frame. Only
coordinate-less builtin frames (`at Map (<anonymous>)`) are dropped. An
innermost `ye` across 10 kept frames therefore fits a `Proxy` whose trap is a
builtin, or a native-to-native forwarding path, better than a plain JS
wrapper. I can't name the product. The full frame list (filenames as well as
function names) would settle it.

Group 36 has no frames. In the loader (src/templates/observability-loader.ts),
an `error` event whose `event.error` has no stack falls back to
`event.filename`, and `clean()` empties any filename that is not `http(s):` or
`file:`, for example `chrome-extension://…`. A frameless event therefore fits
a throw attributed to a non-page script. This is a weak signal: GlitchTip may
also have grouped a stackless rethrow under the same fingerprint.

**"…provided URL is invalid".** The native constructors use other wording:

- Chromium: `SyntaxError` "The URL '<url>' is invalid.", only when its own
  re-parse fails [1].
- Firefox: a bare `NS_ERROR_DOM_SYNTAX_ERR` [4], i.e. the generic DOMException
  text.
- WebKit: a bare `SyntaxError` [5], i.e. "The string did not match the
  expected pattern."

The only public match I found is an Exercism Sentry issue (first seen
2026-03-19, reopened 2026-10-28): "SyntaxError: Failed to construct
'WebSocket': Failed to create a WebSocket: the provided URL is invalid." [7].
It also has no UA and no root cause. The Blink-style prefix with non-Blink
wording points to either an unidentified Chromium derivative or JavaScript
that imitates Blink errors. **The producer is unidentified (low confidence on
attribution).**

One design detail makes non-native code more likely to fail here. Sporades
passes a `URL` *object*. Native constructors stringify it (USVString), but a
wrapper that tests `typeof url === "string"`, or calls string methods on it,
would reject it. For example, msw's interceptor branches on `typeof url ===
"string"` before treating the value as a `URL` [11].

### 3. Hypothesis (b): a location the engine rejects

I modelled the exact `open()` URL steps in Node 24, which uses WHATWG URL like
browsers do:

| `location.href` | Result of `open()`'s URL steps | What a native engine would throw |
|---|---|---|
| `https://host/path?q#f` | `wss://host/__sporades/ws` (query/fragment dropped) | nothing |
| odd ports, IPv6, IDN hosts | valid `ws(s)://…` | nothing |
| `about:blank`, `about:srcdoc`, `blob:…`, `data:…` | `new URL()` throws `TypeError: Invalid URL` | "Failed to construct 'URL'…", **not** WebSocket |
| `file:///…` | stays `file:///__sporades/ws` (the protocol setter ignores the change) | Chromium "The URL's scheme must be either…" [1] |
| `chrome-extension://…`, `capacitor://…` | stays non-special scheme | the same scheme error |

None of these produce either observed text. In the cases that would trip a
native engine, `new URL()` throws first with a different message, or the
scheme check fires. A URL that `new URL()` has already parsed and serialized
as `ws(s)` is valid input to the native constructor [2], so a native "URL
invalid" SyntaxError is not reachable from `open()`.

The other contexts in the brief don't fit either. Prerendered and BFCache pages
keep their `https:` location, and `pageshow` restore goes through the same
`open()`. Both apps send `frame-ancestors 'none'`, which rules out third-party
framing; same-origin `about:blank` iframes don't run the runtime. **(b) is
ruled out for both texts (high confidence).**

### 4. Hypothesis (c): what users see and whether retrying stops

This is first-party behaviour and it is confirmed by reading the code. There
are two cases.

**Throw during the first connection.** Group 39's chain is `Object.subscribe`
(`queries.subscribe`, a method name the minifier keeps) → `Ut` (`connect`) →
`vv` (`createConnection`) → `ye` (`open`). A minifier renames function
bindings, not property names, so `vv` cannot be `subscribeNormalizedQuery`.
That identifies the initial `open()` at :1453.

- `connection` stays `undefined`. Every later SDK call runs `createConnection()`
  again, registers another `pagehide`/`pageshow` pair (:832, :851), and throws
  again. No socket, no `close` listener, no retry and no connection panel ever
  exist.
- The throw lands in the caller. With `createHooks().useQuery` that is a
  `useEffect`. React 19 sends an uncaught error to `window.reportError` and,
  with no boundary, removes the UI [10]. That is a blank page. On voxuse,
  prerendered static fragments might stay visible but inert, because nothing
  dismisses them (untested).
- `mutations.run`, `auth.*` and similar calls throw synchronously instead of
  returning their usual `{ error }` result.

**Throw during reconnect** (`startConnectionRetry` from the timer, `pageshow`,
or the cached-return branch). `retryTimer` and `retryInFlight` have already
been cleared and the attempt counter incremented. No new socket gets a `close`
listener, so **no further retry is ever scheduled**. If the "Could not connect"
panel is showing, `startConnectionRetry` has already disabled "Try again"
(:1075), so the user sees "will keep trying to reconnect automatically" while
nothing retries, and only "Reload page" works. Later `send()` calls retry
synchronously and throw again: `request()` promises reject and leave entries in
`pending`, and query/journey/app-message subscriptions are registered but the
caller never gets an `unsubscribe` handle. The original throw escapes a timer
or listener and is reported. The cached-return branch sits in an `async`
listener, so there it becomes an unhandled rejection.

The 10-frame depth of group 35 suggests a React-effect stack, i.e. the
first-connection case. A timer-driven retry stack would be 2–3 frames deep.
This is inference only.

### 5. Privacy-safe browser/OS context

- **What is already available.** The `/__sporades/collect` POST arrives with
  the browser's `User-Agent`. Chromium also sends the low-entropy client hints
  `Sec-CH-UA`, `Sec-CH-UA-Mobile` and `Sec-CH-UA-Platform` by default over
  HTTPS without opt-in [12]. Firefox and Safari send only the UA. The loader
  doesn't need to collect anything new.
- **How GlitchTip uses it.** At ingest GlitchTip parses
  `request.headers["User-Agent"]` into `browser`/`os`/`device` contexts only
  when those contexts are missing, and derives the `browser.name`, `browser`
  and `os.name` tags from whatever contexts are present [8]. The Sentry
  payload defines `contexts.browser {name, version}` and `contexts.os {name,
  version}` [9]. Sporades can therefore send derived contexts and **never send
  the raw UA**.
- **Minimisation.** Keep the browser family and *major* version, the OS family,
  a mobile flag, and optionally a bounded `ws_ctor_native: true|false` tag
  (whether `WebSocket` stringifies as native code). Drop minor versions, OS
  versions, device models and the full UA. Chromium's reduced UA has already
  frozen most of those [12].
- **IP and identifiers.** The current docs say browser Sentry events on Hosted
  Capsules receive `user.ip_address`. The brief's "no IP" therefore needs a
  change, for example a per-Capsule option to omit it for client events.
  Sporades sends no user IDs for client errors, which is correct.
- **GDPR framing (not legal advice).** A UA string can contribute to device
  fingerprinting. The EDPB treats reading device information, including HTTP
  header data, as within the scope of ePrivacy Art. 5(3) [13]. Coarse fields
  derived from headers the browser already sends, kept only in the error
  record, are a much smaller footprint than a raw UA. As saas-tickets is a
  processor, its controllers' instructions and the record of processing should
  name this field set before it is enabled. This needs sign-off from the
  controller-facing owner, not just an engineering decision.

## Verdict

- **Trigger: third party.** Both texts need a `WebSocket` that is not the
  browser's own, or that is called incorrectly, and the apps' CSP rules out
  page-level third-party scripts. The remaining candidates are extensions,
  in-app or embedded browsers, and automation harnesses that inject with
  privileges. The specific product is unidentified.
- **Impact: first party.** Sporades turns that environment fault into an
  uncaught exception. When it happens on first connect, React apps without an
  error boundary lose their whole UI. When it happens on reconnect, the retry
  loop from PR #343 stops for good and the panel copy becomes false. A
  first-party change also reduces the trigger surface: passing a string URL
  avoids wrappers that accept only strings.

## Recommendations (options only; nothing filed)

1. **Guard the constructor.** Wrap :897 in `try/catch`. Treat a throw as a
   failed attempt: count it, reuse the `close`-path retry
   (`scheduleConnectionRetry`), and show the existing panel after the warning
   threshold. Never throw from `open()`. `createConnection()` must also finish
   (and memoise `connection`) when the first `open()` fails, so listeners don't
   accumulate and callers get their normal `{ error }` / loading state. This is
   the main fix and covers both the first-connect and reconnect cases.
2. **Pass `url.href`.** This is cheap, spec-equivalent for native engines, and
   removes the "URL object to a string-only wrapper" failure mode.
3. **Add a diagnostic tag.** At collection time, record whether
   `window.WebSocket` is native, plus the coarse browser/OS contexts from §5.
   This would confirm or refute hypothesis (a) on the next event. Decide
   separately whether to drop `user.ip_address` for client events.
4. **Add an app-level backstop** (saas-tickets, voxuse). An error boundary or
   `createRoot({ onUncaughtError })` that shows a recoverable screen, so
   runtime throws don't blank the app. This is independent of option 1.
5. **Add a test.** A client-runtime test that installs a throwing `WebSocket`
   (both messages), covering first connect, timer retry, `pageshow` and the
   "Try again" button, and asserting that retries continue and the panel stays
   truthful.
6. **Don't bypass the injected constructor.** Capturing the native
   `WebSocket` early would not work, because extensions inject at
   `document_start` before the module runs. Routing around a user's extension
   is also the wrong policy. Degrading gracefully is enough.

## Open questions

- What are the full message strings and complete frame lists (with filenames)
  for groups 35, 38 and 39? These would show whether a wrapper frame was
  dropped, and the voxuse `P` chain.
- Which product emits "Failed to create a WebSocket: the provided URL is
  invalid"? Code search engines were rate-limited or unreachable from this
  session.
- Were the four events one visitor or several? This can't be known without
  the context in §5.
- The release-to-version mapping above is inferred from commit timestamps, not
  from release metadata.

## Sources

1. Chromium, `third_party/blink/renderer/modules/websockets/websocket_common.cc` (main, read 2026-11-13) — https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/websockets/websocket_common.cc
2. WHATWG WebSockets Standard, `new WebSocket()` constructor steps — https://websockets.spec.whatwg.org/
3. Chromium, `third_party/blink/renderer/platform/bindings/exception_messages.cc` (`ConstructorCalledAsFunction`, `FailedToConstruct`) — https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/bindings/exception_messages.cc
4. Firefox, `dom/websocket/WebSocket.cpp` — https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/websocket/WebSocket.cpp
5. WebKit, `Source/WebCore/Modules/websockets/WebSocket.cpp` — https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/websockets/WebSocket.cpp
6. Firefox, `dom/bindings/Errors.msg` (`MSG_CONSTRUCTOR_WITHOUT_NEW`) — https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/bindings/Errors.msg
7. exercism/website issue #8924, "Failed to create a WebSocket: the provided URL is invalid" — https://github.com/exercism/website/issues/8924
8. GlitchTip backend, `apps/event_ingest/process_event.py` (`generate_contexts`, `generate_tags`) — https://gitlab.com/glitchtip/glitchtip-backend/-/raw/master/apps/event_ingest/process_event.py
9. Sentry developer docs, Contexts interface (browser/os) — https://develop.sentry.dev/sdk/data-model/event-payloads/contexts/
10. React docs: uncaught render errors remove the UI; React 19 `onUncaughtError` — https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary and https://react.dev/reference/react-dom/client/createRoot
11. mswjs/interceptors `resolveWebSocketUrl.ts` (example WebSocket replacement with its own URL handling) — https://cdn.jsdelivr.net/npm/@mswjs/interceptors@0.41.3/src/utils/resolveWebSocketUrl.ts
12. Chromium client hints component docs (low-entropy defaults) — https://chromium.googlesource.com/chromium/src/+/lkgr/components/client_hints and HTTP Toolkit, "How will user-agent client hints work?" — https://httptoolkit.tech/blog/user-agent-client-hints
13. EDPB Guidelines 2/2023 on the technical scope of Art. 5(3) ePrivacy Directive, v2.0 (adopted 2024-10-07) — https://www.edpb.europa.eu/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf
