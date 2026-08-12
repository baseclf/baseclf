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
 * No backoff on a failure. A retry that waits is a window in which a repaired
 * deployment is still refusing, and this memo already limits the rate by sharing the
 * attempt in flight.
 *
 * ## Expiry, which is a different thing
 *
 * `maxAgeMs` is not a backoff and the two pull in opposite directions. A backoff would
 * make failures rarer and repairs slower; expiry makes success **shorter lived**, so a
 * change to the underlying data lands within a known window instead of whenever the
 * isolate happens to recycle. That is debt F2, and `MAX_REGISTRY_AGE_MS` below is the
 * bound it did not have.
 *
 * Omit it for anything that cannot change under a running isolate. The catalogue does
 * not use it: a schema change already has `resetCatalogue`, and expiring it would
 * repeat the PRAGMA sweeps rather than three small queries.
 *
 * ## What it does not do
 *
 * It does not re-run the loader when the arguments change. `getRegistry(session)` takes
 * a per-request session and only the first one ever runs, which is safe because what
 * these loaders return is data rather than a live handle. Preserved rather than
 * improved: it is the behaviour every caller already had.
 */

/**
 * How long a loaded registry may go without being read again.
 *
 * 🔴 This is the bound debt F2 did not have. Nothing reads
 * `_exposed_tables.version`, so before this a policy change landed only when the
 * isolate happened to recycle. Measured against a live deployment on 2026-08-12: one
 * run was still serving a table 393 seconds after `baseclf policy rm` reported success,
 * another stopped after 57, with nothing changed between them. An operator narrowing a
 * grant had no answer to "when does this take effect" other than "eventually".
 *
 * Thirty seconds turns that into an answer. It is a floor on nothing and a ceiling on
 * the window, which is the direction that matters: a change may land sooner, and it
 * cannot land later.
 *
 * ⚠️ Not free, and not expensive either. One reload is three queries against tables
 * with a handful of rows, per isolate, per thirty seconds. The catalogue is a separate
 * memo with no expiry, so a reload does not repeat the PRAGMA sweeps. On a quiet
 * deployment, where the same isolate lives for minutes, that is a few queries a
 * minute.
 *
 * ⚠️ It does not close the window for a change made **around** the engine. Somebody
 * editing `_policies` with `wrangler d1 execute` is inside this window too, but the
 * README is explicit that path bypasses everything, and nothing here changes that.
 *
 * Chosen rather than measured. Nobody has measured what this costs on a deployment
 * with real traffic, because there is no such deployment yet.
 */
export const MAX_REGISTRY_AGE_MS = 30_000;

export interface MemoOptions {
  /**
   * Reload once the value is older than this. Absent means keep it until `reset`,
   * which is right for anything that cannot change under the isolate.
   */
  readonly maxAgeMs?: number;
  /** The clock, injected so a test can observe the window without waiting for it. */
  readonly now?: () => number;
}

export interface IsolateMemo<T> {
  /** The memoised value, loading it first if there is nothing to return. */
  get(load: () => Promise<T>): Promise<T>;
  /** Drop it. For tests, and for the isolate that just changed the underlying data. */
  reset(): void;
}

export function isolateMemo<T>(options: MemoOptions = {}): IsolateMemo<T> {
  const maxAgeMs = options.maxAgeMs;
  const now = options.now ?? ((): number => Date.now());

  let cached: Promise<T> | null = null;
  let loadStartedAt = 0;

  const expired = (): boolean => maxAgeMs !== undefined && now() - loadStartedAt >= maxAgeMs;

  return {
    get(load: () => Promise<T>): Promise<T> {
      if (cached !== null && !expired()) return cached;

      // ⚠️ Stamped when the load begins rather than when it lands, so the age is how
      // stale the data may be rather than how long ago the promise settled. A load
      // that takes a second is already a second out of date by the time it arrives.
      //
      // ⚠️ And the expired value is dropped rather than served while a reload runs.
      // Serving it would be the stale-while-revalidate shape, which is the right
      // default almost everywhere and the wrong one here: what this memo holds is who
      // may read what, and a window that reopens whenever a reload is slow is not a
      // window. A reload that fails leaves nothing, so the request fails closed.
      loadStartedAt = now();

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
