type PromiseObserver = {
    init?: (promise: Promise<any>, parent?: Promise<any>) => void;
    before?: (promise: Promise<any>) => void;
    after?: (promise: Promise<any>) => void;
    settled?: (promise: Promise<any>) => void;
};
export declare function retainPromiseObserver(observer: PromiseObserver): void;
export declare function releasePromiseObserver(observer: PromiseObserver): void;
export declare function activePromise(): Promise<any> | undefined;
export declare function promiseSettlementCause(promise: Promise<any>): Promise<any> | undefined;
export declare function promiseDescendsFrom(promise: Promise<any> | undefined, ancestor: any): boolean;
export declare function promiseCompositionRootCandidate(): Promise<any> | undefined;
export declare function promiseCombinatorKind(promise: Promise<any>): "all" | "allSettled" | "any" | "race" | undefined;
export declare function enclosingPromiseCombinatorRoot(): Promise<any> | undefined;
export {};
//# sourceMappingURL=promise-coordinator.d.ts.map