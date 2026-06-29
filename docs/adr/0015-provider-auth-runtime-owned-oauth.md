# Runtime-Owned Provider Auth

Sporades v2 implements Google provider auth in the server runtime rather than adding a browser auth SDK or trusting client-supplied profile data. The browser client sends only sign-in intent through `auth.signIn("google")`; the server creates an opaque OAuth state, stores the current Sporades session token and return URL, generates the Google authorization URL, handles `/__sporades/auth/google/callback`, exchanges the authorization code, fetches Google profile data with the returned access token, and links that identity to the existing anonymous account.

This issue does not add a general auth dependency. The existing runtime already owns anonymous sessions in SQLite, and the v2 requirement is a narrow provider-linking flow with a small public surface. Keeping the implementation in Sporades-owned tables avoids exposing provider SDKs or Better Auth internals to app code while preserving a future path to replace the internals behind the same `auth.signIn(provider)` client API.

Provider secrets remain in Server env. `sporades.json` stores the env var names, not secret values. The runtime reads the configured client ID and client secret from Server env during code exchange.

Google OAuth can be configured either with explicit values:

```sh
sporades auth set google --client-id <id> --client-secret <secret>
```

or from a downloaded Google OAuth client JSON file:

```sh
sporades auth set google --client-json ./client_secret_google.json
```

The JSON parser is provider-specific: for Google it reads Web application
credentials from `web.client_id` and `web.client_secret`. Other providers can add
their own credential-file shape behind the same `--client-json` flag.

After `sporades auth set <provider>`, any running dev session must be restarted.
The dev session loads Server env and auth configuration at startup, so a restart
is required before redirect and code-exchange behavior reflects the new
credentials.
