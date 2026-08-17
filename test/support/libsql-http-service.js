import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { createSqliteDatabaseAdapter } from "../../dist/server-runtime-source.js";

const isolatedServiceScript = fileURLToPath(new URL("./libsql-http-service-process.js", import.meta.url));

export async function withFakeLibsqlService(databasePath, optionsOrFn, maybeFn) {
  const options = typeof optionsOrFn === "function" ? {} : optionsOrFn ?? {};
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
  if (options.isolateProcess) {
    return await withIsolatedFakeLibsqlService(databasePath, fn);
  }
  const adapter = await createSqliteDatabaseAdapter(databasePath);
  const requests = [];
  const sessions = new Map();
  let nextBaton = 1;
  const transactionQueue = { tail: Promise.resolve() };

  const server = createServer(async (request, response) => {
    if (request.method === "GET" && (request.url === "/health" || request.url === "/v2")) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v2/pipeline") {
      response.writeHead(404).end();
      return;
    }

    try {
      const body = await readJson(request);
      requests.push(body);
      const result = await runPipeline(adapter, sessions, nextBaton, body, options, transactionQueue);
      nextBaton = result.nextBaton;
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ baton: result.baton, base_url: null, results: result.results }));
    } catch (error) {
      response
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: error.message } }));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn({
      url: `http://127.0.0.1:${port}`,
      requests,
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    adapter.close();
  }
}

async function withIsolatedFakeLibsqlService(databasePath, fn) {
  const service = spawn(process.execPath, [isolatedServiceScript, databasePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  service.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const lines = createInterface({ input: service.stdout });
  const [firstLine] = await Promise.race([
    once(lines, "line"),
    once(service, "exit").then(([code]) => {
      throw new Error(`Isolated libSQL service exited before startup with code ${code}: ${stderr.join("")}`);
    }),
  ]);
  const { url } = JSON.parse(firstLine);
  try {
    return await fn({ url, requests: [] });
  } finally {
    lines.close();
    if (service.exitCode === null) {
      const exited = once(service, "exit");
      service.kill("SIGTERM");
      await exited;
    }
  }
}

async function runPipeline(adapter, sessions, nextBaton, body, options, transactionQueue) {
  let baton = body.baton ?? null;
  if (baton && !sessions.has(baton)) {
    throw new Error("Unknown baton.");
  }
  if (!baton) {
    baton = `baton-${nextBaton}`;
    nextBaton += 1;
    sessions.set(baton, { releaseTransaction: null });
  }
  const session = sessions.get(baton);

  const results = [];
  let closed = false;
  for (const streamRequest of body.requests ?? []) {
    if (streamRequest.type === "close") {
      session.releaseTransaction?.();
      session.releaseTransaction = null;
      sessions.delete(baton);
      closed = true;
      results.push({ type: "ok", response: { type: "close" } });
      continue;
    }
    if (streamRequest.type === "execute") {
      const statementSql = streamRequest.stmt?.sql ?? "";
      const beginsTransaction = /^\s*BEGIN\b/i.test(statementSql);
      const endsTransaction = /^\s*(?:COMMIT|ROLLBACK)\b/i.test(statementSql);
      if (beginsTransaction) {
        const previous = transactionQueue.tail;
        transactionQueue.tail = new Promise((resolve) => { session.releaseTransaction = resolve; });
        await previous;
      }
      try {
        results.push({ type: "ok", response: { type: "execute", result: await executeStatement(adapter, streamRequest.stmt, options) } });
      } catch (error) {
        if (beginsTransaction || endsTransaction) {
          session.releaseTransaction?.();
          session.releaseTransaction = null;
        }
        throw error;
      }
      if (endsTransaction) {
        session.releaseTransaction?.();
        session.releaseTransaction = null;
      }
      continue;
    }
    if (streamRequest.type === "describe") {
      const columns = adapter.prepare(streamRequest.sql ?? streamRequest.stmt?.sql).columns();
      results.push({
        type: "ok",
        response: {
          type: "describe",
          result: {
            cols: columns.map((column) => ({ name: column.name })),
            params: [],
            is_explain: false,
            is_readonly: true,
          },
        },
      });
      continue;
    }
    if (streamRequest.type === "sequence") {
      await options.beforeStatement?.(streamRequest.sql ?? "");
      adapter.exec(streamRequest.sql ?? "");
      results.push({ type: "ok", response: { type: "sequence" } });
      continue;
    }
    throw new Error(`Unsupported libSQL test request: ${streamRequest.type}`);
  }

  return {
    baton: closed ? null : baton,
    nextBaton,
    results,
  };
}

async function executeStatement(adapter, stmt, options) {
  const sql = stmt?.sql ?? "";
  const args = (stmt?.args ?? []).map(decodeValue);
  await options.beforeStatement?.(sql, args);
  if (/^\s*(?:select|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
    const statement = adapter.prepare(sql);
    const rows = statement.all(...args);
    const columns = statement.columns();
    return {
      cols: columns.map((column) => ({ name: column.name })),
      rows: rows.map((row) => columns.map((column) => encodeValue(row[column.name]))),
      affected_row_count: rows.length,
      last_insert_rowid: null,
    };
  }

  const result = adapter.prepare(sql).run(...args);
  return {
    cols: [],
    rows: [],
    affected_row_count: result.changes ?? 0,
    last_insert_rowid: result.lastInsertRowid === undefined ? null : String(result.lastInsertRowid),
  };
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
  }
  return JSON.parse(raw || "{}");
}

function encodeValue(value) {
  if (value === null || value === undefined) {
    return { type: "null" };
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return { type: "integer", value: String(value) };
  }
  if (typeof value === "number") {
    return { type: "float", value };
  }
  if (Buffer.isBuffer(value)) {
    return { type: "blob", base64: value.toString("base64") };
  }
  return { type: "text", value: String(value) };
}

function decodeValue(value) {
  if (!value || value.type === "null") {
    return null;
  }
  if (value.type === "integer") {
    return Number(value.value);
  }
  if (value.type === "float") {
    return Number(value.value);
  }
  if (value.type === "blob") {
    return Buffer.from(value.base64 ?? "", "base64");
  }
  return value.value ?? "";
}
