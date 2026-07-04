import { createServer } from "node:http";

import { createSqliteDatabaseAdapter } from "../../src/server-runtime-source.js";

const databasePath = process.argv[2];

if (!databasePath) {
  process.exit(0);
}

const adapter = await createSqliteDatabaseAdapter(databasePath);

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/query") {
    response.writeHead(404).end();
    return;
  }

  try {
    const body = await readJson(request);
    const data = runAdapterRequest(body);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, data: normalize(data) }));
  } catch (error) {
    response
      .writeHead(500, { "content-type": "application/json" })
      .end(JSON.stringify({ ok: false, error: { message: error.message, stack: error.stack } }));
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});

process.on("SIGTERM", () => {
  server.close(() => {
    adapter.close();
    process.exit(0);
  });
});

function runAdapterRequest(body) {
  if (body.operation === "exec") {
    adapter.exec(body.sql);
    return null;
  }

  const statement = adapter.prepare(body.sql);
  const params = Array.isArray(body.params) ? body.params : [];
  if (body.operation === "all") {
    return statement.all(...params);
  }
  if (body.operation === "get") {
    return statement.get(...params) ?? null;
  }
  if (body.operation === "run") {
    return statement.run(...params);
  }
  if (body.operation === "columns") {
    return statement.columns();
  }
  throw new Error(`Unsupported adapter service operation: ${body.operation ?? ""}`.trim());
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
  }
  return JSON.parse(raw || "{}");
}

function normalize(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => (typeof nested === "bigint" ? Number(nested) : nested)),
  );
}
