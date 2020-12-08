export interface Abortable {
    abort(): void;
}

export interface AbortablePromise<T> extends PromiseLike<T>, Abortable {}

/** Promise that rejects when aborted */
export interface AbortPromise extends AbortablePromise<never> {
    aborted: boolean;
}

/** Value an AbortPromise is rejected with when aborted. Use to distinguish aborts from regular errors */
export const ABORT = Symbol('[[ABORT]]');

/** Default implementation of an AbortPromise that has an abort() method */
class DefaultAbortPromise implements AbortPromise {
    public aborted: boolean = false;
    private p: Promise<never>;
    private triggerAbort: null | (() => void) = null;
    constructor() {
        this.p = new Promise<never>((_, reject) => {
            this.triggerAbort = () => {
                reject(ABORT);
                this.aborted = true;
                this.triggerAbort = () => {
                    // noop
                };
            };
        });
    }

    public abort() {
        if (this.triggerAbort != null) {
            this.triggerAbort();
        }
    }

    public then(
        onfulfilled?: ((value: never) => never | PromiseLike<never>) | undefined | null,
        onrejected?: ((reason: any) => never | PromiseLike<never>) | undefined | null
    ): Promise<never> {
        return this.p.then(onfulfilled, onrejected);
    }
}

/** Returns a new abort promise that never aborts */
export function neverAbort(): AbortPromise {
    return new DefaultAbortPromise();
}

/** Promise.race() with the given abort promise */
export function raceAbort<T>(promise: Promise<T>, abort?: AbortPromise): Promise<T> {
    if (abort == null) {
        return promise;
    }
    return Promise.race([promise, Promise.resolve(abort)]);
}

/** Helper to abort a set of asynchronous tasks */
export class AbortHandle implements Abortable {
    public aborted: boolean = false;
    private handles: Set<AbortPromise> = new Set();

    public get size() {
        return this.handles.size;
    }

    public abort = () => {
        this.aborted = true;
        for (const handle of this.handles.values()) {
            handle.abort();
        }
        this.handles.clear();
    };

    public withAbort = async <T>(fn: (abort: AbortPromise) => Promise<T>): Promise<T> => {
        if (this.aborted) {
            return Promise.reject(ABORT);
        }
        const abort = new DefaultAbortPromise();
        this.handles.add(abort);
        try {
            return await fn(abort);
        } finally {
            this.handles.delete(abort);
        }
    };

    public race<T>(p: Promise<T>): Promise<T> {
        return this.withAbort((abort) => raceAbort(p, abort));
    }
}

export function isAbortable<T>(promise: PromiseLike<T>): promise is AbortablePromise<any> {
    return typeof (promise as any).abort === 'function';
}

/** Similar to Promise.race(), but additionally aborts all abortable promises in the list after the first promise resolves or rejects */
export async function raceAll<T>(...promises: Promise<T>[]): Promise<T> {
    const abortAll = () => {
        for (const p of promises) {
            if (isAbortable(p)) {
                p.abort();
            }
        }
    };
    try {
        const result = await Promise.race(promises);
        abortAll();
        return result;
    } catch (e) {
        abortAll();
        throw e;
    }
}

export function withAbort<T>(fn: (abortHandle: AbortHandle) => Promise<T>): AbortablePromise<T> {
    const handle = new AbortHandle();
    const p = handle.race(fn(handle));
    p.then(handle.abort, handle.abort);
    return {
        then: p.then,
        abort: handle.abort,
    };
}
