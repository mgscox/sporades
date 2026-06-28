# No endpoints in v0 — queries and mutations only

v0 does not include `endpoint({ method, path }, handler)`. The server exposes queries, mutations, and auth over WebSocket only. In Lakebed, endpoints existed partly to receive Google OAuth callbacks — but Sporades handles auth server-side via Better Auth, so that use case doesn't exist. Webhooks and other HTTP-based integrations are a v1 concern.