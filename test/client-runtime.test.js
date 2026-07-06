import assert from "node:assert/strict";
import { test } from "node:test";

import { createClientRuntimeSource } from "../dist/templates/client-runtime-template.js";

async function importClientRuntime() {
  const source = createClientRuntimeSource();
  const encoded = Buffer.from(source).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${Date.now()}-${Math.random()}`);
}

function installBrowserFakes(auth, options = {}) {
  const storage = new Map();
  const sockets = [];
  const handlers = options.handlers ?? {};

  globalThis.localStorage = {
    getItem(key) {
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
  };
  globalThis.window = {
    location: {
      href: options.href ?? "http://localhost:4000/",
      assign(url) {
        storage.set("assignedLocation", url);
      },
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
      if (options.autoOpen !== false) {
        queueMicrotask(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.emit("open", {});
        });
      }
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    send(rawMessage) {
      const message = JSON.parse(rawMessage);
      const handler = handlers[message.type];
      if (handler) {
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
        return;
      }

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

      if (message.type === "auth.signIn") {
        storage.set("signInMessage", JSON.stringify(message));
        queueMicrotask(() => {
          this.emit("message", {
            data: JSON.stringify({
              id: message.id,
              type: "auth.redirect",
              data: { url: "https://accounts.google.com/o/oauth2/v2/auth?state=opaque-state" },
              error: null,
            }),
          });
        });
        return;
      }

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
        return;
      }

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

const anonymousAuth = {
  userId: "anonymous-user",
  displayName: "Anonymous",
  email: null,
  picture: null,
  isAuthenticated: false,
  isGuest: true,
  provider: "anonymous",
};

test("client isAuthenticated returns false for anonymous auth", async () => {
  const browser = installBrowserFakes(anonymousAuth);
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
  const browser = installBrowserFakes(anonymousAuth);
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

test("client preferences SDK reads and updates current-user preferences over the transport", async () => {
  let storedPreferences = {};
  const browser = installBrowserFakes(anonymousAuth, {
    handlers: {
      "preferences.get": async (message) => {
        browser.storage.set("preferencesGetMessage", JSON.stringify(message));
        return {
          type: "preferences.result",
          data: { preferences: storedPreferences },
          error: null,
        };
      },
      "preferences.update": async (message) => {
        browser.storage.set("preferencesUpdateMessage", JSON.stringify(message));
        storedPreferences = { ...storedPreferences, ...message.patch };
        return {
          type: "preferences.result",
          data: { preferences: storedPreferences },
          error: null,
        };
      },
    },
  });
  try {
    const runtime = await importClientRuntime();

    const initial = await runtime.preferences.get();
    assert.deepEqual({
      ...initial,
      id: "request-id",
    }, {
      id: "request-id",
      type: "preferences.result",
      data: { preferences: {} },
      error: null,
    });
    assert.deepEqual({ ...JSON.parse(browser.storage.get("preferencesGetMessage")), id: "request-id" }, {
      id: "request-id",
      type: "preferences.get",
    });

    const updated = await runtime.preferences.update({ theme: "dark" });
    assert.deepEqual({
      ...updated,
      id: "request-id",
    }, {
      id: "request-id",
      type: "preferences.result",
      data: { preferences: { theme: "dark" } },
      error: null,
    });
    assert.deepEqual({ ...JSON.parse(browser.storage.get("preferencesUpdateMessage")), id: "request-id" }, {
      id: "request-id",
      type: "preferences.update",
      patch: { theme: "dark" },
    });
  } finally {
    browser.cleanup();
  }
});

test("client onMessage exposes filterable app message subscriptions", async () => {
  const browser = installBrowserFakes(anonymousAuth);
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

test("client auth.signIn starts a full-page provider redirect and preserves the current URL", async () => {
  const browser = installBrowserFakes(anonymousAuth, { href: "http://localhost:4000/notes?filter=mine#today" });
  try {
    const runtime = await importClientRuntime();
    await runtime.auth.signIn("google");
    assert.deepEqual({ ...JSON.parse(browser.storage.get("signInMessage")), id: "request-id" }, {
      id: "request-id",
      type: "auth.signIn",
      provider: "google",
      returnTo: "http://localhost:4000/notes?filter=mine#today",
    });
    assert.equal(browser.storage.get("sporades.authReturnTo"), "http://localhost:4000/notes?filter=mine#today");
    assert.equal(browser.storage.get("assignedLocation"), "https://accounts.google.com/o/oauth2/v2/auth?state=opaque-state");
  } finally {
    browser.cleanup();
  }
});

test("client auth.signIn sends email credentials without starting a redirect", async () => {
  const emailAuth = {
    userId: "email-user",
    displayName: "Mira",
    email: "mira@example.com",
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
  const browser = installBrowserFakes(anonymousAuth, {
    href: "http://localhost:4000/notes?filter=mine#today",
    handlers: {
      "auth.signIn": async (message) => {
        browser.storage.set("emailSignInMessage", JSON.stringify(message));
        return {
          type: "auth.signIn.result",
          data: {
            ok: true,
            sessionToken: "rotated-email-token",
            auth: emailAuth,
          },
          error: null,
        };
      },
    },
  });
  const stateUpdates = [];
  try {
    const runtime = await importClientRuntime();
    const hooks = runtime.createHooks({
      useState(initialState) {
        return [initialState, (nextState) => stateUpdates.push(nextState)];
      },
      useEffect(effect) {
        effect();
      },
    });
    hooks.useAuth();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await runtime.auth.signIn("email", {
      email: "mira@example.com",
      password: "correct horse battery staple",
    });

    assert.deepEqual({ ...JSON.parse(browser.storage.get("emailSignInMessage")), id: "request-id" }, {
      id: "request-id",
      type: "auth.signIn",
      provider: "email",
      credentials: {
        email: "mira@example.com",
        password: "correct horse battery staple",
      },
    });
    assert.equal(browser.storage.get("assignedLocation"), undefined);
    assert.equal(browser.storage.get("sporades.authReturnTo"), undefined);
    assert.equal(result.type, "auth.signIn.result");
    assert.equal(result.error, null);
    assert.equal(result.data.ok, true);
    assert.equal(browser.storage.get("sporades.sessionToken"), "rotated-email-token");
    assert.deepEqual(
      stateUpdates.map((state) => state.auth?.provider),
      ["anonymous", "email"],
    );
    assert.deepEqual(stateUpdates.at(-1).auth, emailAuth);
  } finally {
    browser.cleanup();
  }
});

test("client auth.signUp sends email credentials through the provider-generic auth surface", async () => {
  const emailAuth = {
    userId: "email-user",
    displayName: "Mira",
    email: "mira@example.com",
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
  const browser = installBrowserFakes(anonymousAuth, {
    handlers: {
      "auth.signUp": async (message) => {
        browser.storage.set("signUpMessage", JSON.stringify(message));
        return {
          type: "auth.signUp.result",
          data: {
            ok: true,
            sessionToken: "rotated-sign-up-token",
            auth: emailAuth,
          },
          error: null,
        };
      },
    },
  });
  const stateUpdates = [];
  try {
    const runtime = await importClientRuntime();
    const hooks = runtime.createHooks({
      useState(initialState) {
        return [initialState, (nextState) => stateUpdates.push(nextState)];
      },
      useEffect(effect) {
        effect();
      },
    });
    hooks.useAuth();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await runtime.auth.signUp("email", {
      email: "mira@example.com",
      password: "correct horse battery staple",
      name: "Mira",
    });

    assert.deepEqual({ ...JSON.parse(browser.storage.get("signUpMessage")), id: "request-id" }, {
      id: "request-id",
      type: "auth.signUp",
      provider: "email",
      credentials: {
        email: "mira@example.com",
        password: "correct horse battery staple",
        name: "Mira",
      },
    });
    assert.equal(result.type, "auth.signUp.result");
    assert.equal(result.error, null);
    assert.equal(result.data.ok, true);
    assert.equal(result.data.auth.provider, "email");
    assert.equal(browser.storage.get("sporades.sessionToken"), "rotated-sign-up-token");
    assert.deepEqual(
      stateUpdates.map((state) => state.auth?.provider),
      ["anonymous", "email"],
    );
    assert.deepEqual(stateUpdates.at(-1).auth, emailAuth);
  } finally {
    browser.cleanup();
  }
});

test("client auth.signOut clears the stored session and refreshes auth state", async () => {
  const linkedAuth = {
    userId: "linked-user",
    displayName: "Mira",
    email: "mira@example.com",
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "google",
  };
  let currentAuth = linkedAuth;
  let currentToken = "linked-session-token";
  const browser = installBrowserFakes(linkedAuth, {
    handlers: {
      "auth.get": async () => ({
        type: "auth.result",
        data: {
          sessionToken: currentToken,
          auth: currentAuth,
          providers: {},
        },
        error: null,
      }),
      "auth.signOut": async () => {
        currentAuth = anonymousAuth;
        currentToken = "fresh-anonymous-token";
        return {
          type: "auth.signOut.result",
          data: {
            ok: true,
          },
          error: null,
        };
      },
    },
  });
  try {
    const runtime = await importClientRuntime();
    assert.equal(await runtime.isAuthenticated(), true);
    assert.equal(browser.storage.get("sporades.sessionToken"), "linked-session-token");

    const result = await runtime.auth.signOut();

    assert.deepEqual(result.data, { ok: true });
    assert.equal(browser.storage.get("sporades.sessionToken"), "fresh-anonymous-token");
    assert.equal(await runtime.isAuthenticated(), false);
  } finally {
    browser.cleanup();
  }
});

test("client auth.signOut returns structured errors without clearing the session on failure", async () => {
  const linkedAuth = {
    userId: "linked-user",
    displayName: "Mira",
    email: "mira@example.com",
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "google",
  };
  const browser = installBrowserFakes(linkedAuth, {
    handlers: {
      "auth.get": async () => ({
        type: "auth.result",
        data: {
          sessionToken: "linked-session-token",
          auth: linkedAuth,
          providers: {},
        },
        error: null,
      }),
      "auth.signOut": async () => ({
        type: "error",
        data: null,
        error: {
          message: "Could not sign out.",
          hint: "Retry sign-out.",
        },
      }),
    },
  });
  try {
    const runtime = await importClientRuntime();
    assert.equal(await runtime.isAuthenticated(), true);

    const result = await runtime.auth.signOut();

    assert.deepEqual(result, {
      id: result.id,
      type: "error",
      data: null,
      error: {
        message: "Could not sign out.",
        hint: "Retry sign-out.",
      },
    });
    assert.equal(browser.storage.get("sporades.sessionToken"), "linked-session-token");
    assert.equal(await runtime.isAuthenticated(), true);
  } finally {
    browser.cleanup();
  }
});

test("useAuth receives refreshed anonymous auth state after sign-out", async () => {
  const linkedAuth = {
    userId: "linked-user",
    displayName: "Mira",
    email: "mira@example.com",
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "google",
  };
  let currentAuth = linkedAuth;
  let currentToken = "linked-session-token";
  const browser = installBrowserFakes(linkedAuth, {
    handlers: {
      "auth.get": async () => ({
        type: "auth.result",
        data: {
          sessionToken: currentToken,
          auth: currentAuth,
          providers: {},
        },
        error: null,
      }),
      "auth.signOut": async () => {
        currentAuth = anonymousAuth;
        currentToken = "fresh-anonymous-token";
        return {
          type: "auth.signOut.result",
          data: { ok: true },
          error: null,
        };
      },
    },
  });
  const stateUpdates = [];
  try {
    const runtime = await importClientRuntime();
    const hooks = runtime.createHooks({
      useState(initialState) {
        return [initialState, (nextState) => stateUpdates.push(nextState)];
      },
      useEffect(effect) {
        effect();
      },
    });

    const authState = hooks.useAuth();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await authState.signOut();

    assert.deepEqual(
      stateUpdates.map((state) => state.auth?.provider),
      ["google", "anonymous"],
    );
    assert.equal(browser.storage.get("sporades.sessionToken"), "fresh-anonymous-token");
  } finally {
    browser.cleanup();
  }
});

test("client applies internal auth session replacement messages to localStorage and auth state", async () => {
  const simulatedAuth = {
    userId: "simulated-user",
    displayName: "Mira Vale",
    email: "mira@example.com",
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
  const browser = installBrowserFakes(anonymousAuth);
  const stateUpdates = [];
  const appMessages = [];
  try {
    const runtime = await importClientRuntime();
    runtime.onMessage((message) => appMessages.push(message));
    const hooks = runtime.createHooks({
      useState(initialState) {
        return [initialState, (nextState) => stateUpdates.push(nextState)];
      },
      useEffect(effect) {
        effect();
      },
    });

    hooks.useAuth();
    await new Promise((resolve) => setTimeout(resolve, 0));
    browser.sockets[0].emit("message", {
      data: JSON.stringify({
        id: null,
        type: "auth.session.replace",
        data: {
          sessionToken: "simulated-session-token",
          auth: simulatedAuth,
        },
        error: null,
      }),
    });

    assert.equal(browser.storage.get("sporades.sessionToken"), "simulated-session-token");
    assert.deepEqual(
      stateUpdates.map((state) => state.auth?.provider),
      ["anonymous", "email"],
    );
    assert.deepEqual(stateUpdates.at(-1).auth, simulatedAuth);
    assert.deepEqual(appMessages, []);
  } finally {
    browser.cleanup();
  }
});

test("client files.upload negotiates an upload URL and transfers one file", async () => {
  let negotiatedMessage = null;
  const browser = installBrowserFakes(anonymousAuth, {
    autoOpen: false,
    handlers: {
      "file.uploadUrl": async (message) => {
        negotiatedMessage = message;
        return {
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
              path: "/docs/hello.txt",
              version: "version-1",
            },
          },
          error: null,
        };
      },
    },
  });
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
              path: "/docs/hello.txt",
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
      path: "/docs/hello.txt",
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
    assert.equal(metadata.path, "/docs/hello.txt");
    assert.equal(negotiatedMessage.file.path, "/docs/hello.txt");
    assert.deepEqual(events.map((event) => event.type), ["progress", "complete"]);
  } finally {
    delete globalThis.fetch;
    browser.cleanup();
  }
});

test("client files.upload uploads arrays sequentially through the single-file path", async () => {
  const negotiatedNames = [];
  const uploadedBodies = [];
  const browser = installBrowserFakes(anonymousAuth, {
    autoOpen: false,
    handlers: {
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
  });
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

test("client files.download authenticates private reads with a header instead of a URL token", async () => {
  let requestedReference = null;
  const browser = installBrowserFakes(anonymousAuth, {
    autoOpen: false,
    handlers: {
      "file.url": async (message) => {
        requestedReference = message.fileReference;
        return {
          type: "file.url.result",
          data: {
            url: "/__sporades/files/private/file-1?v=version-1",
            file: {
              id: "file-1",
              bucket: "default",
              size: 11,
              type: "text/plain",
              name: "hello.txt",
              path: "/docs/hello.txt",
              version: "version-1",
            },
          },
          error: null,
        };
      },
    },
  });
  const downloads = [];
  globalThis.fetch = async (url, options = {}) => {
    downloads.push({ url, headers: options.headers ?? {} });
    return {
      ok: true,
      status: 200,
      async blob() {
        return new Blob(["hello world"], { type: "text/plain" });
      },
    };
  };

  try {
    const runtime = await importClientRuntime();
    const downloadPromise = runtime.files.download("/docs/hello.txt");
    browser.openSockets();
    const blob = await downloadPromise;

    assert.equal(blob.type, "text/plain");
    assert.equal(requestedReference, "/docs/hello.txt");
    assert.deepEqual(downloads, [
      {
        url: "/__sporades/files/private/file-1?v=version-1",
        headers: { "x-sporades-session-token": "session-token" },
      },
    ]);
    assert.doesNotMatch(downloads[0].url, /sessionToken|session-token/);
  } finally {
    delete globalThis.fetch;
    browser.cleanup();
  }
});

test("client files.publicUrl sends expires using the server wire contract", async () => {
  let publicUrlMessage = null;
  const browser = installBrowserFakes(anonymousAuth, {
    autoOpen: false,
    handlers: {
      "file.publicUrl.create": async (message) => {
        publicUrlMessage = message;
        return {
          type: "file.publicUrl.result",
          data: {
            publicUrl: {
              id: "public-1",
              fileId: "file-1",
              url: "/__sporades/files/public/public-1?v=version-1",
              expiresAt: "2026-07-04T12:00:00.000Z",
              revokedAt: null,
            },
          },
          error: null,
        };
      },
    },
  });

  try {
    const runtime = await importClientRuntime();
    const expires = new Date("2026-07-04T12:00:00.000Z");
    const publicUrlPromise = runtime.files.publicUrl("/docs/hello.txt", { expires });
    browser.openSockets();
    const publicUrl = await publicUrlPromise;

    assert.equal(publicUrl.id, "public-1");
    assert.equal(publicUrlMessage.fileReference, "/docs/hello.txt");
    assert.deepEqual(publicUrlMessage.options, { expires: expires.toISOString() });
    assert.equal("expiresAt" in publicUrlMessage.options, false);
  } finally {
    browser.cleanup();
  }
});
