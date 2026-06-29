import assert from "node:assert/strict";
import { test } from "node:test";

import { createClientRuntimeSource } from "../src/templates/client-runtime-template.js";

async function importClientRuntime() {
  const source = createClientRuntimeSource();
  const encoded = Buffer.from(source).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${Date.now()}-${Math.random()}`);
}

function installBrowserFakes(auth, handlers = {}) {
  const storage = new Map();
  const sockets = [];
  globalThis.localStorage = {
    getItem(key) {
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
  };
  globalThis.window = {
    location: {
      href: "http://localhost:4000/",
    },
  };
  globalThis.WebSocket = class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    readyState = FakeWebSocket.CONNECTING;
    listeners = new Map();

    constructor(url) {
      this.url = url;
      sockets.push(this);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    send(rawMessage) {
      const message = JSON.parse(rawMessage);
      if (message.type === "auth.get") {
        queueMicrotask(() => {
          this.emit("message", {
            data: JSON.stringify({
              id: message.id,
              type: "auth.result",
              data: {
                sessionToken: "session-token",
                auth,
                providers: {},
              },
              error: null,
            }),
          });
        });
        return;
      }

      const handler = handlers[message.type];
      if (!handler) {
        return;
      }
      queueMicrotask(async () => {
        let response;
        try {
          response = await handler(message);
        } catch (error) {
          response = {
            type: "error",
            error: {
              message: error.message,
              hint: "The fake browser handler failed.",
            },
          };
        }
        this.emit("message", {
          data: JSON.stringify({ id: message.id, ...response }),
        });
      });
    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }
  };

  return {
    storage,
    openSockets() {
      for (const socket of sockets) {
        socket.readyState = globalThis.WebSocket.OPEN;
        socket.emit("open", {});
      }
    },
    cleanup() {
      delete globalThis.localStorage;
      delete globalThis.window;
      delete globalThis.WebSocket;
    },
  };
}

test("client isAuthenticated returns false for anonymous auth", async () => {
  const browser = installBrowserFakes({
    userId: "anonymous-user",
    displayName: "Anonymous",
    email: null,
    picture: null,
    isAuthenticated: false,
    isGuest: true,
    provider: "anonymous",
  });
  try {
    const runtime = await importClientRuntime();
    const authPromise = runtime.isAuthenticated();
    browser.openSockets();
    assert.equal(await authPromise, false);
    assert.equal(browser.storage.get("sporades.sessionToken"), "session-token");
  } finally {
    browser.cleanup();
  }
});

test("client isAuthenticated returns true for linked auth", async () => {
  const browser = installBrowserFakes({
    userId: "linked-user",
    displayName: "Mira",
    email: "mira@example.com",
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "google",
  });
  try {
    const runtime = await importClientRuntime();
    const authPromise = runtime.isAuthenticated();
    browser.openSockets();
    assert.equal(await authPromise, true);
  } finally {
    browser.cleanup();
  }
});

test("client files.upload negotiates an upload URL and transfers one file", async () => {
  const browser = installBrowserFakes(
    {
      userId: "anonymous-user",
      displayName: "Anonymous",
      email: null,
      picture: null,
      isAuthenticated: false,
      isGuest: true,
      provider: "anonymous",
    },
    {
      "file.uploadUrl": async () => ({
        type: "file.uploadUrl.result",
        data: {
          uploadUrl: "/__sporades/uploads/file-1",
          method: "PUT",
          headers: {},
          file: {
            id: "file-1",
            bucket: "default",
            size: 11,
            type: "text/plain",
            name: "hello.txt",
            path: "/__sporades/files/private/file-1?v=version-1",
            version: "version-1",
          },
        },
        error: null,
      }),
    },
  );
  const uploads = [];
  globalThis.fetch = async (url, options = {}) => {
    uploads.push({ url, method: options.method, body: await options.body.text() });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          data: {
            file: {
              id: "file-1",
              bucket: "default",
              size: 11,
              type: "text/plain",
              name: "hello.txt",
              path: "/__sporades/files/private/file-1?v=version-1",
              version: "version-1",
            },
          },
          error: null,
        };
      },
    };
  };

  try {
    const runtime = await importClientRuntime();
    const events = [];
    const file = new Blob(["hello world"], { type: "text/plain" });
    file.name = "hello.txt";

    const uploadPromise = runtime.files.upload(file, {
      onProgress: (event) => events.push(event),
      onComplete: (event) => events.push(event),
    });
    browser.openSockets();
    const metadata = await uploadPromise;

    assert.deepEqual(uploads, [
      {
        url: "/__sporades/uploads/file-1",
        method: "PUT",
        body: "hello world",
      },
    ]);
    assert.equal(metadata.id, "file-1");
    assert.equal(metadata.bucket, "default");
    assert.equal(metadata.size, 11);
    assert.equal(metadata.type, "text/plain");
    assert.equal(metadata.name, "hello.txt");
    assert.equal(metadata.version, "version-1");
    assert.equal(metadata.path, "/__sporades/files/private/file-1?v=version-1");
    assert.deepEqual(events.map((event) => event.type), ["progress", "complete"]);
  } finally {
    delete globalThis.fetch;
    browser.cleanup();
  }
});

test("client files.upload uploads arrays sequentially through the single-file path", async () => {
  const negotiatedNames = [];
  const uploadedBodies = [];
  const browser = installBrowserFakes(
    {
      userId: "anonymous-user",
      displayName: "Anonymous",
      email: null,
      picture: null,
      isAuthenticated: false,
      isGuest: true,
      provider: "anonymous",
    },
    {
      "file.uploadUrl": async (message) => {
        negotiatedNames.push(message.file.name);
        const index = negotiatedNames.length;
        return {
          type: "file.uploadUrl.result",
          data: {
            uploadUrl: `/__sporades/uploads/file-${index}`,
            method: "PUT",
            headers: {},
            file: {
              id: `file-${index}`,
              bucket: "default",
              size: message.file.size,
              type: "text/plain",
              name: message.file.name,
              path: `/__sporades/files/private/file-${index}?v=version-${index}`,
              version: `version-${index}`,
            },
          },
          error: null,
        };
      },
    },
  );
  globalThis.fetch = async (_url, options = {}) => {
    uploadedBodies.push(await options.body.text());
    return {
      ok: true,
      status: 200,
      async json() {
        const index = uploadedBodies.length;
        return {
          ok: true,
          data: {
            file: {
              id: `file-${index}`,
              bucket: "default",
              size: uploadedBodies[index - 1].length,
              type: "text/plain",
              name: negotiatedNames[index - 1],
              path: `/__sporades/files/private/file-${index}?v=version-${index}`,
              version: `version-${index}`,
            },
          },
          error: null,
        };
      },
    };
  };

  try {
    const runtime = await importClientRuntime();
    const first = new Blob(["one"], { type: "text/plain" });
    first.name = "one.txt";
    const second = new Blob(["two"], { type: "text/plain" });
    second.name = "two.txt";

    const uploadPromise = runtime.files.upload([first, second]);
    browser.openSockets();
    const results = await uploadPromise;

    assert.deepEqual(negotiatedNames, ["one.txt", "two.txt"]);
    assert.deepEqual(uploadedBodies, ["one", "two"]);
    assert.deepEqual(results.map((file) => file.id), ["file-1", "file-2"]);
  } finally {
    delete globalThis.fetch;
    browser.cleanup();
  }
});
