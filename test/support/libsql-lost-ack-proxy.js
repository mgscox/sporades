import assert from "node:assert/strict";
import { createServer } from "node:http";

// Put HTTP acknowledgement loss between the client and the isolated storage process.
// Dropping only after a successful upstream response proves the write executed, without
// allowing the fixture's SQLite adapter to populate the client's dirty-table window.
export async function createLibsqlLostAckProxy(storageUrl) {
  const upstreamUrl = new URL(storageUrl);
  assert.equal(upstreamUrl.protocol, "http:");
  assert.equal(upstreamUrl.hostname, "127.0.0.1");
  let nextLostStatement;
  let delayedStatement;
  let lostAcknowledgements = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const pipeline = body.length ? JSON.parse(body.toString("utf8")) : null;
      if (delayedStatement && pipeline?.requests?.some((entry) =>
        entry.type === "execute" && entry.stmt?.sql === delayedStatement.sql,
      )) {
        const delayed = delayedStatement;
        delayedStatement = undefined;
        delayed.entered.resolve();
        await delayed.release.promise;
      }
      const upstream = await fetch(new URL(request.url, upstreamUrl), {
        method: request.method,
        headers: { "content-type": "application/json" },
        ...(body.length ? { body } : {}),
      });
      const payload = await upstream.text();
      if (upstream.ok && nextLostStatement && pipeline?.requests?.some((entry) =>
        entry.type === "execute" && entry.stmt?.sql === nextLostStatement,
      )) {
        nextLostStatement = undefined;
        lostAcknowledgements++;
        response.destroy();
        return;
      }
      response.writeHead(upstream.status, { "content-type": "application/json" }).end(payload);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    loseNextAcknowledgement(sql) {
      assert.equal(nextLostStatement, undefined, "only one response may be armed for loss");
      nextLostStatement = sql;
    },
    get lostAcknowledgements() { return lostAcknowledgements; },
    delayNextStatement(sql) {
      assert.equal(delayedStatement, undefined, "only one statement may be delayed");
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      delayedStatement = { sql, entered, release };
      return { entered: entered.promise, release: release.resolve };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
