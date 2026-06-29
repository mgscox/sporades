import assert from "node:assert/strict";
import { test } from "node:test";

import { createClientRuntimeSource } from "../src/templates/client-runtime-template.js";

async function importClientRuntime() {
  const source = createClientRuntimeSource();
  const encoded = Buffer.from(source).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${Date.now()}-${Math.random()}`);
}

function installBrowserFakes(auth) {
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
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.emit("open", {});
      });
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    send(rawMessage) {
      const message = JSON.parse(rawMessage);
      if (message.type !== "auth.get") {
        if (message.type === "app.send") {
          queueMicrotask(() => {
            this.emit("message", {
              data: JSON.stringify({
                id: message.id,
                type: "app.result",
                message: message.message,
                data: { accepted: message.data },
                error: null,
              }),
            });
          });
        }
        return;
      }
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
    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }
  };

  return {
    storage,
    sockets,
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
    assert.equal(await runtime.isAuthenticated(), false);
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
    assert.equal(await runtime.isAuthenticated(), true);
  } finally {
    browser.cleanup();
  }
});

test("client sendMessage sends unprefixed app messages over the transport", async () => {
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
    const result = await runtime.sendMessage("typing", { roomId: "general" });

    assert.equal(typeof result.id, "number");
    assert.deepEqual(
      {
        ...result,
        id: "request-id",
      },
      {
        id: "request-id",
        type: "app.result",
        message: "typing",
        data: { accepted: { roomId: "general" } },
        error: null,
      },
    );
  } finally {
    browser.cleanup();
  }
});

test("client onMessage exposes filterable app message subscriptions", async () => {
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
    const received = [];
    const subscription = runtime
      .onMessage()
      .filter((message) => message.type === "typing")
      .subscribe((message) => received.push(message));

    await new Promise((resolve) => setTimeout(resolve, 0));
    browser.sockets[0].emit("message", {
      data: JSON.stringify({
        type: "app.message",
        message: "typing",
        data: { roomId: "general" },
      }),
    });
    browser.sockets[0].emit("message", {
      data: JSON.stringify({
        type: "app.message",
        message: "ignored",
        data: { roomId: "general" },
      }),
    });

    assert.deepEqual(received, [{ type: "typing", data: { roomId: "general" } }]);
    subscription.unsubscribe();
  } finally {
    browser.cleanup();
  }
});
