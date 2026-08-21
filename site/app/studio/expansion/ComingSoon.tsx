"use client";

import { ReactNode } from "react";

/**
 * The one wrapper for screens whose backend does not exist yet.
 *
 * Decision Q4: a screen with a real development path keeps its full visual as
 * a preview, but says so up front and stops pretending — the `inert` scope
 * disables every control inside it, which is what ends the fake toasts. The
 * banner reuses the planned pattern the Realtime concept already ships.
 *
 * `note` names the real path (the API or CLI capability this would be built
 * on), because "coming soon" without a mechanism is marketing. `action` is
 * for the one real thing a preview can still offer, like copying a CLI
 * command; it lives in the banner, outside the disabled scope.
 */
export default function ComingSoon({
  surface,
  note,
  action,
  children,
}: {
  surface: string;
  note: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div className="planned-banner">
        <span>COMING SOON</span>
        <p>
          <b>{surface} is not in this build.</b> The screen below is a design preview: every control is disabled and nothing reaches a deployment. {note}
        </p>
        {action}
      </div>
      <div className="planned-scope" inert>
        {children}
      </div>
    </>
  );
}
