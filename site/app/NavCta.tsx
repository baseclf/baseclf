"use client";

import { useEffect, useState } from "react";

import { hasStoredSession } from "./studio/session";

/**
 * The landing's connect button, aware of this tab's Studio session.
 *
 * The session lives in sessionStorage, which the server cannot see, so the
 * server renders the signed-out label and this swaps after hydration. A tab
 * that already holds a proven session reads "Dashboard": the Studio it opens
 * reconnects from the stored pair by making the round trip again, so the
 * label is a shortcut, never a claim the page has not re-proven.
 */
export default function NavCta() {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setConnected(hasStoredSession());
  }, []);

  return (
    <a className="nav-cta" href="/studio?connect=1">
      {connected ? "Dashboard" : "Connect live"} <span aria-hidden="true">↗</span>
    </a>
  );
}
