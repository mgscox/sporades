# 04 — Capture Safe Browser Journey Signals

**What to build:** After explicit Journey enablement, automatically convert safe framework-neutral navigation, focus, and visibility changes plus explicitly annotated semantic interactions into the session's TTL-buffered Journey state while keeping manual updates available and excluding raw behavioral capture.

**Blocked by:** 03 — Buffer And Expire Journey State.

**Status:** done

## Parent

.scratch/user-journey-tracker/PRD.md

- [ ] Automatic capture begins only after `journey.enable()` succeeds and produces no Journey state before consent.
- [ ] When navigation capture is enabled, the current page is published as the first `viewing` state immediately after successful enablement.
- [ ] A connection that narrows navigation, focus, and interaction capture off remains invisible until explicit `journey.set(...)` publication.
- [ ] Capsule `capture.navigation`, `capture.focus`, and `capture.interactions` policy defaults each source to enabled, while per-connection enable options may only narrow that policy.
- [ ] The client runtime captures the initial page navigation, History API navigation, `popstate`, hash navigation, document visibility changes, and window focus/blur without framework-specific hooks.
- [ ] One idempotent framework-neutral observer wraps successful `history.pushState()` and `history.replaceState()` calls without changing native arguments, return values, or exceptions, and listens for `popstate` and `hashchange`.
- [ ] Route signals are coalesced and sampled after a browser rendering opportunity so SPA-rendered semantic page metadata is current before publication.
- [ ] A targeted observer reacts only to creation, replacement, removal, or content changes of `<meta name="sporades-journey">`; no general DOM observation is used for route inference.
- [ ] Client-runtime replacement and HMR do not multiply History wrappers, listeners, metadata observers, or Journey publications; setup and teardown are idempotent.
- [ ] Automatic navigation publishes `status: "viewing"` with only a normalized pathname and never includes the URL origin, query string, or raw fragment.
- [ ] Window focus publishes `focused`, while window blur or a hidden document publishes `away`; each automatic state includes the current safe `{ page }` metadata.
- [ ] `<meta name="sporades-journey" content="<semantic-page>">` replaces the pathname with a bounded semantic page name when present.
- [ ] Hash changes trigger navigation reevaluation without publishing raw hash content; hash-derived semantics require an explicit manual mapping.
- [ ] Automatic signals publish through the same Journey session identity, replacement, TTL, buffering, expiry, snapshot, and realtime change contract as manual `journey.set(...)` calls.
- [ ] Arbitrary clicks and pointer events produce no Journey state.
- [ ] Activating an interactive element explicitly annotated with `data-sporades-journey="<semantic-name>"` publishes that declared semantic Journey signal.
- [ ] Annotated interactions use the declared semantic name as status and include the current safe `{ page }` metadata.
- [ ] V1 parses no JSON or arbitrary metadata from Journey HTML attributes; richer interaction metadata requires explicit `journey.set(...)` code.
- [ ] One idempotent document-level capture-phase observer handles annotated `click` and `submit` events without installing per-element or framework-specific handlers.
- [ ] The observer uses `event.composedPath()` to select the nearest annotation through ordinary component nesting and open Shadow DOM; closed Shadow DOM requires annotation on the host.
- [ ] Publication waits until propagation completes, skips `defaultPrevented` events, and remains observable when framework handlers call `stopPropagation()`.
- [ ] An annotated submit control nested in an annotated form emits exactly one state using the nearest matching annotation.
- [ ] Native keyboard activation of buttons/links and Enter-key form submission follow the same click/submit path as pointer activation.
- [ ] V1 does not automatically capture `change`, typing, drag/drop, gestures, or pointer-specific events; those require explicit `journey.set(...)` calls.
- [ ] Captured interactions include only the bounded declared semantic event name and explicitly authored bounded metadata.
- [ ] Automatic capture never includes URL origin/query/raw hash, form values, input contents, raw DOM text, accessible labels, CSS selectors, DOM paths, pointer coordinates, raw browser event objects, Session tokens, or auth profile data.
- [ ] Invalid or oversized annotations and automatic `{ page }` metadata use the same status/metadata limits as manual updates and fail safely without publishing partial state or breaking unrelated page interaction.
- [ ] Manual `journey.set(...)` remains available for typing, workflow progress, non-DOM signals, and explicit replacement of automatically captured state.
- [ ] Manual updates remain available when one or every automatic capture source is disabled.
- [ ] `inactive` is rejected as a published status; `viewing`, `focused`, and `away` are the stable automatic status vocabulary.
- [ ] `journey.disable()` immediately stops automatic capture and removes its listeners without preventing normal navigation or interaction behavior.
- [ ] An ordinary transport reconnect during the consenting page lifetime preserves consent and the previously narrowed capture policy but creates a new Journey session ID on first publication; disablement, auth transition, or page/client-runtime replacement requires explicit enablement again.
- [ ] Browser-runtime tests cover navigation APIs, back/forward and hash changes, focus/visibility, click/submit, keyboard activation, default prevention, stopped propagation, nested/duplicate annotations, open/closed Shadow DOM boundaries, manual override, excluded data, and listener teardown.
- [ ] Interaction tests prove delegated capture works without React, Preact, Vue, Svelte, SolidJS, Lit, or Inferno event APIs.
- [ ] Tests prove the same observer works independently of React, Preact, Vue, Svelte, SolidJS, Lit, or Inferno lifecycle APIs, with explicit `journey.set(...)` documented for routers that change view state without browser location or semantic-meta changes.
- [ ] Source and generated client runtime artifacts retain identical automatic-capture behavior.
