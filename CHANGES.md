# Changes

## v0.9.44 - 2026-11-08

Changes since v0.9.43.

### 🚀 Features

- Add gh-package command for npm releases (04883135).
- Add explicit observability acceptance workflow (#341) (014dcc69).
- Add protected SMTP configuration for managed GlitchTip (#336) (3a4d90e0).

### 🐛 Bug Fixes

- Expose exact administrator counts to Team Billing authority (#342) (c2d6ca9b).

### 🔧 Improvements

- Regenerate dist and bin [skip ci] (b161ca08).
- Regenerate dist and bin [skip ci] (f462b80e).
- Regenerate dist and bin [skip ci] (7168e369).
- Regenerate dist and bin [skip ci] (3051c57c).
- Regenerate dist and bin [skip ci] (fd16c275).
- Regenerate dist and bin [skip ci] (a94ce0fb).
- Regenerate dist and bin [skip ci] (003923bd).
- Regenerate dist and bin [skip ci] (2c237ed1).
- Regenerate dist and bin [skip ci] (e9ca983a).

### 📝 Documentation

- Preserve exception stacks and safe runtime context (#339) (d44389d9).
- Bound QA memory and report resource exhaustion (#347) (c9562897).
- Give QA a bounded full regression gate (#346) (04ef9751).
- Give managed GlitchTip projects readable names (#338) (0eb8dbb7).
- Keep retrying browser connections through Capsule outages (#343) (b944ab0f).
- Verify Capsule handler failures in pinned GlitchTip (#337) (0334b4eb).
- Route shared Umami through its configured public hostname (#330) (1c660646).
- Preserve Caddy service access to private Capsule routes (#329) (e6014874).
- Update documentation files in the working tree: docs/api/assets/navigation.js, docs/api/assets/search.js, docs/api/functions/client.createHooks.html, docs/api/functions/client.createInfernoAdapters.html, docs/api/functions/client.createLitControllers.html, docs/api/functions/client.createSolidPrimitives.html, docs/api/functions/client.createSvelteStores.html, docs/api/functions/client.createVueComposables.html, docs/api/functions/client.isAuthenticated.html, docs/api/functions/client.onMessage.html, docs/api/functions/client.sendMessage.html, docs/api/functions/server.Boolean.html, docs/api/functions/server.capsule.html, docs/api/functions/server.Date.html, docs/api/functions/server.emailEvent.html, docs/api/functions/server.endpoint.html, docs/api/functions/server.endpointError.html, docs/api/functions/server.endpointFor.html, docs/api/functions/server.job.html, docs/api/functions/server.Json.html, docs/api/functions/server.message.html, docs/api/functions/server.mutation.html, docs/api/functions/server.Number.html, docs/api/functions/server.query.html, docs/api/functions/server.Reference.html, docs/api/functions/server.requireAuth.html, docs/api/functions/server.requireUserAuth.html, docs/api/functions/server.schedule.html, docs/api/functions/server.String.html, docs/api/functions/server.stripeEvent.html, docs/api/functions/server.table.html, docs/api/interfaces/client.PrerenderApi.html, docs/api/interfaces/client.PrerenderBoundary.html, docs/api/modules/client.html, docs/api/types/client.AccessKeyError.html, docs/api/types/client.AccessKeyErrorCode.html, docs/api/types/client.AccessKeyListPage.html, docs/api/types/client.AccessKeyRevocationCause.html, docs/api/types/client.AccessKeysApi.html, docs/api/types/client.AccessKeySecretResult.html, docs/api/types/client.AccessKeyStatus.html, docs/api/types/client.AccessKeySummary.html, docs/api/types/client.AppMessage.html, docs/api/types/client.AppMessageStream.html, docs/api/types/client.AuthApi.html, docs/api/types/client.AuthObserverState.html, docs/api/types/client.AuthProviders.html, docs/api/types/client.AuthResult.html, docs/api/types/client.AuthState.html, docs/api/types/client.EmailCredentials.html, docs/api/types/client.FileMetadata.html, docs/api/types/client.FileReference.html, docs/api/types/client.FilesApi.html, docs/api/types/client.FileUploadError.html, docs/api/types/client.FileUploadErrorCode.html, docs/api/types/client.HookPrimitives.html, docs/api/types/client.InfernoAdapterHost.html, docs/api/types/client.InfernoAuthAdapter.html, docs/api/types/client.InfernoMutationAdapter.html, docs/api/types/client.InfernoObservedAdapter.html, docs/api/types/client.InfernoQueryAdapter.html, docs/api/types/client.IssueAccessKeyInput.html, docs/api/types/client.JourneyApi.html, docs/api/types/client.JourneyCapture.html, docs/api/types/client.JourneyEnableOptions.html, docs/api/types/client.JourneyEnableResult.html, docs/api/types/client.JourneyEvent.html, docs/api/types/client.JourneyRecord.html, docs/api/types/client.JourneySetInput.html, docs/api/types/client.JourneySubscription.html, docs/api/types/client.JsonObject.html, docs/api/types/client.JsonValue.html, docs/api/types/client.ListAccessKeysOptions.html, docs/api/types/client.LitAuthController.html, docs/api/types/client.LitMutationController.html, docs/api/types/client.LitQueryController.html, docs/api/types/client.LitReactiveController.html, docs/api/types/client.LitReactiveControllerHost.html, docs/api/types/client.MutationsApi.html, docs/api/types/client.MutationState.html, docs/api/types/client.PaymentsApi.html, docs/api/types/client.PaymentsState.html, docs/api/types/client.PreferencesApi.html, docs/api/types/client.PreferencesResult.html, docs/api/types/client.ProviderState.html, docs/api/types/client.PublicFileUrl.html, docs/api/types/client.PublicUrlOptions.html, docs/api/types/client.QueriesApi.html, docs/api/types/client.QueryState.html, docs/api/types/client.RegistrationOptions.html, docs/api/types/client.RotateAccessKeyOptions.html, docs/api/types/client.SolidAccessor.html, docs/api/types/client.SolidAuth.html, docs/api/types/client.SolidMutation.html, docs/api/types/client.SolidMutationState.html, docs/api/types/client.SolidPrimitiveInputs.html, docs/api/types/client.SolidSignalSetter.html, docs/api/types/client.SporadesError.html, docs/api/types/client.SporadesErrorEventDetail.html, docs/api/types/client.SporadesHooks.html, docs/api/types/client.SporadesInfernoAdapters.html, docs/api/types/client.SporadesLitControllers.html, docs/api/types/client.SporadesResult.html, docs/api/types/client.SporadesSolidPrimitives.html, docs/api/types/client.SporadesSvelteStores.html, docs/api/types/client.SporadesVueComposables.html, docs/api/types/client.Subscription.html, docs/api/types/client.SvelteAuthStore.html, docs/api/types/client.SvelteMutationStore.html, docs/api/types/client.SvelteReadable.html, docs/api/types/client.TeamApplicationRoleChanges.html, docs/api/types/client.TeamBillingApi.html, docs/api/types/client.TeamBillingCheckoutRequest.html, docs/api/types/client.TeamBillingCheckoutResult.html, docs/api/types/client.TeamBillingErasureRequest.html, docs/api/types/client.TeamBillingErasureResult.html, docs/api/types/client.TeamBillingPlanTransitionRequest.html, docs/api/types/client.TeamBillingPlanTransitionResult.html, docs/api/types/client.TeamBillingPortalRequest.html, docs/api/types/client.TeamBillingPortalResult.html, docs/api/types/client.TeamBillingProjection.html, docs/api/types/client.TeamJoinLink.html, docs/api/types/client.TeamJoinLinkCreateResult.html, docs/api/types/client.TeamJoinLinkInspection.html, docs/api/types/client.TeamJoinLinksListResult.html, docs/api/types/client.TeamJoinLinkValidation.html, docs/api/types/client.TeamMemberCountResult.html, docs/api/types/client.TeamMembersListOptions.html, docs/api/types/client.TeamMembersListResult.html, docs/api/types/client.TeamMemberSummary.html, docs/api/types/client.TeamMutationResult.html, docs/api/types/client.TeamsApi.html, docs/api/types/client.TeamsListResult.html, docs/api/types/client.TeamSummary.html, docs/api/types/client.UploadCompleteEvent.html, docs/api/types/client.UploadOptions.html, docs/api/types/client.UploadProgressEvent.html, docs/api/types/client.UseAuthState.html, docs/api/types/client.VueComposablePrimitives.html, docs/api/types/client.VueMutationState.html, docs/api/types/server.AnalyticsConfig.html, docs/api/types/server.AtomicStripeConsequenceContext.html, docs/api/types/server.AtomicStripeEventDefinition.html, docs/api/types/server.AtomicStripeEventHandler.html, docs/api/types/server.AuthGuardedHandler.html, docs/api/types/server.Capsule.html, docs/api/types/server.CapsuleContext.html, docs/api/types/server.CapsuleDefinition.html, docs/api/types/server.CapsuleFileAccessKeyPolicy.html, docs/api/types/server.CapsuleHooks.html, docs/api/types/server.CapsuleServices.html, docs/api/types/server.ContextKind.html, docs/api/types/server.ContextMiddleware.html, docs/api/types/server.CurrentUserFilesApi.html, docs/api/types/server.CurrentUserTeamsApi.html, docs/api/types/server.DeclarativeRequireAuthOptions.html, docs/api/types/server.EmailEventDefinition.html, docs/api/types/server.EmailEventHandler.html, docs/api/types/server.EmailEventKind.html, docs/api/types/server.EndpointBodyBytes.html, docs/api/types/server.EndpointBuilder.html, docs/api/types/server.EndpointContext.html, docs/api/types/server.EndpointDefinition.html, docs/api/types/server.EndpointErrorHeaders.html, docs/api/types/server.EndpointFileAttachmentApi.html, docs/api/types/server.EndpointFileAttachmentContext.html, docs/api/types/server.EndpointFileAttachmentHandler.html, docs/api/types/server.EndpointFileAttachmentOptions.html, docs/api/types/server.EndpointFileAttachmentOptionsDeclaration.html, docs/api/types/server.EndpointFileAttachmentReference.html, docs/api/types/server.EndpointFileAttachmentResponse.html, docs/api/types/server.EndpointFileIngressApi.html, docs/api/types/server.EndpointFileIngressInspection.html, docs/api/types/server.EndpointFileIngressLease.html, docs/api/types/server.EndpointFileMetadata.html, docs/api/types/server.EndpointHandler.html, docs/api/types/server.EndpointOptions.html, docs/api/types/server.EndpointRequest.html, docs/api/types/server.FileIngressOptions.html, docs/api/types/server.JobApi.html, docs/api/types/server.JobDefinition.html, docs/api/types/server.JobHandlerContext.html, docs/api/types/server.JobState.html, docs/api/types/server.JobStatus.html, docs/api/types/server.JobSummary.html, docs/api/types/server.MessageApi.html, docs/api/types/server.MessageDefinition.html, docs/api/types/server.MessageHandler.html, docs/api/types/server.MessageScope.html, docs/api/types/server.MiddlewareContext.html, docs/api/types/server.MutationDefinition.html, docs/api/types/server.MutationHandler.html, docs/api/types/server.MutationHook.html, docs/api/types/server.MutationHookEvent.html, docs/api/types/server.MutationResult.html, docs/api/types/server.ObservabilityConfig.html, docs/api/types/server.PasswordResetLink.html, docs/api/types/server.PasswordResetMailOptions.html, docs/api/types/server.PrivilegedApi.html, docs/api/types/server.PrivilegedAuthContext.html, docs/api/types/server.PrivilegedContext.html, docs/api/types/server.PrivilegedFileApi.html, docs/api/types/server.PrivilegedFileError.html, docs/api/types/server.PrivilegedFileListOptions.html, docs/api/types/server.PrivilegedFileListPage.html, docs/api/types/server.PrivilegedFileMetadata.html, docs/api/types/server.PrivilegedListedFileMetadata.html, docs/api/types/server.PrivilegedOwnedFileMetadata.html, docs/api/types/server.PrivilegedPublicFileUrl.html, docs/api/types/server.PrivilegedResult.html, docs/api/types/server.PrivilegedRunOptions.html, docs/api/types/server.PrivilegedTeamBillingApi.html, docs/api/types/server.PrivilegedTeamBillingQuarantine.html, docs/api/types/server.PrivilegedTeamsApi.html, docs/api/types/server.QueryDefinition.html, docs/api/types/server.QueryHandler.html, docs/api/types/server.RateLimitOptions.html, docs/api/types/server.RateLimitResult.html, docs/api/types/server.RegistrationAdmission.html, docs/api/types/server.RegistrationEvidence.html, docs/api/types/server.RegistrationThrottleConfig.html, docs/api/types/server.ResourceAdapterSupport.html, docs/api/types/server.ResourceIdentity.html, docs/api/types/server.ResourceNotification.html, docs/api/types/server.ResourceNotificationIntentStatus.html, docs/api/types/server.ResourceNotificationRecipientStatus.html, docs/api/types/server.ResourceRunOptions.html, docs/api/types/server.ResourcesApi.html, docs/api/types/server.ResourceScope.html, docs/api/types/server.ResourceStatus.html, docs/api/types/server.ResourceStatusOptions.html, docs/api/types/server.ScheduleContext.html, docs/api/types/server.ScheduleDefinition.html, docs/api/types/server.ScheduleInspectionApi.html, docs/api/types/server.ScheduleLatestOccurrence.html, docs/api/types/server.ScheduleOccurrence.html, docs/api/types/server.SchedulePayloadFactory.html, docs/api/types/server.ScheduleSummary.html, docs/api/types/server.SecurityConfig.html, docs/api/types/server.ServerEnvConfig.html, docs/api/types/server.ServerFileMetadata.html, docs/api/types/server.SessionlessEndpointContext.html, docs/api/types/server.SessionlessEndpointHandler.html, docs/api/types/server.SessionlessEndpointOptions.html, docs/api/types/server.StripeEventDefinition.html, docs/api/types/server.StripeEventHandler.html, docs/api/types/server.TeamBillingAuthorityContext.html, docs/api/types/server.TeamBillingDefinition.html, docs/api/types/server.VerifiedEmailEvent.html, docs/api/variables/client.accessKeys.html, docs/api/variables/client.auth.html, docs/api/variables/client.files.html, docs/api/variables/client.journey.html, docs/api/variables/client.mutations.html, docs/api/variables/client.payments.html, docs/api/variables/client.preferences.html, docs/api/variables/client.prerender.html, docs/api/variables/client.queries.html, docs/api/variables/client.teamBilling.html, docs/api/variables/client.teams.html.

## v0.9.43 - 2026-11-01

Changes since v0.9.42.

### 🚀 Features

- Allow registry propagation before verifying npm releases (#324) (15bdab53).

### 🐛 Bug Fixes

- Fix dependency audit vulnerabilities (#328) (cd70c8de).

### 🔧 Improvements

- Regenerate dist and bin [skip ci] (de2841c9).
- Regenerate dist and bin [skip ci] (57a49c25).

### 📝 Documentation

- Preserve endpoint security on rollback and record ingress refusals (#327) (1a7e2185).
- Trigger npm releases from labelled Release issues (#325) (83a9c292).

## v0.9.42 - 2026-10-30

Changes since v0.9.41.

### 🚀 Features

- Add atomic Capsule password-change reservations (#320) (94b959e7).
- Add declared local Capsule container services (#315) (56a08078).

### 🐛 Bug Fixes

- Fix Hosted route worker readiness timeout and record hosted acceptance (#321) (09f7e539).

### 🔧 Improvements

- Regenerate dist and bin [skip ci] (b936a834).
- Regenerate dist and bin [skip ci] (5ecc7466).
- Regenerate dist and bin [skip ci] (898582f5).
- Regenerate dist and bin [skip ci] (02920387).

### 📝 Documentation

- Automate npm releases with GitHub OIDC trusted publishing (#322) (31e6606c).
- Reconcile Hosted routes after dynamic Docker port changes (#317) (08ff36b8).

## v0.9.41 - 2026-10-24

Changes since v0.9.40.

### 🚀 Features

- Allow any script version (4a43c515).
- Add Capsule implicitMutations opt-out for the implicit table mutation surface (#304) (9692d63e).
- Add explicitly sessionless public endpoints (#308) (1b367744).
- Add atomic Capsule admission for additional Team creation (#305) (d74d7999).

### 🐛 Bug Fixes

- Prevent account-wide sign-in lockout with bounded verification (#299) (b73dc192).

### 🔧 Improvements

- Regenerate dist and bin [skip ci] (271b05d2).
- Regenerate dist and bin [skip ci] (9c3e3204).

### 📝 Documentation

- Build dist and bin on main with local CI (#314) (3f555768).
- Remove the runtime-owned ctx.env browser query (#289) (#301) (cde2b5cf).
- Reject email signup from linked identities (#300) (e6348a83).
- Make the full test suite pass in office worktrees (#309) (23d1663d).
- Expose shared rate limits during Capsule File ingress admission (#307) (2f57e950).
- Revoke all account authority atomically on a browser password change (#302) (32962832).
- Isolate public collection budgets from server error delivery (#303) (c1956ad0).

### 🧪 Tests

- Wait for exported durable Job metrics (#311) (48951c93).

## v0.9.40 - 2026-10-23

Changes since v0.9.39.

### 📝 Documentation

- Upgrade Capsule base to Node 24 LTS and normalize npm pack JSON (#288) (8f5ecc5b).

### 🧪 Tests

- Describe SQLite inspection columns without StatementSync#columns() (#287) (9b29b3d5).

## v0.9.39 - 2026-10-22

Changes since v0.9.38.

### 🚀 Features

- Add read-only sporades host db list|dump|query (#286) (c9f0d358).

## Unreleased

### 🔒 Security

- Remove the runtime-owned `ctx.env` browser query (#289). Query clients,
  including Anonymous Sessions, could subscribe to the undeclared `ctx.env`
  name and receive the entire server environment. That name now follows the
  ordinary unknown-query response and returns no environment data, while
  `ctx.env` stays available to trusted server handlers. A Capsule that declares
  its own query with that name keeps the normal declared-query contract.

### 📦 Packaging

- Upgrade the default Capsule Base image to `0.3.0-node24-alpine`, using Node
  24.22.1 LTS on Alpine 3.23 with a pinned upstream image digest. Upgrade the CLI
  and Host helper and redeploy to replace existing containers; restarting a
  release preserves its pinned image. Keep explicit image overrides unchanged.
- Normalize npm pack JSON metadata across flat and package-keyed formats in
  release verification and packaged compatibility checks, preserving artifact
  hashes and rejecting ambiguous output.

### 🚀 Features

- Let Capsules opt out of implicit table mutations (#292). Declaring
  `implicitMutations: false` bounds the mutation surface to explicitly declared
  names: every undeclared name answers the ordinary unknown-mutation refusal
  before context middleware, any fallback write, mutation hooks, or success
  effects such as the deferred query rebroadcast. Omitting the flag or passing
  `true` keeps 0.9.x behavior, where undeclared names that describe a table
  (`addNote`, `updateNoteText`) insert or update rows under their fallback
  semantics. Declared mutations, server `ctx.db`, implicit table queries and
  table ACLs keep their behavior, and a bundled declared mutation matching the
  generated scaffold `add…` body stops riding the implicit path while the
  surface is retired. Present non-boolean values are rejected at authoring and
  at Capsule startup (`INVALID_IMPLICIT_MUTATIONS`). The flag is not business
  quota enforcement; declare checks in mutations, ACL rules, or hooks.
- Add read-only `sporades host db list|dump|query` for running Hosted Capsules (#285).
  It runs the Host helper over the operator's existing SSH access and the
  generated Bundle's one-shot action seam, opens the Capsule SQLite file
  read-only and query-only without stopping the Capsule, and refuses mutating
  SQL both locally and in the runtime. `--json` output matches
  `sporades db list|dump|query --json` against a Dev session. `--subname`
  defaults to the project's Host binding. Requires `sporades host upgrade` and
  a redeploy with this CLI; no public route is added.

### 🐛 Bug Fixes

- Fix `sporades host db query` failing with "columns is not a function" on
  Hosted Capsules. The previous Base image ran Node 22.14, whose `node:sqlite` lacks
  `StatementSync#columns()` (added in 22.16). SQLite inspection queries now
  describe their columns without it, including zero-row results, so Hosted,
  Dev and MCP ops queries on Node 22.13–22.15 return the same
  `{ ok, data: { columns, rows }, error }` envelope. Requires a redeploy with
  this CLI.

## v0.9.38 - 2026-10-22

Changes since v0.9.37.

### 🐛 Bug Fixes

- Fix documentation CI by preserving published release notes (#283) (9ea3c2e5).

### 📦 Packaging

- Replace deprecated OpenTelemetry trace SDK (#284) (109fee6f).

## v0.9.37 - 2026-10-22

Changes since v0.9.36.

- Replace the deprecated OpenTelemetry trace SDK dependency with
  `@opentelemetry/sdk-trace` to remove its npm installation warning.

## v0.9.36 - 2026-10-22

Changes since v0.9.35.

### 🚀 Features

- Add opt-in Capsule MCP bridge (ADR 0059) (#279) (e277f5c1).
- Add a runtime-owned, server-only `ctx.ai` client for OpenAI-compatible endpoints (#276, #277).
  The opt-in `sporades.json` `ai` block selects Chat Completions or the Responses API
  (`store: false`), a base URL and model; the key lives in Sealed Server env under
  `keyEnv` (default `AI_API_KEY`) and an unset key leaves the client dormant without
  joining the required Server env set. `ctx.ai.chat(...)` never throws or retries and
  resolves closed `AI_*` result codes; prompt and response content is never logged.

### 🐛 Bug Fixes

- Fix ctx.ai key scoping, per-call override activation, and Node 24 endpoint signal (#281) (d73bb8af).

### 📦 Packaging

- Fail fast when npm registry calls error or hang in package script (#282) (57ed5f7d).

## v0.9.35 - 2026-10-20

Changes since v0.9.34.

### 🚀 Features

- Add atomic human identity termination (ADR 0057) (#273) (769df876).
- Add day-based Host backup retention (retentionDays / keep-within) (#275) (3724e2ad).
- Allow loopback Stripe API origins in Dev sessions (#270) (57a9aec3).

### 🐛 Bug Fixes

- Fix runtime injection on secondary HTML documents (#274) (91e06995).

### 🔧 Improvements

- Bump ignore (b2e1be97).

### 📝 Documentation

- Ship a stateful Stripe Team Billing fake (#269) (bceed0bc).
- Propose a supported Team Billing test-provider boundary (ADR 0058) (#268) (e62eaf87).
- Propose atomic human identity termination in ADR 0057 (#267) (29995233).
- Forbid Compose merge keys and value-bind Host elevation in ADR 0056 (#261) (edf701a6).

## v0.9.11 - 2026-09-02

Corrects the incomplete `0.9.10` npm package, which was published from a stale
local checkout before the merged release commit was pulled. This release
contains the reviewed Human Security, Service User, and lifecycle-continuation
runtime, generated artifacts, and documentation from merged `main`.

## v0.9.10 - 2026-08-31

Changes since v0.9.9.

### 🚀 Features

- Add purpose-bound reauthentication proofs (c4ddd032).
- Preserve provider-free headless Team Billing platform mechanics while Capsule UI remains app-owned.
- Add transaction-bound human Session and Access-key retirement for administrative security transitions.
- Add first-class Service Users and service-owned Access keys for named
  automation, with atomic Session-authorized lifecycle management and exact
  actor/credential provenance.

### 📝 Documentation

- Preserve the provider-free, headless Team Billing boundary: Sporades owns
  mechanics while Capsules render subscriber-visible product experience.
- Document when to use Service Users, their authority intersection, and the
  lifecycle and operational trade-offs.
- Request Google signed reauthentication time (2fa291dc).
- Verify OAuth reauthentication freshness (7a6c989a).
- Persist and serialize email reauthentication (74ef1c50).
- Harden email reauthentication contracts (a919df94).
- Sweep expired proofs before guarded mutations (c888d70c).
- Harden reauthentication lifecycle (c8189c58).
- Bind reauthentication to active sessions (e692028f).

### 🧪 Tests

- Cover Service-User rollback, lifecycle races, restart denial, provenance,
  compatibility, and secret redaction.
- Retire proofs during Session rotation (b1e25b48).
- Harden reauthentication failure and ordering proof (8f933b91).
- Require active User for proof consumption (465bf5a4).
- Recheck OAuth authorization at callback (19c4159c).

## Unreleased - 2026-08-26

Changes since v0.9.4.

### 🐛 Bug Fixes

- Dispatch Team billing after mutation commit (62482c15).
- Stage Team billing from mutation transactions (fd649a91).

## 0.8.5 - 2026-08-15

Changes since v0.8.1.

### 🚀 Features

- Add JSON-safe positional arguments to reactive Custom queries across the
  client transport and framework adapters (5b882f5).
- Add exact pagination and join admission (63f68a0).

### 🐛 Bug Fixes

- Resolve npm audit vulnerabilities (a6a4b51).

### 📝 Documentation

- Describe parameterized queries (287ef63).
- Plan reactive query arguments (4876db8).

## 0.8.1 - 2026-08-14

Corrects the incomplete `0.8.0` package release with the merged `main` runtime,
generated artifacts, and documentation.

### 📝 Documentation

- Require current password to change email credentials (bfba651).

### ✨ Built-in Teams

- Add runtime-owned Teams for Capsule collaboration: multi-Team memberships,
  admin lifecycle, email-bound Join links, membership application roles, and
  explicit Team decisions in table and File ACLs. Teams are built in but do
  not select a current Team or automatically partition Capsule data; Sporades
  never sends Join-link email. See the [Built-in Teams reference](https://mgscox.github.io/sporades/reference/teams).


















