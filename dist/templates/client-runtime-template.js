export function createClientRuntimeSource(options = {}) {
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

export const queries = {
  subscribe(name, listener) {
    return connect().subscribeQuery(name, listener);
  },
};

export const mutations = {
  run(name, ...args) {
    return connect().mutate(name, args);
  },
};

export const preferences = {
  get() {
    return connect().getPreferences();
  },
  update(patch) {
    return connect().updatePreferences(patch);
  },
};

export const journey = {
  enable(options = {}) { return connect().journeyEnable(options); },
  set(state) { return connect().journeySet(state); },
  list() { return connect().journeyList(); },
  subscribe(listener) { return connect().journeySubscribe(listener); },
  disable() { return connect().journeyDisable(); },
};

export const auth = {
  get() {
    return connect().auth();
  },
  subscribe(listener) {
    return connect().subscribeAuth(listener);
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
      const subscription = queries.subscribe(name, setState);
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
        const result = await mutations.run(name, ...args);
        setState({ error: result.error ?? null, loading: false });
        return result;
      },
    };
  }

  function useAuth() {
    const [state, setState] = useState({ auth: null, providers: {}, loading: true, error: null });

    useEffect(() => {
      let active = true;
      const subscription = auth.subscribe((result) => {
        if (!active || result.loading) return;
        setState(result);
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

export function createVueComposables(primitives) {
  const { reactive, onScopeDispose } = primitives;

  function useQuery(name) {
    const state = reactive({ data: null, error: null, loading: true });
    const subscription = queries.subscribe(name, (nextState) => Object.assign(state, nextState));
    onScopeDispose(() => subscription.unsubscribe());
    return state;
  }

  function useMutation(name) {
    const state = reactive({ data: null, error: null, loading: false });
    let pending = 0;
    let latestInvocation = 0;
    state.run = async (...args) => {
      const invocation = ++latestInvocation;
      pending += 1;
      state.data = null;
      state.error = null;
      state.loading = true;
      try {
        const result = await mutations.run(name, ...args);
        if (invocation === latestInvocation) {
          state.data = result.error ? null : result.data ?? null;
          state.error = result.error ?? null;
        }
        return result;
      } catch (error) {
        if (invocation === latestInvocation) {
          state.data = null;
          state.error = normalizeMutationError(error);
        }
        throw error;
      } finally {
        pending -= 1;
        state.loading = pending > 0;
      }
    };
    return state;
  }

  function useAuth() {
    const state = reactive({ auth: null, providers: {}, loading: true, error: null });
    const subscription = auth.subscribe((nextState) => Object.assign(state, nextState));
    onScopeDispose(() => subscription.unsubscribe());
    state.isAuthenticated = () => Boolean(state.auth?.isAuthenticated);
    state.signUp = (provider, credentials) => connect().signUp(provider, credentials);
    state.signIn = (provider, credentials) => connect().signIn(provider, credentials);
    state.signOut = () => connect().signOut();
    return state;
  }

  return { useQuery, useMutation, useAuth };
}

export function createSolidPrimitives(primitives) {
  const { createSignal, onCleanup } = primitives;

  function createQuery(name) {
    const [state, setState] = createSignal({ data: null, error: null, loading: true });
    const subscription = queries.subscribe(name, setState);
    onCleanup(() => subscription.unsubscribe());
    return state;
  }

  function createMutation(name) {
    const [state, setState] = createSignal({ data: null, error: null, loading: false });
    let pending = 0;
    let latestInvocation = 0;
    const run = async (...args) => {
      const invocation = ++latestInvocation;
      pending += 1;
      setState({ data: null, error: null, loading: true });
      try {
        const result = await mutations.run(name, ...args);
        if (invocation === latestInvocation) {
          setState({ data: result.error ? null : result.data ?? null, error: result.error ?? null, loading: pending > 1 });
        }
        return result;
      } catch (error) {
        if (invocation === latestInvocation) setState({ data: null, error: normalizeMutationError(error), loading: pending > 1 });
        throw error;
      } finally {
        pending -= 1;
        setState((current) => ({ ...current, loading: pending > 0 }));
      }
    };
    return { state, run };
  }

  function createAuth() {
    const [state, setState] = createSignal({ auth: null, providers: {}, loading: true, error: null });
    const subscription = auth.subscribe(setState);
    onCleanup(() => subscription.unsubscribe());
    return {
      state,
      isAuthenticated: () => Boolean(state().auth?.isAuthenticated),
      signUp: (provider, credentials) => connect().signUp(provider, credentials),
      signIn: (provider, credentials) => connect().signIn(provider, credentials),
      signOut: () => connect().signOut(),
    };
  }

  return { createQuery, createMutation, createAuth };
}

export function createLitControllers() {
  function requestHostUpdate(host) {
    try { host.requestUpdate(); } catch {}
  }

  function observedController(host, initialState, subscribe) {
    let subscription = null;
    let connected = false;
    let generation = 0;
    const controller = {
      state: initialState,
      hostConnected() {
        if (connected) return;
        connected = true;
        const ownedGeneration = ++generation;
        let nextSubscription;
        try {
          nextSubscription = subscribe((state) => {
            if (!connected || generation !== ownedGeneration) return;
            controller.state = state;
            requestHostUpdate(host);
          });
        } catch (error) {
          connected = false;
          generation += 1;
          throw error;
        }
        if (!connected || generation !== ownedGeneration) {
          nextSubscription.unsubscribe();
          return;
        }
        subscription = nextSubscription;
      },
      hostDisconnected() {
        if (!connected) return;
        connected = false;
        generation += 1;
        if (!subscription) return;
        const owned = subscription;
        subscription = null;
        owned.unsubscribe();
      },
    };
    host.addController(controller);
    return controller;
  }

  function queryController(host, name) {
    return observedController(host, { data: null, error: null, loading: true }, (publish) => queries.subscribe(name, publish));
  }

  function mutationController(host, name) {
    let pending = 0;
    let latestInvocation = 0;
    const controller = {
      state: { data: null, error: null, loading: false },
      async run(...args) {
        const invocation = ++latestInvocation;
        pending += 1;
        controller.state = { data: null, error: null, loading: true };
        requestHostUpdate(host);
        try {
          const result = await mutations.run(name, ...args);
          if (invocation === latestInvocation) {
            controller.state = { data: result.error ? null : result.data ?? null, error: result.error ?? null, loading: pending > 1 };
            requestHostUpdate(host);
          }
          return result;
        } catch (error) {
          if (invocation === latestInvocation) {
            controller.state = { data: null, error: normalizeMutationError(error), loading: pending > 1 };
            requestHostUpdate(host);
          }
          throw error;
        } finally {
          pending -= 1;
          controller.state = { ...controller.state, loading: pending > 0 };
          requestHostUpdate(host);
        }
      },
    };
    host.addController(controller);
    return controller;
  }

  function authController(host) {
    const controller = observedController(host, { auth: null, providers: {}, loading: true, error: null }, (publish) => auth.subscribe(publish));
    controller.isAuthenticated = () => Boolean(controller.state.auth?.isAuthenticated);
    controller.signUp = (provider, credentials) => connect().signUp(provider, credentials);
    controller.signIn = (provider, credentials) => connect().signIn(provider, credentials);
    controller.signOut = () => connect().signOut();
    return controller;
  }

  return { queryController, mutationController, authController };
}

export function createSvelteStores() {
  function queryStore(name) {
    return createLazyStore(
      { data: null, error: null, loading: true },
      (publish) => queries.subscribe(name, publish).unsubscribe,
      true,
    );
  }

  function mutationStore(name) {
    let pending = 0;
    let latestInvocation = 0;
    const store = createLazyStore({ data: null, error: null, loading: false });
    const run = async (...args) => {
      const invocation = ++latestInvocation;
      pending += 1;
      store.publish({ data: null, error: null, loading: true });
      try {
        const result = await mutations.run(name, ...args);
        if (invocation === latestInvocation) store.publish({ data: result.error ? null : result.data ?? null, error: result.error ?? null, loading: pending > 1 });
        return result;
      } catch (error) {
        if (invocation === latestInvocation) store.publish({ data: null, error: normalizeMutationError(error), loading: pending > 1 });
        throw error;
      } finally {
        pending -= 1;
        store.publish({ loading: pending > 0 });
      }
    };
    return { subscribe: store.subscribe, run };
  }

  function authStore() {
    const isAuthenticated = () => Boolean(store.value().auth?.isAuthenticated);
    const store = createLazyStore(
      { auth: null, providers: {}, loading: true, error: null, isAuthenticated },
      (publish) => auth.subscribe((nextState) => publish({ ...nextState, isAuthenticated })).unsubscribe,
      true,
    );
    return {
      subscribe: store.subscribe,
      signUp: (provider, credentials) => connect().signUp(provider, credentials),
      signIn: (provider, credentials) => connect().signIn(provider, credentials),
      signOut: () => connect().signOut(),
    };
  }

  return { queryStore, mutationStore, authStore };
}

function createLazyStore(initialState, start, resetOnStart = false) {
  let state = initialState;
  let stop = null;
  const subscriptions = new Set();
  const publish = (nextState) => {
    state = { ...state, ...nextState };
    let firstError = null;
    for (const subscription of [...subscriptions]) {
      if (!subscription.active) continue;
      try { subscription.listener(state); } catch (error) { firstError ??= error; }
    }
    if (firstError) throw firstError;
  };
  const subscribe = (listener) => {
    const subscription = { listener, active: true };
    if (subscriptions.size === 0 && start) {
      if (resetOnStart) state = { ...initialState };
      stop = start(publish) ?? null;
    }
    subscriptions.add(subscription);
    try {
      listener(state);
    } catch (error) {
      subscription.active = false;
      subscriptions.delete(subscription);
      if (subscriptions.size === 0 && stop) {
        const teardown = stop;
        stop = null;
        teardown();
      }
      throw error;
    }
    return () => {
      if (!subscription.active) return;
      subscription.active = false;
      subscriptions.delete(subscription);
      if (subscriptions.size === 0 && stop) {
        const teardown = stop;
        stop = null;
        teardown();
      }
    };
  };
  return { subscribe, publish, value: () => state };
}

function normalizeMutationError(error) {
  if (error && typeof error === "object" && typeof error.message === "string") {
    return { message: error.message, ...(typeof error.hint === "string" ? { hint: error.hint } : {}) };
  }
  return { message: typeof error === "string" && error ? error : "Mutation failed." };
}

let connection;

function connect() {
  if (!connection) {
    connection = createConnection();
  }
  return connection;
}

function createConnection() {
  const journeyRuntimeOwnerId = Symbol("sporades.journey.runtime-owner");
  const existingJourneyOwnerKey = Symbol.for("sporades.journey.capture.teardown");
  if (typeof window !== "undefined" && typeof window[existingJourneyOwnerKey] === "function" && window[existingJourneyOwnerKey].ownerId !== journeyRuntimeOwnerId) window[existingJourneyOwnerKey]();
  let socket = null;
  let nextId = 1;
  let sessionToken = localStorage.getItem("sporades.sessionToken");
  const pending = new Map();
  const subscriptions = new Map();
  const queryChannels = new Map();
  const appMessageListeners = new Set();
  const authStateListeners = new Set();
  let latestAuthMessage = null;
  let journeyConsentOptions = null;
  let journeyEnabledUserId = null;
  let journeyCapture = null;
  let journeyCaptureTeardown = null;
  const journeySubscriptions = new Map();
  let latestAuthUserId = null;
  let pageRetired = false;
  ${options.devRefresh ? "let latestDevRefreshSequence = 0;" : ""}
  let journeyRetireOwner = null;
  window.addEventListener?.("pagehide", () => {
    pageRetired = true;
    journeyRetireOwner?.();
    socket?.close();
  }, { once: true });

  function syncSessionTokenFromStorage() {
    const storedToken = localStorage.getItem("sporades.sessionToken");
    if (storedToken && storedToken !== sessionToken) {
      sessionToken = storedToken;
    }
    return sessionToken;
  }

  function open() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return socket;
    }

    syncSessionTokenFromStorage();
    const url = new URL(websocketPath, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const connectionToken = window.__SPORADES_CONNECTION_TOKEN;
    if (typeof connectionToken === "string" && connectionToken.length > 0) {
      url.searchParams.set("connectionToken", connectionToken);
    }
    socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      ${options.devRefresh ? 'request("dev.refresh.subscribe");' : ""}
      request("auth.get");
      if (journeyConsentOptions) {
        request("journey.enable", { options: journeyConsentOptions }).then((result) => {
          if (!result.error && result.data?.capture) startJourneyCapture(result.data.capture);
        });
      }
      for (const subscription of journeySubscriptions.values()) send({ id: subscription.id, type: "journey.subscribe", resume: subscription.started });
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
      ${options.devRefresh ? `if (message.type === "refresh" && message.data?.mode === "full-page") {
        const refreshSequence = message.data.sequence;
        if (Number.isSafeInteger(refreshSequence) && refreshSequence >= 1) {
          send({ id: null, type: "dev.refresh.received", sequence: refreshSequence });
          if (refreshSequence > latestDevRefreshSequence) {
            latestDevRefreshSequence = refreshSequence;
            window.location.reload();
          }
        }
        return;
      }` : ""}
      if (message.type === "auth.result" || message.type === "auth.session.replace") {
        storeAuthSession(message);
      }
      if (message.type === "journey.event") {
        const subscription = journeySubscriptions.get(message.id);
        if (subscription) {
          subscription.started = true;
          updateJourneySubscriptionState(subscription, message.data);
          subscription.listener(message.data);
        }
        return;
      }
      if (message.type === "journey.sync") {
        const subscription = journeySubscriptions.get(message.id);
        if (subscription) reconcileJourneySubscription(subscription, message.data.states);
        return;
      }
      if (message.type === "query.result" && subscriptions.has(message.id)) {
        const subscription = subscriptions.get(message.id);
        subscription.latest = {
          data: message.data ?? null,
          error: message.error ?? null,
          loading: false,
        };
        for (const listener of subscription.listeners) listener(subscription.latest);
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
      stopJourneyCapture();
      if (!pageRetired) setTimeout(open, 500);
    });
    return socket;
  }

  function send(message) {
    const currentSessionToken = syncSessionTokenFromStorage();
    const activeSocket = open();
    const outboundMessage = currentSessionToken
      ? { ...message, sessionToken: currentSessionToken }
      : message;
    if (activeSocket.readyState === WebSocket.OPEN) {
      activeSocket.send(JSON.stringify(outboundMessage));
      return;
    }
    activeSocket.addEventListener(
      "open",
      () => {
        activeSocket.send(JSON.stringify(outboundMessage));
      },
      { once: true },
    );
  }

  function sendIfOpen(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const currentSessionToken = syncSessionTokenFromStorage();
    const outboundMessage = currentSessionToken ? { ...message, sessionToken: currentSessionToken } : message;
    try {
      socket.send(JSON.stringify(outboundMessage));
      return true;
    } catch {
      return false;
    }
  }

  function request(type, fields = {}) {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      send({ id, type, ...fields });
    });
  }

  function updateJourneySubscriptionState(subscription, event) {
    if (event.type === "snapshot") {
      subscription.states = new Map(event.states.map((state) => [state.sessionId, state]));
    } else if (event.type === "removed") {
      subscription.states.delete(event.state.sessionId);
    } else {
      subscription.states.set(event.state.sessionId, event.state);
    }
  }

  function reconcileJourneySubscription(subscription, states) {
    const next = new Map(states.map((state) => [state.sessionId, state]));
    for (const [sessionId, previous] of subscription.states) {
      if (!next.has(sessionId)) subscription.listener({ type: "removed", state: previous });
    }
    for (const state of states) {
      const previous = subscription.states.get(state.sessionId);
      if (!previous) subscription.listener({ type: "added", state });
      else if (JSON.stringify(previous) !== JSON.stringify(state)) subscription.listener({ type: "updated", state });
    }
    subscription.states = next;
  }

  function storeAuthSession(message) {
    const token = message.data?.sessionToken;
    const nextAuthUserId = message.data?.auth?.userId ?? null;
    if ((latestAuthUserId && nextAuthUserId && latestAuthUserId !== nextAuthUserId) || (journeyEnabledUserId && nextAuthUserId && journeyEnabledUserId !== nextAuthUserId)) {
      stopJourneyCapture();
      journeyCapture = null;
      journeyConsentOptions = null;
      journeyEnabledUserId = null;
    }
    if (nextAuthUserId) latestAuthUserId = nextAuthUserId;
    if (token) {
      if (sessionToken && token !== sessionToken) { stopJourneyCapture(); journeyCapture = null; journeyConsentOptions = null; journeyEnabledUserId = null; }
      sessionToken = token;
      localStorage.setItem("sporades.sessionToken", token);
    }
    latestAuthMessage = message;
    notifyAuthStateListeners(message);
    return message;
  }

  function publicAuthResult(message) {
    return {
      data: message.data ? {
        auth: message.data.auth ?? null,
        providers: message.data.providers ?? {},
      } : null,
      error: message.error ?? null,
    };
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

  function stopJourneyCapture() {
    if (journeyCaptureTeardown) journeyCaptureTeardown();
    journeyCaptureTeardown = null;
  }

  function startJourneyCapture(capture) {
    stopJourneyCapture();
    journeyCapture = capture;
    const ownerKey = Symbol.for("sporades.journey.capture.teardown");
    if (typeof window[ownerKey] === "function" && window[ownerKey].ownerId !== journeyRuntimeOwnerId) window[ownerKey]();
    const retireOwner = () => {
      journeyCaptureTeardown?.();
      journeyCaptureTeardown = null;
      if (journeyConsentOptions) request("journey.disable").catch?.(() => {});
      journeyConsentOptions = null;
      journeyEnabledUserId = null;
      journeyCapture = null;
      if (window[ownerKey] === retireOwner) delete window[ownerKey];
      if (journeyRetireOwner === retireOwner) journeyRetireOwner = null;
    };
    retireOwner.ownerId = journeyRuntimeOwnerId;
    window[ownerKey] = retireOwner;
    journeyRetireOwner = retireOwner;
    if (typeof document === "undefined") return;
    const cleanups = [];
    let routeFrame = null;
    const safePage = () => {
      const semantic = document.querySelector?.('meta[name="sporades-journey"]')?.getAttribute?.("content")?.trim();
      if (semantic && new TextEncoder().encode(semantic).length <= 256) return semantic;
      try { return "/" + new URL(window.location.href).pathname.split("/").filter(Boolean).join("/"); }
      catch { return "/"; }
    };
    const publish = (status) => request("journey.set", { state: { status, metadata: { page: safePage() } } }).catch?.(() => {});
    const listen = (target, type, listener, options) => {
      target.addEventListener?.(type, listener, options);
      cleanups.push(() => target.removeEventListener?.(type, listener, options));
    };
    const scheduleRoute = () => {
      if (!capture.navigation || routeFrame !== null) return;
      const raf = window.requestAnimationFrame ?? ((callback) => setTimeout(callback, 0));
      const cancel = window.cancelAnimationFrame ?? clearTimeout;
      routeFrame = raf(() => { routeFrame = null; publish("viewing"); });
      cleanups.push(() => { if (routeFrame !== null) cancel(routeFrame); routeFrame = null; });
    };
    if (capture.navigation) {
      for (const name of ["pushState", "replaceState"]) {
        const original = window.history?.[name];
        if (typeof original !== "function") continue;
        const wrapped = function(...args) { const result = Reflect.apply(original, this, args); scheduleRoute(); return result; };
        window.history[name] = wrapped;
        cleanups.push(() => { if (window.history[name] === wrapped) window.history[name] = original; });
      }
      listen(window, "popstate", scheduleRoute);
      listen(window, "hashchange", scheduleRoute);
      if (typeof MutationObserver === "function" && document.head) {
        let meta = null;
        const metaObserver = new MutationObserver((records) => {
          if (records.some((record) => record.target === meta && (record.attributeName === "content" || record.attributeName === "name"))) {
            bindMeta(); scheduleRoute();
          }
        });
        const bindMeta = (force = false) => {
          const next = document.querySelector?.('meta[name="sporades-journey"]') ?? null;
          if (next === meta && !force) return;
          metaObserver.disconnect(); meta = next;
          if (meta) metaObserver.observe(meta, { attributes: true, attributeFilter: ["name", "content"] });
        };
        bindMeta();
        const headObserver = new MutationObserver((records) => {
          if (!records.some((record) => [...(record.addedNodes ?? []), ...(record.removedNodes ?? [])].some((node) => node?.matches?.("meta")))) return;
          const previous = meta; bindMeta(true); if (previous !== meta) scheduleRoute();
        });
        headObserver.observe(document.head, { childList: true });
        cleanups.push(() => { headObserver.disconnect(); metaObserver.disconnect(); });
      }
      scheduleRoute();
    }
    if (capture.focus) {
      listen(window, "focus", () => publish(document.hidden ? "away" : "focused"));
      listen(window, "blur", () => publish("away"));
      listen(document, "visibilitychange", () => publish(document.hidden ? "away" : "focused"));
    }
    if (capture.interactions) {
      let pendingClick = null;
      const observeInteraction = (event) => {
        const path = typeof event.composedPath === "function" ? event.composedPath() : [];
        const candidates = event.type === "submit" && event.submitter ? [event.submitter, ...path] : path;
        const annotated = candidates.find((node) => node?.getAttribute?.("data-sporades-journey") != null);
        const status = annotated?.getAttribute?.("data-sporades-journey")?.trim();
        if (!status) return;
        const publishAfterPropagation = () => queueMicrotask(() => {
          if (event.defaultPrevented || status === "inactive" || new TextEncoder().encode(status).length > 256) return;
          publish(status);
        });
        if (event.type === "submit") {
          if (pendingClick && event.submitter && pendingClick.activationPath.includes(event.submitter)) { clearTimeout(pendingClick.timer); pendingClick = null; }
          publishAfterPropagation();
          return;
        }
        const timer = setTimeout(() => { if (pendingClick?.timer === timer) pendingClick = null; publishAfterPropagation(); }, 0);
        pendingClick = { activationPath: path, timer };
      };
      listen(document, "click", observeInteraction, true);
      listen(document, "submit", observeInteraction, true);
      cleanups.push(() => { if (pendingClick) clearTimeout(pendingClick.timer); pendingClick = null; });
    }
    let stopped = false;
    journeyCaptureTeardown = () => { if (stopped) return; stopped = true; for (const cleanup of cleanups.splice(0).reverse()) cleanup(); };
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
      return request("auth.get").then(publicAuthResult);
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
    subscribeAuth(listener) {
      if (typeof listener !== "function") throw new TypeError("auth.subscribe requires a listener function.");
      const wrapped = (message) => listener({
        auth: message.data?.auth ?? null,
        providers: message.data?.providers ?? {},
        loading: false,
        error: message.error ?? null,
      });
      authStateListeners.add(wrapped);
      if (latestAuthMessage) wrapped(latestAuthMessage);
      else listener({ auth: null, providers: {}, loading: true, error: null });
      let active = true;
      return { unsubscribe() { if (!active) return; active = false; authStateListeners.delete(wrapped); } };
    },
    signUp(provider, credentials) {
      return request("auth.signUp", { provider, credentials }).then((result) => {
        if (result.data?.sessionToken) {
          return storeAuthSession(result);
        }
        return result;
      });
    },
    signIn(provider, credentials) {
      if (credentials) {
        return request("auth.signIn", { provider, credentials }).then((result) => {
          if (result.data?.sessionToken) {
            return storeAuthSession(result);
          }
          return result;
        });
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
          journeyConsentOptions = null;
          journeyEnabledUserId = null;
          stopJourneyCapture();
          journeyCapture = null;
          sessionToken = null;
          localStorage.removeItem("sporades.sessionToken");
          await request("auth.get");
        }
        return result;
      });
    },
    subscribeQuery(name, listener) {
      if (typeof name !== "string" || !name) throw new TypeError("queries.subscribe requires a query name.");
      if (typeof listener !== "function") throw new TypeError("queries.subscribe requires a listener function.");
      let subscription = queryChannels.get(name);
      if (!subscription) {
        const id = nextId++;
        subscription = { id, name, listeners: new Set(), latest: null };
        queryChannels.set(name, subscription);
        subscriptions.set(id, subscription);
        const activeSocket = open();
        if (activeSocket.readyState === WebSocket.OPEN) send({ id, type: "query.subscribe", query: name });
      }
      subscription.listeners.add(listener);
      listener(subscription.latest ?? { data: null, error: null, loading: true });
      let active = true;
      return { unsubscribe() {
        if (!active) return;
        active = false;
        subscription.listeners.delete(listener);
        if (subscription.listeners.size === 0) {
          queryChannels.delete(name);
          subscriptions.delete(subscription.id);
          sendIfOpen({ id: nextId++, type: "query.unsubscribe", subscriptionId: subscription.id });
        }
      } };
    },
    mutate(name, args) {
      return request("mutation.run", { mutation: name, args });
    },
    getPreferences() {
      return request("preferences.get");
    },
    updatePreferences(patch) {
      return request("preferences.update", { patch });
    },
    journeyEnable(options = {}) {
      return request("journey.enable", { options }).then((result) => {
        if (!result.error) journeyConsentOptions = options;
        if (result.data?.userId) journeyEnabledUserId = result.data.userId;
        if (!result.error && result.data?.capture) startJourneyCapture(result.data.capture);
        if (!result.data) return result;
        return result;
      });
    },
    journeySet(state) { return request("journey.set", { state }); },
    journeyList() { return request("journey.list"); },
    journeySubscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("journey.subscribe requires a listener function.");
      const id = nextId++;
      const subscription = { id, listener, started: false, states: new Map() };
      journeySubscriptions.set(id, subscription);
      const activeSocket = open();
      if (activeSocket.readyState === WebSocket.OPEN) send({ id, type: "journey.subscribe" });
      return { unsubscribe() { if (journeySubscriptions.delete(id)) send({ id: nextId++, type: "journey.unsubscribe", subscriptionId: id }); } };
    },
    journeyDisable() { return request("journey.disable").then((result) => { if (!result.error) { stopJourneyCapture(); journeyCapture = null; journeyConsentOptions = null; journeyEnabledUserId = null; } return result; }); },
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
          path: options.path ?? null,
        },
        replace: options.replace === true,
        fileId: options.fileId ?? null,
        fileReference: options.fileReference ?? options.fileId ?? null,
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
    async fileUrl(fileReference) {
      const result = await request("file.url", { fileReference, fileId: fileReference });
      if (result.error) throw structuredError(result.error);
      return result.data.url;
    },
    async downloadFile(fileReference) {
      const url = await this.fileUrl(fileReference);
      if (!sessionToken) {
        await request("auth.get");
      }
      const response = await fetch(url, {
        headers: sessionToken ? { "x-sporades-session-token": sessionToken } : {},
      });
      if (!response.ok) {
        throw structuredError({
          message: "File download failed.",
          hint: "Check that the file exists and belongs to the current user.",
        });
      }
      return response.blob();
    },
    async deleteFile(fileReference) {
      const result = await request("file.delete", { fileReference, fileId: fileReference });
      if (result.error) throw structuredError(result.error);
      return result.data.file;
    },
    async createPublicFileUrl(fileReference, options) {
      const result = await request("file.publicUrl.create", { fileReference, fileId: fileReference, options: options ?? {} });
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
//# sourceMappingURL=client-runtime-template.js.map