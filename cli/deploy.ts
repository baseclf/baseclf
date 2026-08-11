/**
 * Waiting for a new address to answer, which is the last step and not a detail.
 *
 * A workers.dev URL does not work the moment `deploy` reports success. Measured on
 * a real first deployment (`rules/02` section C2): 404 with `error code: 1042`, then
 * 500, then 200, over about thirty seconds, while the subdomain endpoints already
 * reported the configuration was correct the whole time. Nothing was wrong. It had
 * simply not propagated.
 *
 * So printing the URL and declaring success sends the reader to a 404 at the exact
 * moment they are deciding whether this product works, having just spent five
 * minutes on it. That is the most expensive place in the whole flow to look broken,
 * which is why waiting is a step in the plan with its own line rather than something
 * folded into the deploy.
 *
 * ## What this refuses to do
 *
 * It does not report failure when the wait runs out. A deployment that has not come
 * up in the grace period may still be coming up, and `doctor` exists to say so with
 * more to go on. Calling it broken here would be a guess presented as a finding, and
 * the reader would go looking for a fault that is not there. It reports that it
 * stopped waiting, and what to run next.
 */

import { type Fetcher, isPropagating, PROPAGATION_GRACE_SECONDS } from './doctor.js';

/** How long between attempts. Short enough to feel prompt, long enough not to hammer. */
export const POLL_INTERVAL_MS = 3_000;

/** How long any one attempt may hang before it is abandoned and retried. */
export const ATTEMPT_TIMEOUT_MS = 10_000;

export type WaitOutcome =
  /** The address answered. The only outcome that lets the flow claim it is done. */
  | { readonly kind: 'live'; readonly attempts: number }
  /**
   * Still not answering when the wait ran out.
   *
   * Not a failure. See the note above: it may yet come up, and saying otherwise
   * sends the reader after a fault that may not exist.
   */
  | { readonly kind: 'still-waiting'; readonly attempts: number; readonly detail: string }
  /**
   * Answering, but with something this engine does not produce.
   *
   * A 403 or a 401 on `/health` means something else is serving the hostname, and
   * no amount of waiting changes that. Distinguished from the case above because
   * the advice is different: one is patience, the other is a real investigation.
   */
  | { readonly kind: 'wrong-server'; readonly status: number; readonly detail: string };

export interface WaitOptions {
  readonly graceSeconds?: number;
  readonly intervalMs?: number;
  /**
   * Injected so a test does not spend the grace period in real time.
   *
   * The default is a real timer. `rules/02` section A2 records that the clock in
   * the test runner is not frozen the way a deployed Worker's is, so a test that
   * waited would actually wait, and forty-five seconds of it.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Ask `/health` until it answers, or until the grace period is spent.
 *
 * Bounded by attempts rather than by a clock. The two are the same thing at a fixed
 * interval, and counting attempts is a property of the code while reading a clock
 * is a property of the machine. That distinction is what debt 24 was about.
 */
export async function waitForDeployment(
  fetcher: Fetcher,
  baseUrl: string,
  options: WaitOptions = {},
): Promise<WaitOutcome> {
  const graceSeconds = options.graceSeconds ?? PROPAGATION_GRACE_SECONDS;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const sleep = options.sleep ?? realSleep;

  const attempts = Math.max(1, Math.ceil((graceSeconds * 1_000) / intervalMs));
  const url = `${baseUrl.replace(/\/$/, '')}/health`;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // A network error is the same as a propagating status here: DNS for a brand new
    // hostname can fail to resolve before it starts working, and that is the same
    // condition wearing a different coat.
    const status = await statusOf(fetcher, url);

    if (status === 200) return { kind: 'live', attempts: attempt };

    if (status !== null && !isPropagating(status)) {
      return {
        kind: 'wrong-server',
        status,
        detail:
          `${url} answered ${status}, which is not a state this engine produces. ` +
          'Something else may be serving this hostname.',
      };
    }

    if (attempt < attempts) await sleep(intervalMs);
  }

  return {
    kind: 'still-waiting',
    attempts,
    detail:
      `${url} has not answered after ${graceSeconds} seconds. A new address usually ` +
      'takes about half that, so this may still be on its way rather than broken.',
  };
}

/** The status, or null when the request did not complete at all. */
async function statusOf(fetcher: Fetcher, url: string): Promise<number | null> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
    return response.status;
  } catch {
    return null;
  }
}
