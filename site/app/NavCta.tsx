"use client";

import { useEffect, useState } from "react";

import { onSessionChange } from "./studio/session";

/**
 * The landing's connect button, aware of the browser's Studio session.
 *
 * The session lives in localStorage, which the server cannot see, so the
 * server renders the signed-out label and this swaps after hydration - and
 * keeps listening, so a landing page already open updates the moment the
 * Studio connects or disconnects in another tab. "Dashboard" is a shortcut,
 * never a claim: the Studio it opens still re-proves the stored pair with a
 * real round trip.
 */
export default function NavCta() {
  const [connected, setConnected] = useState(false);

  useEffect(() => onSessionChange(setConnected), []);

  return (
    <a className="nav-cta" href="/studio?connect=1">
      {connected ? "Dashboard" : "Connect live"} <span aria-hidden="true">↗</span>
    </a>
  );
}
