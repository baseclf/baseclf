/**
 * A per-isolate memo that keeps a success and forgets a failure.
 *
 * ## Why this is a function and not four copies of six lines
 *
 * 🔴 It was four copies. Three of them were right and two were wrong, which is worse
 * than all of them being wrong, because the correct shape was written down in
 * `src/index.ts` with a comment explaining it while `getCatalogue` and
 * `getStorageRegistry` were still `cached ??= load(...)`.
 *
 * That form keeps a **rejected** promise, because a rejected promise is not null and
 * `??=` only replaces null. An isolate that saw one failure answers with that same
 * failure for as long as it lives, and repairing the cause does not help: what it
 * memoised was the failure, not the data. It was reported as debt F4 against the
 * policy registry, and it was never only there. The storage registry says in its own
 * comment that it copied the policy registry's shape deliberately, which is exactly
 * how it copied this too.
 *
 * The failure mode is worst in `getCatalogue`, which was not the one reported. It runs
 * PRAGMA sweeps, so it can fail for reasons that have nothing to do with the data: a
 * timeout, or the six-connection limit in `rules/02` section A. A transient error
 * became a permanent one.
 *
 * None of it is a leak. Every one of these fails closed. What it is is an outage that
 * outlives its cause, with no bound on it, and no way for an operator to end it.
 *
 * ## What a retry costs
 *
 * While the cause is still there, each attempt is real work against D1, which bills
 * for rows scanned. It is not once per request: an attempt in flight is already in the
 * memo, so concurrent callers share it and there is never more than one at a time. The
 * rate is bounded by how long a load takes rather than by how much traffic there is.
 *
 * No backoff. A timer is state to get right, and these memos sit on the path that
 * decides who may read what.
 *
 * ## What it does not do
 *
 * It does not re-run the loader when the arguments change. `getRegistry(session)` takes
 * a per-request session and only the first one ever runs, which is safe because what
 * these loaders return is data rather than a live handle. Preserved rather than
 * improved: it is the behaviour every caller already had.
 */

export interface IsolateMemo<T> {
  /** The memoised value, loading it first if there is nothing to return. */
  get(load: () => Promise<T>): Promise<T>;
  /** Drop it. For tests, and for the isolate that just changed the underlying data. */
  reset(): void;
}

export function isolateMemo<T>(): IsolateMemo<T> {
  let cached: Promise<T> | null = null;

  return {
    get(load: () => Promise<T>): Promise<T> {
      if (cached !== null) return cached;

      const attempt: Promise<T> = load().catch((cause: unknown) => {
        // ⚠️ Only when nothing has replaced it, which the obvious version of this
        // gets wrong. `reset` can run while a load is in flight, and the next call
        // then starts a fresh one. Clearing unconditionally would let the abandoned
        // load discard that newer one, which by then may already have succeeded, on
        // the strength of a failure nobody is waiting for.
        if (cached === attempt) cached = null;
        throw cause;
      });

      cached = attempt;
      return attempt;
    },

    reset(): void {
      cached = null;
    },
  };
}
