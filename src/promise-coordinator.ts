type PromiseObserver = {
  init?: (promise: Promise<any>, parent?: Promise<any>) => void;
  before?: (promise: Promise<any>) => void;
  after?: (promise: Promise<any>) => void;
  settled?: (promise: Promise<any>) => void;
};

const nodePromiseHooks = (process.getBuiltinModule("node:v8") as any)?.promiseHooks;
const observerRetainers = new Map<PromiseObserver, number>();
const promiseParents = new WeakMap<Promise<any>, Promise<any>>();
const promiseSettlementCauses = new WeakMap<Promise<any>, Promise<any>>();
const promiseCombinatorInputs = new WeakMap<Promise<any>, Set<Promise<any>>>();
let settledPromises = new WeakSet<Promise<any>>();
let promiseHookStack: Promise<any>[] = [];
let promiseHookStop: (() => void) | undefined;
let compositionRootCandidates: Promise<any>[] = [];
let thenableWrapperRoots = new WeakSet<Promise<any>>();
const promiseCombinatorKinds = new WeakMap<Promise<any>, "all" | "allSettled" | "any" | "race">();
let compositionRootClearQueued = false;

// Native combinators expose their inputs through ordinary thenable access, but do not expose the
// aggregate Promise itself. Keep the root Promises created in that same synchronous turn so a
// tracked input can identify the aggregate without replacing Promise or Promise.prototype.

function retainCompositionRootCandidate(promise: Promise<any>) {
  compositionRootCandidates.push(promise);
  if (compositionRootClearQueued) return;
  compositionRootClearQueued = true;
  queueMicrotask(() => {
    compositionRootCandidates = [];
    compositionRootClearQueued = false;
  });
}

function installPromiseHook() {
  if (promiseHookStop || !nodePromiseHooks?.createHook) return;
  promiseHookStop = nodePromiseHooks.createHook({
    init(promise: Promise<any>, parent?: Promise<any>) {
      if (parent) promiseParents.set(promise, parent);
      else retainCompositionRootCandidate(promise);
      const match = parent && (new Error().stack ?? "").match(/at (?:Promise|Function)\.(all|allSettled|any|race)\b/);
      if (parent && match) {
        const root = [...compositionRootCandidates].reverse().find((candidate) => !thenableWrapperRoots.has(candidate));
        if (root) {
          promiseCombinatorKinds.set(root, match[1] as "all" | "allSettled" | "any" | "race");
          const inputs = promiseCombinatorInputs.get(root) ?? new Set<Promise<any>>();
          inputs.add(parent);
          promiseCombinatorInputs.set(root, inputs);
        }
      }
      for (const observer of observerRetainers.keys()) observer.init?.(promise, parent);
    },
    before(promise: Promise<any>) {
      promiseHookStack.push(promise);
      for (const observer of observerRetainers.keys()) observer.before?.(promise);
    },
    after(promise: Promise<any>) {
      for (const observer of observerRetainers.keys()) observer.after?.(promise);
      promiseHookStack.pop();
    },
    settled(promise: Promise<any>) {
      settledPromises.add(promise);
      const cause = promiseHookStack.at(-1);
      if (cause && cause !== promise) promiseSettlementCauses.set(promise, cause);
      for (const observer of observerRetainers.keys()) observer.settled?.(promise);
    },
  });
}

export function retainPromiseObserver(observer: PromiseObserver) {
  observerRetainers.set(observer, (observerRetainers.get(observer) ?? 0) + 1);
  installPromiseHook();
}

export function releasePromiseObserver(observer: PromiseObserver) {
  const retained = observerRetainers.get(observer) ?? 0;
  if (retained <= 1) observerRetainers.delete(observer);
  else observerRetainers.set(observer, retained - 1);
  if (observerRetainers.size !== 0) return;
  promiseHookStop?.();
  promiseHookStop = undefined;
  promiseHookStack = [];
  compositionRootCandidates = [];
  thenableWrapperRoots = new WeakSet();
  settledPromises = new WeakSet();
  compositionRootClearQueued = false;
}

export function activePromise() {
  return promiseHookStack.at(-1);
}

export function promiseSettlementCause(promise: Promise<any>) {
  return promiseSettlementCauses.get(promise);
}

export function promiseDescendsFrom(promise: Promise<any> | undefined, ancestor: any) {
  const visited = new Set<Promise<any>>();
  for (let current = promise; current && !visited.has(current); current = promiseParents.get(current)) {
    if (current === ancestor) return true;
    visited.add(current);
  }
  return false;
}

export function promiseDependsOn(promise: Promise<any> | undefined, dependency: Promise<any>) {
  const pending = promise ? [promise] : [];
  const visited = new Set<Promise<any>>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === dependency) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const parent = promiseParents.get(current);
    if (parent) pending.push(parent);
    if (["all", "allSettled"].includes(promiseCombinatorKinds.get(current) ?? "")) {
      pending.push(...(promiseCombinatorInputs.get(current) ?? []));
    }
  }
  return false;
}

export function promiseCompositionRootCandidate() {
  const wrapper = compositionRootCandidates.at(-1);
  if (!wrapper) return undefined;
  thenableWrapperRoots.add(wrapper);
  const stack = new Error().stack ?? "";
  const match = stack.match(/at (?:Promise|Function)\.(all|allSettled|any|race)\b/);
  if (!match) return undefined;
  for (let index = compositionRootCandidates.length - 2; index >= 0; index -= 1) {
    const candidate = compositionRootCandidates[index];
    if (!thenableWrapperRoots.has(candidate)) {
      promiseCombinatorKinds.set(candidate, match[1] as "all" | "allSettled" | "any" | "race");
      return candidate;
    }
  }
  promiseCombinatorKinds.set(wrapper, match[1] as "all" | "allSettled" | "any" | "race");
  return wrapper;
}

export function promiseCombinatorKind(promise: Promise<any>) {
  return promiseCombinatorKinds.get(promise);
}

export function enclosingPromiseCombinatorRoot() {
  const stack = new Error().stack ?? "";
  if (!/at (?:Promise|Function)\.(?:all|allSettled|any|race)\b/.test(stack)) return undefined;
  for (let index = compositionRootCandidates.length - 1; index >= 0; index -= 1) {
    const candidate = compositionRootCandidates[index];
    if (!settledPromises.has(candidate)) return candidate;
  }
  return undefined;
}
