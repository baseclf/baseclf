"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  type DeploymentReading,
  readDeployment,
} from "../../lib/api/deployment";
import {
  getServerOrigin,
  getSharedOrigin,
  subscribeSharedOrigin,
} from "../connection";
import ExpansionShell from "../expansion/ExpansionShell";

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * The project overview, from the deployment's own answers.
 *
 * Everything here is public surface: /health for the running version,
 * /api/auth/_diagnose for what is configured and what it warns about, and
 * /_schema for the application tables. No token is involved; connecting in
 * the Studio only tells this page where the deployment is.
 */
export default function OverviewApp() {
  const origin = useSyncExternalStore(subscribeSharedOrigin, getSharedOrigin, getServerOrigin);

  return origin === null ? <DisconnectedOverview /> : <ConnectedOverview origin={origin} />;
}

function DisconnectedOverview() {
  return (
    <ExpansionShell active="Overview" title="Project overview" eyebrow="Your deployment">
      <div className="overview-heading">
        <div>
          <span className="expansion-kicker">Your backend</span>
          <h2>Ready to connect.</h2>
          <p>This page reads your own deployment: the running version, the exposed tables, and what the diagnostic warns about. Connect once in the Studio and it fills in.</p>
        </div>
        <div>
          <Link className="overview-secondary" href="/docs/quickstart">Quickstart</Link>
          <Link className="overview-primary" href="/studio">Connect in the Studio →</Link>
        </div>
      </div>
      <section className="next-step">
        <span>Next step</span>
        <div>
          <b>01</b>
          <p><strong>Connect to your Worker</strong><small>Open the Studio, choose Connect live, and enter your deployment URL. This page needs the URL only, never the token.</small></p>
          <Link href="/studio">Open the Studio →</Link>
        </div>
      </section>
      <div className="overview-lower">
        <section className="overview-panel">
          <header><span>What this page shows once connected</span><small>Public surface</small></header>
          <div className="activity-row"><span>/health</span><p><strong>The running version</strong><small>So you can tell a deployed fix from one still waiting.</small></p></div>
          <div className="activity-row"><span>/_schema</span><p><strong>Application tables</strong><small>Names and counts, never data.</small></p></div>
          <div className="activity-row"><span>_diagnose</span><p><strong>Configuration warnings</strong><small>Missing bindings, provider setup, trusted origins.</small></p></div>
        </section>
        <section className="overview-panel quick-actions">
          <header><span>Quick actions</span><small>Common tasks</small></header>
          <Link href="/studio">Test a policy <span>→</span></Link>
          <Link href="/studio/api">Send an API request <span>→</span></Link>
          <Link href="/docs/policies">Read policy basics <span>→</span></Link>
        </section>
      </div>
    </ExpansionShell>
  );
}

/** One finished read, remembering which request it answers. */
interface OverviewAnswer {
  readonly key: string;
  readonly reading?: DeploymentReading;
  readonly error?: string;
}

function ConnectedOverview({ origin }: { origin: string }) {
  const [answer, setAnswer] = useState<OverviewAnswer | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The answer carries the key of the request it belongs to, so switching
  // deployments needs no synchronous reset here: an answer for another key
  // simply is not current, and the loading state falls out of that.
  const requestKey = `${origin}#${attempt}`;
  useEffect(() => {
    let stale = false;
    void readDeployment(origin).then((finished) => {
      if (stale) return;
      setAnswer(
        finished.kind === "data"
          ? { key: requestKey, reading: finished.reading }
          : { key: requestKey, error: finished.message },
      );
    });
    return () => {
      stale = true;
    };
  }, [origin, requestKey]);

  const current = answer !== null && answer.key === requestKey ? answer : null;
  const reading = current?.reading ?? null;
  const error = current?.error ?? "";
  const host = hostOf(origin);

  return (
    <ExpansionShell active="Overview" title={host} eyebrow="Live / project overview" connection={host}>
      {error !== "" ? (
        <div className="overview-heading">
          <div>
            <span className="expansion-kicker">Your backend</span>
            <h2>The deployment did not answer.</h2>
            <p>{error}</p>
          </div>
          <div><button className="overview-primary" type="button" onClick={() => setAttempt((count) => count + 1)}>Try again</button></div>
        </div>
      ) : reading === null ? (
        <div className="overview-heading">
          <div>
            <span className="expansion-kicker">Your backend</span>
            <h2>Reading the deployment…</h2>
            <p>/health, /_schema and the auth diagnostic, straight from {host}.</p>
          </div>
        </div>
      ) : (
        <OverviewReading host={host} reading={reading} />
      )}
    </ExpansionShell>
  );
}

function OverviewReading({ host, reading }: { host: string; reading: DeploymentReading }) {
  const { health, diagnose, tables } = reading;
  const providers = Object.entries(diagnose.providers);
  const configured = providers.filter(([, provider]) => provider.configured);
  const bindingPresent = (name: string) =>
    diagnose.bindings.find((binding) => binding.name === name)?.present === true;

  const services: { name: string; ready: boolean; resource: string; detail: string; href: string; action: string }[] = [
    {
      name: "Instant API",
      ready: health.status === "ok",
      resource: `${tables.length} application ${tables.length === 1 ? "table" : "tables"}`,
      detail: `Serving /rest/v1 at version ${health.version}.`,
      href: "/studio/api",
      action: "Send a request",
    },
    {
      name: "Authentication",
      ready: diagnose.secret_configured && configured.length > 0,
      resource: configured.length > 0 ? configured.map(([name]) => name).join(", ") : "no provider configured",
      detail: diagnose.secret_configured ? "Signing secret set. Redirect URIs are in the Studio." : "The signing secret is not set.",
      href: "/studio",
      action: "Open the Studio",
    },
    {
      name: "Storage",
      ready: bindingPresent("BUCKET"),
      resource: bindingPresent("BUCKET") ? "R2 bucket bound" : "BUCKET binding missing",
      detail: bindingPresent("BUCKET")
        ? "Uploads and downloads answer under /storage/v1."
        : "The Worker has no BUCKET binding, so every storage request refuses.",
      href: "/docs",
      action: "Read the docs",
    },
    {
      name: "Database",
      ready: bindingPresent("DB"),
      resource: bindingPresent("DB") ? "D1 database bound" : "DB binding missing",
      detail: `The deployment answers as ${diagnose.base_url_actual === "" ? host : hostOf(diagnose.base_url_actual)}.`,
      href: "/studio",
      action: "Browse tables",
    },
  ];

  return (
    <>
      <div className="overview-heading">
        <div>
          <span className="expansion-kicker">Your backend</span>
          <h2>{diagnose.ok ? "Everything answers." : "Connected, with warnings."}</h2>
          <p>Read from {host} just now: version {health.version}, {tables.length} application {tables.length === 1 ? "table" : "tables"}, {diagnose.warnings.length === 0 ? "no warnings" : `${diagnose.warnings.length} ${diagnose.warnings.length === 1 ? "warning" : "warnings"}`}.</p>
        </div>
        <div>
          <Link className="overview-secondary" href="/docs/quickstart">Quickstart</Link>
          <Link className="overview-primary" href="/studio/api">Try the API →</Link>
        </div>
      </div>

      <section className="next-step">
        <span>Next step</span>
        <div>
          <b>01</b>
          {diagnose.warnings.length > 0 ? (
            <p><strong>Resolve the first warning</strong><small>{diagnose.warnings[0]}</small></p>
          ) : (
            <p><strong>Run a policy simulation</strong><small>The diagnostic has nothing to complain about. See what each role is shown next.</small></p>
          )}
          <Link href="/studio">Open the Studio →</Link>
        </div>
      </section>

      <div className="service-grid">
        {services.map((service) => (
          <article key={service.name}>
            <header><span>{service.name}</span><b className={service.ready ? "service-ready" : "service-review"}>{service.ready ? "Ready" : "Review"}</b></header>
            <h3>{service.resource}</h3>
            <p>{service.detail}</p>
            <Link href={service.href}>{service.action} →</Link>
          </article>
        ))}
      </div>

      <div className="overview-lower">
        <section className="overview-panel">
          <header><span>Attention required</span><small>{diagnose.warnings.length === 0 ? "none" : `${diagnose.warnings.length} from _diagnose`}</small></header>
          {diagnose.warnings.length === 0 ? (
            <div className="activity-row"><span>ok</span><p><strong>No warnings</strong><small>The diagnostic found nothing to raise.</small></p></div>
          ) : (
            diagnose.warnings.map((warning, index) => (
              <div className="activity-row" key={warning}><span>{String(index + 1).padStart(2, "0")}</span><p><strong>Warning</strong><small>{warning}</small></p></div>
            ))
          )}
        </section>
        <section className="overview-panel quick-actions">
          <header><span>Quick actions</span><small>Common tasks</small></header>
          <Link href="/studio">Test a policy <span>→</span></Link>
          <Link href="/studio/api">Send an API request <span>→</span></Link>
          <Link href="/docs/policies">Read policy basics <span>→</span></Link>
        </section>
      </div>
    </>
  );
}
