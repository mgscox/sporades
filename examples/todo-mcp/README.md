# Capsule-owned Todo MCP pilot

This opt-in React example extends the default Todo scaffold. `/mcp` is a Custom
endpoint owned by this Capsule's Server Bundle. Its tools, JSON schemas, handlers,
permissions, normalization and retry receipts live in `server/`. No MCP dispatch
code is installed into Sporades. Guest browser browsing and adding remain enabled.
Existing scaffold Todo fields and stored rows remain compatible.

## Run from this checkout

The new `EndpointContext.hasAccessKeyScopes` seam must ship in Sporades before a
registry installation can run this example. The manifest pins `0.9.51` to make
candidate testing reproducible; registry `0.9.51` predates the seam. Until the
first compatible release, install a source-built candidate with that same version:

```sh
# At the repository root. These commands build and pack locally; nothing is published.
npm ci
npm run build
mkdir -p .tmp
npm pack --ignore-scripts --pack-destination .tmp
cd examples/todo-mcp
npm ci
npm install --no-save --package-lock=false ../../.tmp/sporades-0.9.51.tgz
npm run typecheck
SPORADES_CONFIG_DIR="$PWD/.sporades/cli-config" npm run dev
```

Open `http://localhost:5688`. After the seam is published, pin a compatible exact
Sporades version and regenerate the example lockfile once. Keep that package and
lockfile unchanged during tool-edit acceptance. The source-built candidate check
is separate from acceptance against an actually published compatible package.

Add a guest todo, enter an email and password, and choose **Link this list**.
Registration links the guest identity and preserves its todos. On later visits,
use **Sign in** to return to that same list. Key management appears only while
signed in. Start with **Read todos** checked and **Add todos** unchecked, give
the key a name, and choose **Issue key**. Copy the one-time bearer into your
MCP client's protected credential configuration, then hide it. Rotation replaces
the bearer while preserving the attribution ID and grants; revocation is final.
Neither operation is exposed as an MCP tool.

Select **Create Todo agent** for a named Service User with the name and grants
selected in the same form. Its list starts empty. It has no browser Session or
implicit human identity. The example records which human may disable the agent;
a different human cannot disable it. The normal `ctx.serviceUsers` APIs support
further Session-only key issuance, rotation and revocation under your Capsule's
management policy. Scope labels never grant ownership or bypass ACL.

## Connect a client

Use a modern MCP client supporting revision `2026-07-28` and a manually configured
`Authorization: Bearer <Access key>` header. OAuth-discovery-only clients need a
later integration. The official TypeScript client `@modelcontextprotocol/client`
`2.4.0` is exercised by `test/todo-mcp.test.js`:

```js
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const client = new Client({ name: "todo-agent", version: "1.0.0" }, {
  versionNegotiation: { mode: { pin: "2026-07-28" } },
});
await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:5688/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.TODO_ACCESS_KEY}` } },
}));
console.log(await client.listTools());
console.log(await client.callTool({ name: "list_my_todos" }));
await client.close();
```

A read-only key sees `list_my_todos`; an add-only key sees `add_todo`. Both grants
expose both tools. An admitted key with neither grant sees an empty list. Calling
a hidden tool returns the same `Tool unavailable` error as an unknown tool.
Discovery is private with zero cache lifetime. Every call checks scopes again.

`list_my_todos` takes empty arguments and returns up to 50 latest todos ordered
by creation time and then ID, both descending, plus `hasMore`. Its query reads
at most 102 rows, including the bounded timestamp-tie query. Stored historical
Todo text is preserved; an unusually large legacy result returns the bounded
`RESULT_TOO_LARGE` tool error instead of disclosing an unbounded response.

`add_todo` takes exactly `text` and a caller-generated UUID `requestId`. It trims
text and requires 1–500 Unicode code points. Keep the UUID stable when retrying a
lost response. A durable receipt unique on `(ownerId, requestId)` stores normalized
text and the original result atomically with the Todo. Matching retries return
that result after restart, even if the Todo later changes. Different normalized
text with that UUID returns `REQUEST_ID_CONFLICT`. UUID spelling is normalized
to lower case. Ownership always comes from `ctx.auth.userId`; extra argument
fields, including a forged owner ID, are rejected. Unexpected errors escape the
handler and roll back both writes. An MCP write refreshes subscribed browser
queries after the endpoint commits.

## HTTP behavior

The endpoint implements stateless JSON responses for `server/discover`,
`tools/list`, and `tools/call`. It requires protocol/client metadata, mirrored
`MCP-Protocol-Version`, `Mcp-Method`, and call-specific `Mcp-Name` headers, and
an Accept header containing JSON and event-stream media types. The official
client constructs these. There is no initialize handshake or protocol session.
Batches and notifications cannot execute tools; GET and DELETE return 405.

Originless configured clients are accepted. Supplied Origins must exactly match
the trusted `ctx.app.publicOrigin` or an entry in `security.cors.allowedOrigins`
in `sporades.json`. Add permitted alternate browser origins explicitly and
redeploy the Capsule; no wildcard Origin is accepted by this handler.

Sporades authenticates and bounds the body before Capsule MCP dispatch. Invalid,
dual, expired, rotated or revoked credentials, and disabled Service Users, retain
runtime HTTP rejects. Malformed JSON returns the ordinary runtime 400 envelope,
not a JSON-RPC envelope. Body-limit rejection retains runtime 413 behavior; a
client sending an oversized unread body can instead observe a connection reset.
Clients must treat these as transport failures, retain the add request UUID,
and reconcile with the same UUID on a later valid request. Admission captures a
snapshot: lifecycle changes affect the next request, not already-admitted work.
Responses are private/no-store. Runtime attribution identifies actor and key;
Capsule tool logs contain only registered tool name and outcome, never bearer,
Todo text, arguments or response bodies.

## Enable the operator bridge independently

The pilot works with no `mcp` stanza. To also enable operator inspection, add
`"mcp": { "enabled": true, "keyEnv": "OPERATOR_MCP_KEY" }` to `sporades.json` and
set an independently generated key of at least 32 characters with Sealed Server
env (`sporades env set OPERATOR_MCP_KEY --stdin` with your isolated CLI config).
Configure a separate client connection to `/__sporades/mcp` with that key.
The app Access key and operator key are rejected by each other's surface.
`/mcp` has no endpoint `mcp` option, so it is absent from operator discovery.
Existing operator logs, database inspection and explicitly exposed Custom
endpoints retain their behavior. Operator calls to those endpoints still omit
caller credentials and run as Anonymous.

## Edit and redeploy tools without changing Sporades

1. Record the installed Sporades version and hash of `package-lock.json`.
2. Edit only `server/tools.ts`: add a new registration using a declared scope,
   or change the existing list tool's name/schema/handler. Each registration
   includes a stable name, description, input/output JSON Schema, concrete scopes
   and handler. Startup rejects duplicate names, undeclared scopes and invalid
   schemas. `mcp.ts` compiles schemas once and validates both arguments and output.
3. Save during a Dev session, or run `npm run deploy` for your own local Container.
   Reconnect the client, inspect the catalogue and schema, then call the new tool.
4. Check that the Sporades version and lockfile hash are identical. Do not update
   Sporades, its MCP bridge, or any runtime registry to change this Capsule's tools.

The Node tests include real-client discovery/calls before and after changing
Capsule tool source while retaining identical runtime files and package lock.
They also cover ownership, retries/restart, rollback, Origin/protocol rejects,
key lifecycle, operator separation and live browser query refresh. A published
package acceptance run remains a release-stage check once the new seam is shipped.
