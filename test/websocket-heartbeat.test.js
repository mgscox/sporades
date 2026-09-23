import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { createWebSocketHub } from "../dist/server-runtime-source.js";

// Raw TCP peer so the test controls whether pings are answered, which a
// browser WebSocket does automatically and invisibly.
async function withHeartbeatHub(fn, { answerPings = false } = {}) {
  const hub = createWebSocketHub(() => ({ securityPolicy: null }), null, { heartbeatMs: 40 });
  const server = createServer();
  server.on("upgrade", (request, socket) => hub.accept(request, socket));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const socket = connect(port, "127.0.0.1");
  const frames = [];
  let closed = false;
  let handshake = Buffer.alloc(0);
  let upgraded = false;
  function sendMasked(opcode, payload = Buffer.alloc(0)) {
    const mask = Buffer.from([1, 2, 3, 4]);
    const body = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    socket.write(Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | body.length]), mask, body]));
  }
  socket.on("close", () => { closed = true; });
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    if (!upgraded) {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf("\r\n\r\n");
      if (end === -1) return;
      assert.match(handshake.subarray(0, end).toString(), /^HTTP\/1\.1 101/);
      upgraded = true;
      chunk = handshake.subarray(end + 4);
    }
    for (let offset = 0; offset + 1 < chunk.length;) {
      const length = chunk[offset + 1] & 0x7f;
      const frame = { opcode: chunk[offset] & 0x0f, payload: chunk.subarray(offset + 2, offset + 2 + length) };
      frames.push(frame);
      if (answerPings && frame.opcode === 9) sendMasked(10, frame.payload);
      offset += 2 + length;
    }
  });
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write([
    `GET /__sporades/ws?connectionToken=${hub.createConnectionToken()} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n"));
  try {
    await fn({ frames, sendMasked, isClosed: () => closed });
  } finally {
    socket.destroy();
    hub.disconnectAll();
    await new Promise((resolve) => server.close(resolve));
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("idle WebSockets receive pings so proxy idle timeouts do not close them", async () => {
  await withHeartbeatHub(async ({ frames, isClosed }) => {
    await wait(300);
    assert.ok(frames.filter((frame) => frame.opcode === 9).length >= 3, "the hub keeps pinging an idle peer");
    assert.equal(isClosed(), false, "a peer answering pings stays connected well past twice the heartbeat");
  }, { answerPings: true });
});

test("a peer that stops answering pings is disconnected", async () => {
  await withHeartbeatHub(async ({ frames, isClosed }) => {
    await wait(200);
    assert.ok(frames.some((frame) => frame.opcode === 9), "the hub pings idle peers");
    assert.equal(isClosed(), true, "a silent peer is dropped after two missed heartbeats");
  });
});

test("client pings are answered with a pong echoing the payload", async () => {
  await withHeartbeatHub(async ({ frames, sendMasked }) => {
    await wait(10);
    sendMasked(9, Buffer.from("hi"));
    await wait(20);
    const pong = frames.find((frame) => frame.opcode === 10);
    assert.equal(pong?.payload.toString(), "hi");
  });
});
