/**
 * The tab's saved Studio session, so a reload does not sign the person out.
 *
 * sessionStorage on purpose, and the scope is the decision: it survives F5 in
 * this tab and is forgotten when the tab closes. Never localStorage - an admin
 * token on disk with no expiry is a different promise than the one the Studio
 * makes. Every reconnect is still proven by a real round trip before anything
 * trusts it; the stored copy only spares the retyping.
 *
 * Shared out of StudioApp so the landing's nav can ask "is this tab signed
 * in" without pulling the whole Studio into its bundle.
 */

const SESSION_KEY = "baseclf-studio-session";

export interface StoredSession {
  readonly url: string;
  readonly token: string;
  readonly bridgeKey: string;
}

export function readStoredSession(): StoredSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.url !== "string" || typeof parsed.token !== "string") return null;
    return { url: parsed.url, token: parsed.token, bridgeKey: typeof parsed.bridgeKey === "string" ? parsed.bridgeKey : "" };
  } catch {
    return null;
  }
}

export function writeStoredSession(session: StoredSession): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Storage can be unavailable; the in-memory session still serves this page.
  }
}

export function clearStoredSession(): void {
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing stored is nothing to clear.
  }
}

/** Whether this tab holds a saved session, for surfaces that only need yes or no. */
export function hasStoredSession(): boolean {
  return readStoredSession() !== null;
}
