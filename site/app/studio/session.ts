/**
 * The browser's saved Studio session, so signing in is a state and not a tab.
 *
 * localStorage on purpose, and the scope is the decision, made after the
 * tab-scoped version confused the first real user: they connected in one tab,
 * opened the landing in another, and were greeted as a stranger. Signed in
 * now means this browser, on every surface, until Disconnect - which is what
 * the person expected all along and what comparable dashboards do.
 *
 * Two guards temper what that costs. The pair expires seven days after it was
 * last proven, so an abandoned browser does not stay privileged forever; and
 * every reconnect is still proven by a real round trip before anything trusts
 * it - the stored copy only spares the retyping.
 *
 * Shared out of StudioApp so the landing's nav can ask "is this browser
 * signed in" without pulling the whole Studio into its bundle.
 */

const SESSION_KEY = "baseclf-studio-session";

/** How long a saved session may sit unused before it stops counting. */
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredSession {
  readonly url: string;
  readonly token: string;
  readonly bridgeKey: string;
}

interface StoredRecord extends StoredSession {
  readonly expiresAt: number;
}

export function readStoredSession(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StoredRecord>;
    if (typeof parsed.url !== "string" || typeof parsed.token !== "string") return null;
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= Date.now()) {
      clearStoredSession();
      return null;
    }
    return { url: parsed.url, token: parsed.token, bridgeKey: typeof parsed.bridgeKey === "string" ? parsed.bridgeKey : "" };
  } catch {
    return null;
  }
}

export function writeStoredSession(session: StoredSession): void {
  try {
    const record: StoredRecord = { ...session, expiresAt: Date.now() + SESSION_LIFETIME_MS };
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(record));
  } catch {
    // Storage can be unavailable; the in-memory session still serves this page.
  }
}

export function clearStoredSession(): void {
  try {
    window.localStorage.removeItem(SESSION_KEY);
    // The tab-scoped copy an earlier version kept; cleared so nothing stale
    // outlives a disconnect.
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing stored is nothing to clear.
  }
}

/** Whether this browser holds a saved session, for surfaces that only need yes or no. */
export function hasStoredSession(): boolean {
  return readStoredSession() !== null;
}

/**
 * Run `listen` whenever another tab signs in or out, and once for this tab.
 *
 * The `storage` event only fires for changes made by OTHER tabs, which is
 * exactly the case the per-tab version got wrong: a landing page already open
 * while the Studio connects next door. Returns the cleanup for an effect.
 */
export function onSessionChange(listen: (signedIn: boolean) => void): () => void {
  listen(hasStoredSession());
  const onStorage = (event: StorageEvent) => {
    if (event.key === SESSION_KEY || event.key === null) listen(hasStoredSession());
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
