# Realtime Features

Sporades has two deliberately different realtime tools:

- [App messages](./reference.md#app-messages) carry application-defined events over the client transport.
- [User Journey Tracker](./reference.md#user-journey-tracker) publishes explicitly consented, transient current activity.

Journey state is not analytics, an audit log, durable preferences, or an
authoritative server input. Choose it only when the question is “what are
consenting users doing now?”

For App messages, declare a server `message()` handler and subscribe through
the client SDK. For Journey state, first enable the Capsule declaration, then
obtain page-runtime consent with `journey.enable()`. Publish semantic state with
`journey.set()`, and call `journey.disable()` when consent ends. Never put form
values, query strings, or sensitive DOM content into Journey metadata.
