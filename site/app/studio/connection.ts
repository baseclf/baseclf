/**
 * The deployment origin, shared between the Studio and its sibling routes.
 *
 * Overview and the API Explorer only need to know WHERE the deployment is:
 * everything they read (`/health`, `/api/auth/_diagnose`, `/_schema`) is public,
 * and every request the explorer sends is anonymous. So this store carries the
 * origin and nothing else. The admin token never enters it, never touches
 * sessionStorage, and stays where it was: in the Studio page's memory.
 *
 * sessionStorage is what lets the origin survive a full-page navigation
 * between routes. It is scoped to the tab and cleared when the tab closes,
 * which matches how long a Studio session means anything.
 */

const STORAGE_KEY = "baseclf-studio-origin";

let origin: string | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function read(): string | null {
  if (typeof window === "undefined") return null;
  if (!loaded) {
    loaded = true;
    try {
      origin = window.sessionStorage.getItem(STORAGE_KEY);
    } catch {
      origin = null;
    }
  }
  return origin;
}

export function getSharedOrigin(): string | null {
  return read();
}

export function setSharedOrigin(next: string | null): void {
  origin = next;
  loaded = true;
  try {
    if (next === null) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage can be unavailable; the in-memory value still serves this page.
  }
  for (const listener of listeners) listener();
}

export function subscribeSharedOrigin(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For useSyncExternalStore: the server never has a connection. */
export function getServerOrigin(): null {
  return null;
}
