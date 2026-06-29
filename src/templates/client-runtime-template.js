export function createClientRuntimeSource() {
  return `
const websocketPath = "/__sporades/ws";

export function isAuthenticated() {
  return connect().isAuthenticated();
}

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
      connect()
        .auth()
        .then((result) => {
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
      };
    }, []);

    return {
      ...state,
      isAuthenticated() {
        return Boolean(state.auth?.isAuthenticated);
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
      request("auth.get").then(storeAuthSession);
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
      if (message.type === "auth.result") {
        storeAuthSession(message);
      }
      if (message.type === "query.result" && subscriptions.has(message.id)) {
        subscriptions.get(message.id).listener(message);
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
    return message;
  }

  open();

  return {
    auth() {
      return request("auth.get").then(storeAuthSession);
    },
    isAuthenticated() {
      return request("auth.get")
        .then(storeAuthSession)
        .then((result) => Boolean(result.data?.auth?.isAuthenticated));
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
  };
}
`;
}
