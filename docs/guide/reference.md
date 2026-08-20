# Sporades Feature Reference

This is the compatibility index for Sporades feature and command reference
material. The exhaustive reference is split by lookup intent so each page stays
searchable and navigable. For a task-led path, start with the
[user guide](../user-guide.md); for individual SDK signatures, use the
[generated API reference](https://mgscox.github.io/sporades/api/).

This reference assumes `sporades` is installed globally. The normal loop is:

```sh
sporades create my-capsule --template todo
cd my-capsule
sporades dev
```

Edit `server/`, `client/`, and `shared/`; Sporades rebuilds the same Bundle used
by Dev, local Container, and Hosted Capsule execution.

## About This Reference {#about-this-reference}

Existing links to sections of this former monolithic page remain valid: each
legacy anchor below now points to the section's topic-owned reference page.

## Projects and Configuration

Capsule creation, project layout, configuration, security policy, database services, and Dev sessions.

### [Create a Capsule](../reference/projects-and-configuration.md#create-a-capsule) {#create-a-capsule}
### [How Sporades Projects Fit Together](../reference/projects-and-configuration.md#how-sporades-projects-fit-together) {#how-sporades-projects-fit-together}
#### [Project Files](../reference/projects-and-configuration.md#project-files) {#project-files}
#### [Configuration](../reference/projects-and-configuration.md#configuration) {#configuration}
##### [Use Postgres locally](../reference/projects-and-configuration.md#use-postgres-locally) {#use-postgres-locally}
#### [Security Policy](../reference/projects-and-configuration.md#security-policy) {#security-policy}
### [Start a Dev Session](../reference/projects-and-configuration.md#start-a-dev-session) {#start-a-dev-session}

## Server Runtime

Tables, queries, mutations, authorization, Server env, mail, middleware, actors, and Custom endpoints.

### [Building the Server Side](../reference/server-runtime.md#building-the-server-side) {#building-the-server-side}
#### [Define Tables](../reference/server-runtime.md#define-tables) {#define-tables}
#### [Read With Queries](../reference/server-runtime.md#read-with-queries) {#read-with-queries}
#### [Change Data With Mutations](../reference/server-runtime.md#change-data-with-mutations) {#change-data-with-mutations}
#### [Gate Handlers With requireAuth](../reference/server-runtime.md#gate-handlers-with-requireauth) {#gate-handlers-with-requireauth}
#### [Manage Access keys](../reference/server-runtime.md#manage-access-keys) {#manage-access-keys}
#### [Use Sealed Server Env](../reference/server-runtime.md#use-sealed-server-env) {#use-sealed-server-env}
##### [Create and Import Values](../reference/server-runtime.md#create-and-import-values) {#create-and-import-values}
##### [Read Values in Server Code](../reference/server-runtime.md#read-values-in-server-code) {#read-values-in-server-code}
##### [Export or Import an Envelope](../reference/server-runtime.md#export-or-import-an-envelope) {#export-or-import-an-envelope}
##### [Push to a Hosted Capsule](../reference/server-runtime.md#push-to-a-hosted-capsule) {#push-to-a-hosted-capsule}
##### [Recover from Lost Keys](../reference/server-runtime.md#recover-from-lost-keys) {#recover-from-lost-keys}
#### [Send SMTP mail](../reference/server-runtime.md#send-smtp-mail) {#send-smtp-mail}
#### [Add Middleware](../reference/server-runtime.md#add-middleware) {#add-middleware}
#### [Choosing a server actor](../reference/server-runtime.md#choosing-a-server-actor) {#choosing-a-server-actor}
### [Custom HTTP Endpoints](../reference/server-runtime.md#custom-http-endpoints) {#custom-http-endpoints}

## Built-in Teams

Runtime-owned Teams, membership application roles, email-bound Join links, and explicit Team ACL decisions.

### [Team model and compatibility](../reference/teams.md#team-model-and-compatibility) {#team-model-and-compatibility}
### [Manage Teams from a Capsule](../reference/teams.md#manage-teams-from-a-capsule) {#manage-teams-from-a-capsule}
### [Email-bound Join links](../reference/teams.md#email-bound-join-links) {#email-bound-join-links}
### [Authorize explicit Team resources](../reference/teams.md#authorize-explicit-team-resources) {#authorize-explicit-team-resources}
### [Security, storage, and audit boundaries](../reference/teams.md#security-storage-and-audit-boundaries) {#security-storage-and-audit-boundaries}

## Jobs and Schedules

Durable background work, Schedule declarations, runtime behavior, and CLI inspection.

### [Current-user Jobs](../reference/jobs-and-schedules.md#current-user-jobs) {#current-user-jobs}
### [Inspect Jobs from the CLI](../reference/jobs-and-schedules.md#inspect-jobs-from-the-cli) {#inspect-jobs-from-the-cli}
### [Inspect Schedules from the CLI](../reference/jobs-and-schedules.md#inspect-schedules-from-the-cli) {#inspect-schedules-from-the-cli}

## Client, Authentication, and Preferences

Subscribed client state, authentication workflows, provider configuration, and current-user preferences.

### [Building the Client Side](../reference/client-auth-and-preferences.md#building-the-client-side) {#building-the-client-side}
#### [Use Queries](../reference/client-auth-and-preferences.md#use-queries) {#use-queries}
#### [Use Mutations](../reference/client-auth-and-preferences.md#use-mutations) {#use-mutations}
#### [Use Auth State](../reference/client-auth-and-preferences.md#use-auth-state) {#use-auth-state}
### [Auth Workflows](../reference/client-auth-and-preferences.md#auth-workflows) {#auth-workflows}
#### [Check Auth Configuration](../reference/client-auth-and-preferences.md#check-auth-configuration) {#check-auth-configuration}
#### [Configure OAuth Providers](../reference/client-auth-and-preferences.md#configure-oauth-providers) {#configure-oauth-providers}
#### [Configure Sign in with Apple](../reference/client-auth-and-preferences.md#configure-sign-in-with-apple) {#configure-sign-in-with-apple}
#### [Configure Google OAuth](../reference/client-auth-and-preferences.md#configure-google-oauth) {#configure-google-oauth}
##### [Importing the OAuth client into Sporades](../reference/client-auth-and-preferences.md#importing-the-oauth-client-into-sporades) {#importing-the-oauth-client-into-sporades}
#### [Configure Facebook Login](../reference/client-auth-and-preferences.md#configure-facebook-login) {#configure-facebook-login}
#### [Configure Microsoft sign-in](../reference/client-auth-and-preferences.md#configure-microsoft-sign-in) {#configure-microsoft-sign-in}
##### [Using OAuth sign-in in the client](../reference/client-auth-and-preferences.md#using-oauth-sign-in-in-the-client) {#using-oauth-sign-in-in-the-client}
#### [Use Email Auth](../reference/client-auth-and-preferences.md#use-email-auth) {#use-email-auth}
#### [Reset or Change an Email Password](../reference/client-auth-and-preferences.md#reset-or-change-an-email-password) {#reset-or-change-an-email-password}
#### [Simulate Local Identities](../reference/client-auth-and-preferences.md#simulate-local-identities) {#simulate-local-identities}
### [Access-key management](../reference/client-auth-and-preferences.md#access-key-management) {#access-key-management}
### [User Preferences](../reference/client-auth-and-preferences.md#user-preferences) {#user-preferences}

## Files and Realtime

File uploads and publication, App messages, and consented transient User Journey state.

### [File Uploads](../reference/files-and-realtime.md#file-uploads) {#file-uploads}
### [App Messages](../reference/files-and-realtime.md#app-messages) {#app-messages}
### [User Journey Tracker](../reference/files-and-realtime.md#user-journey-tracker) {#user-journey-tracker}

## Operations and Hosting

Logs, database inspection, Container sessions, Hosted Capsules, Doctor, workflows, and troubleshooting.

### [Inspect Logs and Data](../reference/operations-and-hosting.md#inspect-logs-and-data) {#inspect-logs-and-data}
### [Inspecting and Debugging](../reference/operations-and-hosting.md#inspecting-and-debugging) {#inspecting-and-debugging}
#### [Logs](../reference/operations-and-hosting.md#logs) {#logs}
#### [Fatal Runtime Restart Policy](../reference/operations-and-hosting.md#fatal-runtime-restart-policy) {#fatal-runtime-restart-policy}
#### [Database](../reference/operations-and-hosting.md#database) {#database}
#### [JSON Output](../reference/operations-and-hosting.md#json-output) {#json-output}
#### [Inspect and retire Access keys](../reference/operations-and-hosting.md#inspect-and-retire-access-keys) {#inspect-and-retire-access-keys}
### [Try a Container Session](../reference/operations-and-hosting.md#try-a-container-session) {#try-a-container-session}
### [Local Container Sessions](../reference/operations-and-hosting.md#local-container-sessions) {#local-container-sessions}
### [Container SSH Access](../reference/operations-and-hosting.md#container-ssh-access) {#container-ssh-access}
### [Hosted Capsules](../reference/operations-and-hosting.md#hosted-capsules) {#hosted-capsules}
### [Common Workflows](../reference/operations-and-hosting.md#common-workflows) {#common-workflows}
#### [Add a New Feature](../reference/operations-and-hosting.md#add-a-new-feature) {#add-a-new-feature}
#### [Add Per-User Data](../reference/operations-and-hosting.md#add-per-user-data) {#add-per-user-data}
#### [Add a Server Secret](../reference/operations-and-hosting.md#add-a-server-secret) {#add-a-server-secret}
#### [Reset Local Runtime State](../reference/operations-and-hosting.md#reset-local-runtime-state) {#reset-local-runtime-state}
### [Sporades Doctor](../reference/operations-and-hosting.md#sporades-doctor) {#sporades-doctor}
### [Troubleshooting](../reference/operations-and-hosting.md#troubleshooting) {#troubleshooting}
