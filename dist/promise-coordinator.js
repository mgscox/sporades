const nodePromiseHooks = process.getBuiltinModule("node:v8")?.promiseHooks;
const observerRetainers = new Map();
const promiseParents = new WeakMap();
const promiseSettlementCauses = new WeakMap();
const promiseCombinatorInputs = new WeakMap();
let settledPromises = new WeakSet();
let promiseHookStack = [];
let promiseHookStop;
let compositionRootCandidates = [];
let thenableWrapperRoots = new WeakSet();
const promiseCombinatorKinds = new WeakMap();
const promiseCombinatorNames = new Set(["all", "allSettled", "any", "race"]);
let compositionRootClearQueued = false;
// Find a native combinator frame (`at Promise.all`, `at Function.race`, ...) on the current
// synchronous stack. This reads V8's structured call sites instead of the formatted stack
// string: the hook calls it for every child Promise while retained, and formatting is costly
// because a Capsule loaded as a data: URL module embeds its whole source in every frame. It
// inspects the same frames the formatted stack held (Error.stackTraceLimit still applies) and,
// like the previous `at (?:Promise|Function).<name>` match, ignores `at async ...` frames.
function promiseCombinatorOnStack() {
    const prepareStackTrace = Error.prepareStackTrace;
    let callSites;
    Error.prepareStackTrace = (_error, sites) => sites;
    try {
        callSites = new Error().stack;
    }
    finally {
        Error.prepareStackTrace = prepareStackTrace;
    }
    if (!Array.isArray(callSites))
        return undefined;
    for (const site of callSites) {
        if (site.isAsync?.())
            continue;
        const name = site.getFunctionName();
        const type = site.getTypeName();
        if (name && promiseCombinatorNames.has(name) && (type === "Promise" || type === "Function"))
            return name;
    }
    return undefined;
}
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
            const combinator = parent ? promiseCombinatorOnStack() : undefined;
            if (parent && combinator) {
                const root = [...compositionRootCandidates].reverse().find((candidate) => !thenableWrapperRoots.has(candidate));
                if (root) {
                    promiseCombinatorKinds.set(root, combinator);
                    const inputs = promiseCombinatorInputs.get(root) ?? new Set();
                    inputs.add(parent);
                    promiseCombinatorInputs.set(root, inputs);
                }
            }
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
export function promiseDependsOn(promise, dependency) {
    const pending = promise ? [promise] : [];
    const visited = new Set();
    while (pending.length > 0) {
        const current = pending.pop();
        if (current === dependency)
            return true;
        if (visited.has(current))
            continue;
        visited.add(current);
        const parent = promiseParents.get(current);
        if (parent)
            pending.push(parent);
        if (["all", "allSettled"].includes(promiseCombinatorKinds.get(current) ?? "")) {
            pending.push(...(promiseCombinatorInputs.get(current) ?? []));
        }
    }
    return false;
}
export function promiseCompositionRootCandidate() {
    const wrapper = compositionRootCandidates.at(-1);
    if (!wrapper)
        return undefined;
    thenableWrapperRoots.add(wrapper);
    const combinator = promiseCombinatorOnStack();
    if (!combinator)
        return undefined;
    for (let index = compositionRootCandidates.length - 2; index >= 0; index -= 1) {
        const candidate = compositionRootCandidates[index];
        if (!thenableWrapperRoots.has(candidate)) {
            promiseCombinatorKinds.set(candidate, combinator);
            return candidate;
        }
    }
    promiseCombinatorKinds.set(wrapper, combinator);
    return wrapper;
}
export function promiseCombinatorKind(promise) {
    return promiseCombinatorKinds.get(promise);
}
export function enclosingPromiseCombinatorRoot() {
    if (!promiseCombinatorOnStack())
        return undefined;
    for (let index = compositionRootCandidates.length - 1; index >= 0; index -= 1) {
        const candidate = compositionRootCandidates[index];
        if (!settledPromises.has(candidate))
            return candidate;
    }
    return undefined;
}
//# sourceMappingURL=promise-coordinator.js.map