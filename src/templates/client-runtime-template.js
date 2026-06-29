export function createClientRuntimeSource() {
  return `
const websocketPath = "/__sporades/ws";

export function isAuthenticated() {
  return connect().isAuthenticated();
}

export function sendMessage(type, data) {
  return connect().sendMessage(type, data);
}

export function onMessage(listener) {
  return connect().onMessage(listener);
}

export const auth = {
  signUp(provider, credentials) {
    return connect().signUp(provider, credentials);
  },
  signIn(provider, credentials) {
    return connect().signIn(provider, credentials);
  },
  signOut() {
    return connect().signOut();
  },
};

export const files = {
  upload(fileOrFiles, options = {}) {
    return connect().upload(fileOrFiles, options);
  },
  url(fileId) {
    return connect().fileUrl(fileId);
  },
  download(fileId) {
    return connect().downloadFile(fileId);
  },
  delete(fileId) {
    return connect().deleteFile(fileId);
  },
  publicUrl(fileId, options) {
    return connect().createPublicFileUrl(fileId, options);
  },
  revokePublicUrl(publicUrlId) {
    return connect().revokePublicFileUrl(publicUrlId);
  },
};

export function createHooks(primitives) {
  const { useEffect, useState } = primitives;

  function useQuery(name) {
    const [state, setState] = useState({ data: null, error: null, loading: true });

    useEffect(() => {
      const subscription = connect().subscribe(name, (message) => {
        setState({
          data: message.data ?? null,
          error: message.error ?? null,
          loading: false,
        });
      });
      return () => subscription.unsubscribe();
    }, [name]);

    return state;
  }

  function useMutation(name) {
    const [state, setState] = useState({ error: null, loading: false });

    return {
      ...state,
      async run(...args) {
        setState({ error: null, loading: true });
        const result = await connect().mutate(name, args);
        setState({ error: result.error ?? null, loading: false });
        return result;
      },
    };
  }

  function useAuth() {
    const [state, setState] = useState({ auth: null, providers: {}, loading: true, error: null });

    useEffect(() => {
      let active = true;
      const connection = connect();
      const subscription = connection.onAuthState((result) => {
        if (!active) return;
        setState({
          auth: result.data?.auth ?? null,
          providers: result.data?.providers ?? {},
          loading: false,
          error: result.error ?? null,
        });
      });
      return () => {
        active = false;
        subscription.unsubscribe();
      };
    }, []);

    return {
      ...state,
      isAuthenticated() {
        return Boolean(state.auth?.isAuthenticated);
      },
      signUp(provider, credentials) {
        return connect().signUp(provider, credentials);
      },
      signIn(provider, credentials) {
        return connect().signIn(provider, credentials);
      },
      signOut() {
        return connect().signOut();
      },
    };
  }

  return { useQuery, useMutation, useAuth };
}

let connection;

function connect() {
  if (!connection) {
    connection = createConnection();
  }
  return connection;
}

function createConnection() {
  let socket = null;
  let nextId = 1;
  let sessionToken = localStorage.getItem("sporades.sessionToken");
  const pending = new Map();
  const subscriptions = new Map();
  const appMessageListeners = new Set();
  const authStateListeners = new Set();
  let latestAuthMessage = null;

  function open() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return socket;
    }

    const url = new URL(websocketPath, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (sessionToken) {
      url.searchParams.set("sessionToken", sessionToken);
    }
    socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      request("auth.get");
      for (const subscription of subscriptions.values()) {
        send({
          id: subscription.id,
          type: "query.subscribe",
          query: subscription.name,
        });
      }
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "auth.result" || message.type === "auth.session.replace") {
        storeAuthSession(message);
      }
      if (message.type === "query.result" && subscriptions.has(message.id)) {
        subscriptions.get(message.id).listener(message);
        return;
      }
      if (message.type === "app.message") {
        notifyAppMessageListeners({
          type: message.message,
          data: message.data ?? null,
        });
        return;
      }
      if (pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    socket.addEventListener("close", () => {
      setTimeout(open, 500);
    });
    return socket;
  }

  function send(message) {
    const activeSocket = open();
    if (activeSocket.readyState === WebSocket.OPEN) {
      activeSocket.send(JSON.stringify(message));
      return;
    }
    activeSocket.addEventListener(
      "open",
      () => {
        activeSocket.send(JSON.stringify(message));
      },
      { once: true },
    );
  }

  function request(type, fields = {}) {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      send({ id, type, ...fields });
    });
  }

  function storeAuthSession(message) {
    const token = message.data?.sessionToken;
    if (token) {
      sessionToken = token;
      localStorage.setItem("sporades.sessionToken", token);
    }
    latestAuthMessage = message;
    notifyAuthStateListeners(message);
    return message;
  }

  function notifyAuthStateListeners(message) {
    for (const listener of authStateListeners) {
      listener(message);
    }
  }

  function notifyAppMessageListeners(appMessage) {
    for (const listener of appMessageListeners) {
      listener(appMessage);
    }
  }

  function createAppMessageStream(predicate = () => true) {
    return {
      filter(nextPredicate) {
        return createAppMessageStream((message) => predicate(message) && nextPredicate(message));
      },
      subscribe(listener) {
        const filteredListener = (message) => {
          if (predicate(message)) {
            listener(message);
          }
        };
        appMessageListeners.add(filteredListener);
        open();
        return {
          unsubscribe() {
            appMessageListeners.delete(filteredListener);
          },
        };
      },
    };
  }

  open();

  return {
    auth() {
      return request("auth.get");
    },
    isAuthenticated() {
      return request("auth.get")
        .then((result) => Boolean(result.data?.auth?.isAuthenticated));
    },
    onAuthState(listener) {
      authStateListeners.add(listener);
      if (latestAuthMessage) {
        listener(latestAuthMessage);
      }
      return {
        unsubscribe() {
          authStateListeners.delete(listener);
        },
      };
    },
    signUp(provider, credentials) {
      return request("auth.signUp", { provider, credentials });
    },
    signIn(provider, credentials) {
      if (credentials) {
        return request("auth.signIn", { provider, credentials });
      }
      const returnTo = window.location.href;
      localStorage.setItem("sporades.authReturnTo", returnTo);
      return request("auth.signIn", { provider, returnTo }).then((result) => {
        if (result.data?.url) {
          window.location.assign(result.data.url);
        }
        return result;
      });
    },
    signOut() {
      return request("auth.signOut").then(async (result) => {
        if (!result.error && result.data?.ok === true) {
          sessionToken = null;
          localStorage.removeItem("sporades.sessionToken");
          await request("auth.get");
        }
        return result;
      });
    },
    subscribe(name, listener) {
      const id = nextId++;
      const subscription = { id, name, listener };
      subscriptions.set(id, subscription);
      send({ id, type: "query.subscribe", query: name });
      return {
        unsubscribe() {
          subscriptions.delete(id);
        },
      };
    },
    mutate(name, args) {
      return request("mutation.run", { mutation: name, args });
    },
    sendMessage(type, data) {
      return request("app.send", { message: type, data });
    },
    onMessage(listener) {
      const stream = createAppMessageStream();
      return typeof listener === "function" ? stream.subscribe(listener) : stream;
    },
    async upload(fileOrFiles, options = {}) {
      if (Array.isArray(fileOrFiles)) {
        const results = [];
        for (const file of fileOrFiles) {
          results.push(await this.upload(file, options));
        }
        return results;
      }

      const file = fileOrFiles;
      const negotiate = await request("file.uploadUrl", {
        file: {
          name: file.name ?? "upload",
          type: file.type ?? "application/octet-stream",
          size: file.size ?? 0,
        },
        replace: options.replace === true,
        fileId: options.fileId ?? null,
      });
      if (negotiate.error) {
        throw structuredError(negotiate.error);
      }

      const upload = negotiate.data;
      options.onProgress?.({ type: "progress", fileId: upload.file.id, loaded: file.size ?? 0, total: file.size ?? 0 });
      const response = await fetch(upload.uploadUrl, {
        method: upload.method ?? "PUT",
        headers: upload.headers ?? {},
        body: file,
      });
      const result = await response.json();
      if (!response.ok || result.error) {
        throw structuredError(result.error ?? {
          message: "File upload failed.",
          hint: "Retry the upload or choose a smaller file.",
        });
      }
      const metadata = result.data.file;
      options.onComplete?.({ type: "complete", file: metadata });
      return metadata;
    },
    async fileUrl(fileId) {
      const result = await request("file.url", { fileId });
      if (result.error) throw structuredError(result.error);
      return result.data.url;
    },
    async downloadFile(fileId) {
      const url = await this.fileUrl(fileId);
      const response = await fetch(url);
      if (!response.ok) {
        throw structuredError({
          message: "File download failed.",
          hint: "Check that the file exists and belongs to the current user.",
        });
      }
      return response.blob();
    },
    async deleteFile(fileId) {
      const result = await request("file.delete", { fileId });
      if (result.error) throw structuredError(result.error);
      return result.data.file;
    },
    async createPublicFileUrl(fileId, options) {
      const result = await request("file.publicUrl.create", { fileId, options: options ?? {} });
      if (result.error) throw structuredError(result.error);
      return result.data.publicUrl;
    },
    async revokePublicFileUrl(publicUrlId) {
      const result = await request("file.publicUrl.revoke", { publicUrlId });
      if (result.error) throw structuredError(result.error);
      return result.data.publicUrl;
    },
  };
}

function structuredError(error) {
  const next = new Error(error?.message ?? "Sporades file operation failed.");
  next.hint = error?.hint ?? "Retry the operation.";
  next.error = error;
  return next;
}
`;
}
