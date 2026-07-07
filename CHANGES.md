# Changes

## Unreleased - 2026-07-07

Changes since v0.1.0.

### 🚀 Features

- Add packaging scripts (31a33c5).
- Add consistent change-log generation via skill (0b8bc4f).
- Enable Hosted Capsule SSH access (d59abaa).
- Enable local Container SSH access (8720842).
- Add current-user preferences SDK (570d769).
- Allow dependency install for local repository working (a35db4c).
- Add requireAuth handler helper as the canonical auth gate (7bb7ee6).

### 🔧 Improvements

- Mark user preferences coherence issue done (5e49203).
- Mark user preferences SDK issue done (9119388).
- Mark built-in-auth-helper issue 01 done (2d6d470).
- Rebuild bundle after merging requireAuth helper (160ce44).

### 📝 Documentation

- Update docs (e5e42d6).
- Rewording (aee6676).
- Document Container SSH access (62d9f54).
- Define Container SSH access contract (d23386a).
- Document public SDK API (f135dd0).
- Persist user prefs from anonymous to a signed-up user on registration (d2d9d6c).
- Update docs (7469398).
- Update preference table inspection coverage (790e49c).
- Keep user preferences coherent across sessions (703e826).
- Plan recommended roadmap features (4975e8d).
- Tidy up working files (f29fff5).
- Record service-backed vector path (pgvector) as follow-up (e1dfa7a).
- Promote auth helper and SQLite vector features to ready (ea1610b).
- Update documentation files in the working tree: docs/api/functions/client.createHooks.html, docs/api/functions/client.isAuthenticated.html, docs/api/functions/client.onMessage.html, docs/api/functions/client.sendMessage.html, docs/api/functions/server.Boolean.html, docs/api/functions/server.capsule.html, docs/api/functions/server.Date.html, docs/api/functions/server.endpoint.html, docs/api/functions/server.Json.html, docs/api/functions/server.message.html, docs/api/functions/server.mutation.html, docs/api/functions/server.Number.html, docs/api/functions/server.query.html, docs/api/functions/server.Reference.html, docs/api/functions/server.requireAuth.html, docs/api/functions/server.String.html, docs/api/functions/server.table.html, docs/api/types/client.AppMessage.html, docs/api/types/client.AppMessageStream.html, docs/api/types/client.AuthApi.html, docs/api/types/client.AuthProviders.html, docs/api/types/client.AuthState.html, docs/api/types/client.EmailCredentials.html, docs/api/types/client.FileMetadata.html, docs/api/types/client.FileReference.html, docs/api/types/client.FilesApi.html, docs/api/types/client.HookPrimitives.html, docs/api/types/client.JsonObject.html, docs/api/types/client.JsonValue.html, docs/api/types/client.MutationState.html, docs/api/types/client.PreferencesApi.html, docs/api/types/client.PreferencesResult.html, docs/api/types/client.ProviderState.html, docs/api/types/client.PublicFileUrl.html, docs/api/types/client.PublicUrlOptions.html, docs/api/types/client.QueryState.html, docs/api/types/client.SporadesError.html, docs/api/types/client.SporadesHooks.html, docs/api/types/client.SporadesResult.html, docs/api/types/client.Subscription.html, docs/api/types/client.UploadCompleteEvent.html, docs/api/types/client.UploadOptions.html, docs/api/types/client.UploadProgressEvent.html, docs/api/types/client.UseAuthState.html, docs/api/types/server.AclDatabaseHelpers.html, docs/api/types/server.AclHelpers.html, docs/api/types/server.AclStorageFileMetadata.html, docs/api/types/server.AclStorageHelpers.html, docs/api/types/server.AnyFieldDefinition.html, docs/api/types/server.AuthContext.html, docs/api/types/server.AutoFields.html, docs/api/types/server.Capsule.html, docs/api/types/server.CapsuleContext.html, docs/api/types/server.CapsuleDefinition.html, docs/api/types/server.CapsuleHooks.html, docs/api/types/server.ContextKind.html, docs/api/types/server.ContextMiddleware.html, docs/api/types/server.DatabaseFromSchema.html, docs/api/types/server.EndpointContext.html, docs/api/types/server.EndpointDefinition.html, docs/api/types/server.EndpointHandler.html, docs/api/types/server.EndpointOptions.html, docs/api/types/server.EndpointRequest.html, docs/api/types/server.FieldBuilder.html, docs/api/types/server.FieldDefinition.html, docs/api/types/server.FieldKind.html, docs/api/types/server.FieldValue.html, docs/api/types/server.InsertValues.html, docs/api/types/server.JsonValue.html, docs/api/types/server.Logger.html, docs/api/types/server.MaybePromise.html, docs/api/types/server.MessageApi.html, docs/api/types/server.MessageDefinition.html, docs/api/types/server.MessageHandler.html, docs/api/types/server.MessageScope.html, docs/api/types/server.MiddlewareContext.html, docs/api/types/server.MutationDefinition.html, docs/api/types/server.MutationHandler.html, docs/api/types/server.MutationHook.html, docs/api/types/server.MutationHookEvent.html, docs/api/types/server.MutationResult.html, docs/api/types/server.OrderDirection.html, docs/api/types/server.QueryDefinition.html, docs/api/types/server.QueryHandler.html, docs/api/types/server.ReferenceFieldBuilder.html, docs/api/types/server.ReferenceFieldDefinition.html, docs/api/types/server.RequireAuthOptions.html, docs/api/types/server.RowFromFields.html, docs/api/types/server.SchemaDefinition.html, docs/api/types/server.TableAclContext.html, docs/api/types/server.TableAclOperation.html, docs/api/types/server.TableAclRule.html, docs/api/types/server.TableAclRuleInput.html, docs/api/types/server.TableAclRules.html, docs/api/types/server.TableApi.html, docs/api/types/server.TableDefinition.html, docs/api/types/server.UpdateValues.html, docs/api/variables/client.auth.html, docs/api/variables/client.files.html, docs/api/variables/client.preferences.html.

### 📦 Packaging

- Update packaging and release flow (6a5cd20).
