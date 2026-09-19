const nodePromiseHooks = process.getBuiltinModule("node:v8")?.promiseHooks;
const observerRetainers = new Map();
const promiseParents = new WeakMap();
const promiseSettlementCauses = new WeakMap();
let settledPromises = new WeakSet();
let promiseHookStack = [];
let promiseHookStop;
let compositionRootCandidates = [];
let thenableWrapperRoots = new WeakSet();
let compositionRootClearQueued = false;
// Native combinators expose their inputs through ordinary thenable access, but do not expose the
// aggregate Promise itself. Keep the root Promises created in that same synchronous turn so a
// tracked input can identify the aggregate without replacing Promise or Promise.prototype.
function retainCompositionRootCandidate(promise) {
    compositionRootCandidates.push(promise);
    if (compositionRootClearQueued)
        return;
    compositionRootClearQueued = true;
    queueMicrotask(() => {
        compositionRootCandidates = [];
        compositionRootClearQueued = false;
    });
}
function installPromiseHook() {
    if (promiseHookStop || !nodePromiseHooks?.createHook)
        return;
    promiseHookStop = nodePromiseHooks.createHook({
        init(promise, parent) {
            if (parent)
                promiseParents.set(promise, parent);
            else
                retainCompositionRootCandidate(promise);
            for (const observer of observerRetainers.keys())
                observer.init?.(promise, parent);
        },
        before(promise) {
            promiseHookStack.push(promise);
            for (const observer of observerRetainers.keys())
                observer.before?.(promise);
        },
        after(promise) {
            for (const observer of observerRetainers.keys())
                observer.after?.(promise);
            promiseHookStack.pop();
        },
        settled(promise) {
            settledPromises.add(promise);
            const cause = promiseHookStack.at(-1);
            if (cause && cause !== promise)
                promiseSettlementCauses.set(promise, cause);
            for (const observer of observerRetainers.keys())
                observer.settled?.(promise);
        },
    });
}
export function retainPromiseObserver(observer) {
    observerRetainers.set(observer, (observerRetainers.get(observer) ?? 0) + 1);
    installPromiseHook();
}
export function releasePromiseObserver(observer) {
    const retained = observerRetainers.get(observer) ?? 0;
    if (retained <= 1)
        observerRetainers.delete(observer);
    else
        observerRetainers.set(observer, retained - 1);
    if (observerRetainers.size !== 0)
        return;
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
export function promiseSettlementCause(promise) {
    return promiseSettlementCauses.get(promise);
}
export function promiseDescendsFrom(promise, ancestor) {
    const visited = new Set();
    for (let current = promise; current && !visited.has(current); current = promiseParents.get(current)) {
        if (current === ancestor)
            return true;
        visited.add(current);
    }
    return false;
}
export function promiseCompositionRootCandidate() {
    const wrapper = compositionRootCandidates.at(-1);
    if (!wrapper)
        return undefined;
    thenableWrapperRoots.add(wrapper);
    const stack = new Error().stack ?? "";
    if (!/at (?:Promise|Function)\.(?:all|allSettled|any|race)\b/.test(stack))
        return undefined;
    for (let index = compositionRootCandidates.length - 2; index >= 0; index -= 1) {
        const candidate = compositionRootCandidates[index];
        if (!thenableWrapperRoots.has(candidate))
            return candidate;
    }
    return wrapper;
}
export function enclosingPromiseCombinatorRoot() {
    const stack = new Error().stack ?? "";
    if (!/at (?:Promise|Function)\.(?:all|allSettled|any|race)\b/.test(stack))
        return undefined;
    for (let index = compositionRootCandidates.length - 1; index >= 0; index -= 1) {
        const candidate = compositionRootCandidates[index];
        if (!settledPromises.has(candidate))
            return candidate;
    }
    return undefined;
}
//# sourceMappingURL=promise-coordinator.js.map