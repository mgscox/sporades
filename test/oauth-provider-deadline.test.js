import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import test from 'node:test';
const execFileAsync=promisify(execFile);

test("Microsoft response-body deadlines close a real stalled loopback response without leaking its partial body", async () => {
  const script = `
    import { createServer } from "node:http";
    import { fetchMicrosoftOidcJson as fetchJson } from "./dist/server-runtime-source.js";
    let closedResolve;
    const closed = new Promise((resolve) => { closedResolve = resolve; });
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"upstreamSecret":"partial');
    });
    server.on("connection", socket => socket.once("close", closedResolve));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const startedAt = Date.now();
    let result;
    try {
      const address = server.address();
      await fetchJson(
        { __microsoftOidcTimeoutMs: 40 },
        "http://127.0.0.1:" + address.port + "/stalled",
        {},
        {
          maxBytes: 65536,
          unavailableCode: "OAUTH_TEST_UNAVAILABLE",
          unavailableMessage: "OIDC test response was unavailable.",
          unavailableHint: "Retry the test request.",
          invalidCode: "OAUTH_TEST_INVALID",
          invalidMessage: "OIDC test response was invalid.",
          invalidHint: "Retry the test request.",
        },
      );
      result = { unexpectedSuccess: true };
    } catch (error) {
      const deadlineElapsedMs = Date.now() - startedAt;
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]);
      result = {
        code: error.code,
        deadlineElapsedMs,
        cleanupElapsedMs: Date.now() - startedAt,
        leaked: /upstreamSecret|partial/i.test(String(error.message) + " " + String(error.hint)),
        connections: server._connections,
      };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    process.stdout.write(JSON.stringify(result));
  `;
  const { stdout, stderr } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    timeout: 2_000,
  });
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.code, "OAUTH_TEST_UNAVAILABLE");
  assert.equal(result.leaked, false);
  assert.ok(result.deadlineElapsedMs < 500, "stalled body should be bounded by the configured deadline");
  assert.ok(result.cleanupElapsedMs < 1_000, "stalled connection cleanup should remain bounded");
  assert.equal(result.connections, 0, "aborting the reader should close the stalled loopback connection");
});
