# Changes

## Unreleased - 2026-08-09

Changes since v0.6.6.

### ⚠️ Breaking Changes

- Add runtime-owned password reset links (2affdf7).

### 🚀 Features

- Sporades hub concept (24bb880).
- Add runtime bundle module boundaries PRD and tickets (e04a5b8).
- Add issue 11: extract the shared method set behind an engine seam (06798a2).
- Add prefactor issue 07 to open a conflict-free conformance seam (62ee7c2).
- Add Database Adapter Engine Conformance spec (229ed2e).

### 🐛 Bug Fixes

- Fix Campfire async database mutations (96ebc5c).
- Fix docs repository context link (ed5e201).
- Fix refactor follow-up correctness gaps (f87ad5e).
- Correct the pre-move export count in http-runtime's header (838eb11).
- Correct the jobs note the ACL batch made stale (9831e30).
- Correct the batch 6 accessor counts and drop the createHmac import the S3 path took with it (df54951).
- Correct the batch 5 straggler count and record batches 4-5 findings (47f8811).
- Fix the photo-library test's schedule race, raise the Node floor, add user preferences as batch 5 (8cbe66f).
- Correct issue 08 blocker parsing (ec1c359).
- Fix override taxonomy and ACL fail-closed scope in adapter ADRs (1e001ef).
- Correct adapter contract ADR against the actual adapters (ded9ea0).
- Fix engine-agnostic result handling in the Database adapter (b723ba0).

### 🔧 Improvements

- Add shutdown hint (2daa7db).
- Add exit hint (bb0550b).
- Verify ticket 05 against a real Postgres, and correct the baseline note (3d1d838).
- Delete the dead mailJsonSize, and record the dead-code inventory under ticket 05 (014044c).
- Mark ticket 04 done and record what the nine batches found (d21957c).
- Record batch 7's plant-caller and comment-suppression findings (ac4c345).
- Drop two dead imports, and correct three counts the batch made stale (dabe053).
- Record batch 6's reverse-graph and orphan-blocker rules (04f7211).
- Move the file and object storage domain into a module, with the sync/async bridge it needed (42f097a).
- Stop the schedule skew probe scanning eight years of minutes on every bundle build (3e19121).
- Record open items raised by batches 1-3 (9d2e0b3).
- Record two known flaky tests for the migration batches (bc6e911).
- Record the verification policy for ticket 04's batches (40d1f16).
- Make ticket 04 concrete: eight named batches in landing order (1c3722c).
- Mark ticket 03 done (ce064ce).
- Mark ticket 01 done; close issue 17 as superseded by it (ca59c0e).
- Mark ticket 02 done (c91f102).
- Mark issue 12 done (e9d0842).
- Mark issue 16 done (38610b8).
- Serialize the bundle preamble constants (f8f5daf).
- Mark issue 15 done; file issue 17 for a live inspection-query injection (71ff7c3).
- Mark issue 13 done; file issue 16 for the preamble constant duplication (1845e89).
- Mark issue 14 done (1821ad4).
- Record the identifier-casing decision on issue 12 (0a4d629).
- Mark issue 11 done; file issue 15 for the SQL skipper blind spot (a871d9c).
- Consolidate the removed-override notes in the two service adapters (5eb91bd).
- Consume an OAuth state in one statement on every engine (58a4149).
- Take the catalog queries from the dialect (3f2338e).
- Take the upsert form from the dialect (8eb82ca).
- Define the Database adapter method set once, behind a dialect (773f46f).
- Mark issue 10 done; file issues 13 and 14 from its review (09c8370).
- Mark issue 09 done (a642324).
- Record the app-table collision hazard on issue 12 (9aa3695).
- Mark issue 08 done (77c077f).
- File issue 12 and record how to run the Postgres leg locally (42664c0).
- Declare issue 11's dependency on issue 08 explicitly (e2d1a1d).
- Record the Log index tie-break decision on issue 10 (171976a).
- File issues 09 and 10 for items routed out of issues 05 and 06 (d508a7d).
- Mark issue 05 done (603bbe4).
- Mark issues 03 and 04 done; add issue 08 for Postgres column mapping (79d228d).
- Mark issue 07 done (07f88dc).
- Break Database Adapter Engine Conformance into tickets (ca1904f).
- Rebuild generated bundle and dist output (71f3820).

### 📝 Documentation

- Split feature reference into focused pages (2209883).
- Expand template and framework guide (ad3df2f).
- Document database backend configuration (a500d47).
- Move SMTP documentation outside of sealed envelope sub-sections (dc38db9).
- Close ticket 05: update the ADRs, delete three dead functions, record the trade (a401b16).
- Record what batch 9 cost and what it found, in ADR-0041 and ADR-0042 (16f7e3e).
- Record batch 8's shape finding, its cycle, and what its probe would have dropped (9f743e9).
- Record batch 7 in ADR-0041, and correct two stale batch numbers (c6e123d).
- Record batch 6's findings in ADR-0041 and ADR-0042 (abcb177).
- Record batch 5's findings in ADR-0041 (c95ec27).
- Move the jobs and schedules domain into a module (0ed63e2).
- Move the auth domain into a module (81ae7c6).
- Move the mail domain into a module (6e4645e).
- Move the internal log-index guard into a module, and generalise the walker guard subjects (ebf379f).
- Close the census's blind spot, make the freshness claim true, and correct ADR-0041 (c4febe8).
- Harden the inspection-surface probe, and record what the sync transform costs (217f738).
- Move the read-only inspection validator into a module (ffd9cf9).
- Describe what the walker census detects instead of claiming completeness (e7a2c3c).
- Make the WebSocket broadcast comparison deterministic (32ad5a7).
- Widen the walker census to patterns, and state what it cannot see (6d53b94).
- Reach the module-graph bundle from the shipping CLI path (a33bae3).
- Make the walker guard walker-coupled, and record the sixth walker (b5b5866).
- Collapse the two SQL walkers into one dialect-parameterized tokenizer (059b823).
- Measure the gate against the pre-work base, not the previous round (0de1d66).
- Refuse SQL the two line-comment rules read differently (80c14e4).
- Quote every identifier in emitted SQL through the dialect (d11981a).
- Derive the nesting test instead of describing it (b9fb455).
- Refuse SQL the walk and an engine lex differently (4506b18).
- Close the inspection query statement boundary (18e710f).
- Record the dollar-quote dialect divergence in the PRD (883834d).
- Describe a Postgres statement without breaking on its terminator (39497c5).
- Record the engine seam as ADR-0037 (788c97f).
- Sequence the Log index so its order is engine-independent (a17d353).
- Support local Capsule templates (bf3a503).
- Close issue 01 and fix the scope gap its reviews exposed (10938fe).
- Separate the write-only hazard from the deriving hazard (8186b85).
- Record Database adapter contract and conformance ADRs (7d3575d).
- Update documentation files in the working tree: docs/api/assets/navigation.js, docs/api/assets/search.js, docs/api/functions/client.createHooks.html, docs/api/functions/client.createInfernoAdapters.html, docs/api/functions/client.createLitControllers.html, docs/api/functions/client.createSolidPrimitives.html, docs/api/functions/client.createSvelteStores.html, docs/api/functions/client.createVueComposables.html, docs/api/functions/client.isAuthenticated.html, docs/api/functions/client.onMessage.html, docs/api/functions/client.sendMessage.html, docs/api/functions/server.Boolean.html, docs/api/functions/server.capsule.html, docs/api/functions/server.Date.html, docs/api/functions/server.endpoint.html, docs/api/functions/server.job.html, docs/api/functions/server.Json.html, docs/api/functions/server.message.html, docs/api/functions/server.mutation.html, docs/api/functions/server.Number.html, docs/api/functions/server.query.html, docs/api/functions/server.Reference.html, docs/api/functions/server.requireAuth.html, docs/api/functions/server.schedule.html, docs/api/functions/server.String.html, docs/api/functions/server.table.html, docs/api/modules/server.html, docs/api/types/client.AppMessage.html, docs/api/types/client.AppMessageStream.html, docs/api/types/client.AuthApi.html, docs/api/types/client.FileMetadata.html, docs/api/types/client.FileReference.html, docs/api/types/client.FilesApi.html, docs/api/types/client.HookPrimitives.html, docs/api/types/client.InfernoAdapterHost.html, docs/api/types/client.InfernoAuthAdapter.html, docs/api/types/client.InfernoMutationAdapter.html, docs/api/types/client.InfernoObservedAdapter.html, docs/api/types/client.InfernoQueryAdapter.html, docs/api/types/client.LitAuthController.html, docs/api/types/client.LitMutationController.html, docs/api/types/client.LitQueryController.html, docs/api/types/client.LitReactiveController.html, docs/api/types/client.LitReactiveControllerHost.html, docs/api/types/client.MutationsApi.html, docs/api/types/client.MutationState.html, docs/api/types/client.PreferencesApi.html, docs/api/types/client.PreferencesResult.html, docs/api/types/client.PublicFileUrl.html, docs/api/types/client.PublicUrlOptions.html, docs/api/types/client.QueriesApi.html, docs/api/types/client.QueryState.html, docs/api/types/client.SolidAccessor.html, docs/api/types/client.SolidAuth.html, docs/api/types/client.SolidMutation.html, docs/api/types/client.SolidMutationState.html, docs/api/types/client.SolidPrimitiveInputs.html, docs/api/types/client.SolidSignalSetter.html, docs/api/types/client.SporadesHooks.html, docs/api/types/client.SporadesInfernoAdapters.html, docs/api/types/client.SporadesLitControllers.html, docs/api/types/client.SporadesSolidPrimitives.html, docs/api/types/client.SporadesSvelteStores.html, docs/api/types/client.SporadesVueComposables.html, docs/api/types/client.Subscription.html, docs/api/types/client.SvelteAuthStore.html, docs/api/types/client.SvelteMutationStore.html, docs/api/types/client.SvelteReadable.html, docs/api/types/client.UploadCompleteEvent.html, docs/api/types/client.UploadOptions.html, docs/api/types/client.UploadProgressEvent.html, docs/api/types/client.UseAuthState.html, docs/api/types/client.VueComposablePrimitives.html, docs/api/types/client.VueMutationState.html, docs/api/types/server.Capsule.html, docs/api/types/server.CapsuleContext.html, docs/api/types/server.CapsuleDefinition.html, docs/api/types/server.CapsuleHooks.html, docs/api/types/server.ContextKind.html, docs/api/types/server.ContextMiddleware.html, docs/api/types/server.EndpointContext.html, docs/api/types/server.EndpointDefinition.html, docs/api/types/server.EndpointHandler.html, docs/api/types/server.EndpointOptions.html, docs/api/types/server.EndpointRequest.html, docs/api/types/server.JobApi.html, docs/api/types/server.JobDefinition.html, docs/api/types/server.JobState.html, docs/api/types/server.JobStatus.html, docs/api/types/server.JobSummary.html, docs/api/types/server.MessageApi.html, docs/api/types/server.MessageDefinition.html, docs/api/types/server.MessageHandler.html, docs/api/types/server.MessageScope.html, docs/api/types/server.MiddlewareContext.html, docs/api/types/server.MutationDefinition.html, docs/api/types/server.MutationHandler.html, docs/api/types/server.MutationHook.html, docs/api/types/server.MutationHookEvent.html, docs/api/types/server.MutationResult.html, docs/api/types/server.PasswordResetLink.html, docs/api/types/server.PasswordResetMailOptions.html, docs/api/types/server.PrivilegedApi.html, docs/api/types/server.PrivilegedAuthContext.html, docs/api/types/server.PrivilegedContext.html, docs/api/types/server.PrivilegedFileApi.html, docs/api/types/server.PrivilegedFileError.html, docs/api/types/server.PrivilegedFileMetadata.html, docs/api/types/server.PrivilegedOwnedFileMetadata.html, docs/api/types/server.PrivilegedPublicFileUrl.html, docs/api/types/server.PrivilegedResult.html, docs/api/types/server.PrivilegedRunOptions.html, docs/api/types/server.QueryDefinition.html, docs/api/types/server.QueryHandler.html, docs/api/types/server.ScheduleContext.html, docs/api/types/server.ScheduleDefinition.html, docs/api/types/server.ScheduleInspectionApi.html, docs/api/types/server.ScheduleLatestOccurrence.html, docs/api/types/server.ScheduleOccurrence.html, docs/api/types/server.SchedulePayloadFactory.html, docs/api/types/server.ScheduleSummary.html, docs/api/types/server.ServerAuthApi.html, docs/api/variables/client.auth.html, docs/api/variables/client.files.html, docs/api/variables/client.journey.html, docs/api/variables/client.mutations.html, docs/api/variables/client.preferences.html, docs/api/variables/client.queries.html.

### 🧪 Tests

- Delete the emitted function list and close the census hole it was hiding (67cc386).
- Delete the emitted-list builder, its skew probes and the free-binding guard (4f0cd77).
- Make the module-graph bundle the only server bundle a build produces (c5484ee).
- Prove batch 9's guards by sabotage, and sharpen two probe fixtures that could not see one (d76a670).
- Move the Database adapters and dialect into a module (1c3b80b).
- Send the auth storage bootstrap home, and give the Log index's storage a module (38784d2).
- Bring the writing half of the stored-value codec beside the reading half (d733a38).
- Move the HTTP and security policy domain into a module (bcbe1ca).
- Move the ACL and privileged-audit domain into acl-runtime.ts (b044841).
- Extract the two non-domain blockers the ACL domain's graph left outside it (8a8fa7d).
- Extend the carried-private-helper guard to the storage domain's subjects (c737b18).
- Compare the storage domain between the two bundles, and cover it in the census (e7fcb1a).
- Compare the user-preferences domain between the two bundles, and cover it in the census (d395d1b).
- Move the user-preferences domain into a module, and finish the auth region with it (3e118db).
- Resolve the two Job storage bootstraps by import rather than through the emitted list (e656405).
- Build the server bundle from a module graph (efba985).
- Run the keyword scan under both line-comment rules (833d1b1).
- Spell a dollar-quote tag with the alphabet the guard already counts (0d9b088).
- Teach the SQL skipper Postgres's dollar quoting and E-strings (76b58f0).
- Make the emitted bundle define every identifier it references (04c7ad3).
- Guard the Log index additive migration from a pre-change table (39a70e3).
- Name row and value normalization as the seam's third part (512cfe2).
- Take the add-missing-column strategy from the dialect (75316aa).
- Derive the rollback case's before-state instead of fixing it (db5d23b).
- Route shared schema migration through the adapter's transaction (a8c5b9c).
- Close the Postgres runtime column-name gap with a derived check (2de0d07).
- Rename database.sqlite to database.adapter throughout the runtime (bb48f94).
- Tie coverage credit to per-engine execution, and seed the tables the DDL cases missed (8c33c42).
- Require a conformance case for every Database adapter method (f39c8c1).
- Extend conformance coverage to app tables and runtime metadata (d35de97).
- Extend conformance coverage to auth storage (a6ff912).
- Extend conformance coverage to File metadata storage (0cb2421).
- Open a conflict-free conformance extension seam (7815529).
- Run one conformance specification against every Database adapter (5f41be2).
- Resolve the reset-code cap against the stored row, not the pending query (80a6503).

### 📦 Packaging

- Make a browser global in a runtime module a compile error, not a shipped one (d9e7dec).
