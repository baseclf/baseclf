/**
 * `npx create-baseclf`: from nothing to a URL that answers.
 *
 * Onboarding is the product. Somebody who gives up at step three never sees the
 * policy engine, so the design rule for this file is the one in `BUILD-PROGRESS`
 * section V5: every field the reader has to fill in must be able to answer *why it
 * is needed*, and there must be as few of them as possible.
 *
 * ## Two questions, and what was cut
 *
 * There are two, and the reasoning for the cuts matters more than the two that
 * survived:
 *
 *   1. **A project name.** It names four resources on the reader's own account, so
 *      a default that collides would take over somebody else's deployment on the
 *      second run rather than making a second one.
 *   2. **The origin the frontend runs on.** Without it, a browser on any other
 *      origin cannot reach the deployment at all, and the symptom is an opaque CORS
 *      error rather than anything naming the setting. Measured against a real
 *      browser in `scripts/cors-browser-check/`.
 *
 * **The credential is not a question.** Measured on a real account on 2026-08-11
 * (`rules/02` section C3): the OAuth flow Cloudflare already ships covers Workers,
 * D1, KV and R2, so this shells out to `wrangler login` and the token never leaves
 * the reader's machine. That is `FOUNDATION.md` section 6 as a mechanism rather
 * than as a promise.
 *
 * **The signing secret is not a question either.** It is a value nobody has an
 * opinion about, so asking for one invites a weak answer. It is generated here.
 *
 * **Which OAuth providers is deliberately NOT asked.** Setting one up means leaving
 * the terminal for a provider console, and that is exactly the step people abandon
 * (see the auth skill, trap 1). So the deployment is finished and answering first,
 * and the provider is the *next action* printed at the end with the exact redirect
 * URI to paste. A reader who stops there still has a working deployment.
 */

import type { ScriptBinding } from './cloudflare.js';

/**
 * What a project may be called, and why this is stricter than any one service.
 *
 * The name becomes a Worker script, a D1 database, a KV namespace title and an R2
 * bucket, and those four do not share a naming rule. This project has not measured
 * where each one draws its line, and `CLAUDE.md` is explicit that an unmeasured
 * limit is to be reported as unknown rather than inferred.
 *
 * So the pattern is the conservative intersection: lowercase letters, digits and
 * hyphens, starting with a letter, ending with a letter or digit. It is narrower
 * than any of the four almost certainly allows. That costs a reader the occasional
 * underscore and buys never discovering the real limit halfway through
 * provisioning, with two resources created and two not.
 *
 * ⚠️ If a name is ever rejected by Cloudflare despite matching this, that is a
 * measurement worth recording in `rules/02` rather than a pattern to widen.
 */
export const PROJECT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

/** Short enough to leave room for the suffixes below inside every service's limit. */
export const MAX_PROJECT_NAME_LENGTH = 40;

export const DEFAULT_PROJECT_NAME = 'baseclf';

/**
 * Where a frontend runs during development.
 *
 * ⚠️ Offered rather than assumed. Port 3000 is the default for this project's own
 * config and for most frontend dev servers, which is exactly why it is often already
 * taken (it was on the machine this was built on). A reader who is on another port
 * and accepts this default gets a working deployment their app cannot call, and the
 * browser will not say why.
 */
export const DEFAULT_FRONTEND_ORIGIN = 'http://localhost:3000';

export interface CreateAnswers {
  readonly project: string;
  readonly frontendOrigin: string;
}

export type NameCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Whether a project name can be used, with a reason a reader can act on.
 *
 * Returns the reason rather than a boolean because "invalid name" tells somebody
 * nothing about which character was the problem.
 */
export function checkProjectName(name: string): NameCheck {
  if (name.trim() !== name) {
    return { ok: false, reason: 'A project name cannot start or end with a space.' };
  }
  if (name.length < 3) {
    return { ok: false, reason: 'A project name needs at least 3 characters.' };
  }
  if (name.length > MAX_PROJECT_NAME_LENGTH) {
    return {
      ok: false,
      reason: `A project name can be at most ${MAX_PROJECT_NAME_LENGTH} characters.`,
    };
  }
  if (!PROJECT_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      reason:
        'A project name can use lowercase letters, digits and hyphens, and has to start ' +
        'with a letter. That is narrower than Cloudflare requires, on purpose: the name ' +
        'has to suit four different services at once.',
    };
  }
  return { ok: true };
}

/** Whether an origin is one, and bare: a scheme and a host, with no path on the end. */
export function checkFrontendOrigin(value: string): NameCheck {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return {
      ok: false,
      reason: 'That is not a URL. An origin looks like http://localhost:5173.',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'An origin has to be http or https.' };
  }

  // `URL.origin` drops any path, so a value with one would be silently trimmed and
  // the reader would never learn that the part they typed was ignored.
  if (parsed.origin !== value.trim().replace(/\/$/, '')) {
    return {
      ok: false,
      reason: `An origin is the scheme and host only. Try ${parsed.origin} without the rest.`,
    };
  }

  return { ok: true };
}

export interface ResourceNames {
  readonly script: string;
  readonly database: string;
  readonly namespace: string;
  readonly bucket: string;
}

/**
 * The four resource names, derived rather than asked for.
 *
 * Four more questions would buy nothing: nobody has an opinion about what the KV
 * namespace behind their deployment is called, and every extra field is another
 * place to stop. Suffixed rather than reusing the bare name for all four, because
 * an account holding several of these should be readable in the Cloudflare
 * dashboard without opening anything.
 */
export function deriveResourceNames(project: string): ResourceNames {
  return {
    script: project,
    database: project,
    namespace: `${project}-cache`,
    bucket: `${project}-objects`,
  };
}

/**
 * The bindings the Worker is deployed with.
 *
 * ⚠️ The binding NAMES are fixed and are not derived from the project name. `src/`
 * reads `env.DB`, `env.BUCKET` and `env.CACHE` as literals, so a deployment whose
 * bindings are named after the project would upload cleanly, report success, and
 * answer every request with an undefined binding. That is the first of the four
 * traps in `cloudflare.ts`, reached from the other direction.
 *
 * The resource id for each goes under a different field per type, which is why this
 * builds `ScriptBinding` values rather than raw objects: `BINDING_ID_FIELD` is the
 * one place that mapping is written down.
 */
export function bindingsFor(
  names: ResourceNames,
  databaseId: string,
  namespaceId: string,
  vars: Readonly<Record<string, string>>,
): readonly ScriptBinding[] {
  return [
    { kind: 'resource', type: 'd1', name: 'DB', id: databaseId },
    { kind: 'resource', type: 'kv_namespace', name: 'CACHE', id: namespaceId },
    { kind: 'resource', type: 'r2_bucket', name: 'BUCKET', id: names.bucket },
    ...Object.entries(vars).map(
      ([name, value]): ScriptBinding => ({ kind: 'text', name, value }),
    ),
    // The signing secret is set through the secrets endpoint rather than carried in
    // the upload body, so it has to be named here or the deploy would drop it.
    { kind: 'inherit', name: 'BETTER_AUTH_SECRET' },
  ];
}

/** The binding names `src/` reads. Exported so a test can hold them to the code. */
export const REQUIRED_BINDING_NAMES: readonly string[] = Object.freeze([
  'DB',
  'CACHE',
  'BUCKET',
]);

/**
 * The environment variables a deployment cannot start without.
 *
 * `BETTER_AUTH_URL` is the origin this Worker is served from, and getting it wrong
 * is the most common cause of `redirect_uri_mismatch`, so the engine refuses to
 * start rather than inferring one per request. It can only be known after the
 * workers.dev subdomain exists, which is why provisioning cannot be reordered to
 * upload first.
 *
 * Email and password sign-in is off, and that is a measurement rather than a
 * preference: hashing costs 58 ms of CPU against a free-plan budget of 10 ms for
 * the whole request. OAuth performs no hash, so social login works on any plan.
 */
export function varsFor(deploymentUrl: string, frontendOrigin: string): Record<string, string> {
  return {
    BETTER_AUTH_URL: deploymentUrl,
    BETTER_AUTH_TRUSTED_ORIGINS: frontendOrigin,
    BETTER_AUTH_EMAIL_PASSWORD: 'false',
  };
}

/** Bytes of entropy in the generated signing secret. */
export const SECRET_BYTES = 32;

/**
 * A signing secret nobody had to invent.
 *
 * Generated rather than asked for. A reader prompted for a secret types something
 * memorable, and a memorable signing key is the whole problem. `crypto` here is the
 * Web Crypto global, which exists in Node and in workerd, so this stays in the part
 * of the CLI the tests can run.
 */
export function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export interface CreatePlanStep {
  readonly title: string;
  /** What breaks if this step is skipped. Printed when a step fails. */
  readonly consequence: string;
}

/**
 * The order the steps run in, and it is not arbitrary.
 *
 * Three of the orderings are load-bearing:
 *
 *   - The **subdomain comes before the upload**, because `BETTER_AUTH_URL` is a var
 *     in the upload body and it is not knowable until the subdomain exists.
 *   - The **secret is set before the upload**, because the upload carries an
 *     `inherit` binding for it and `bindings_inherit=strict` makes an unresolvable
 *     one an error rather than a silent drop. Loud is what was wanted; failing is
 *     not, so the secret goes first.
 *   - **Waiting comes last and is a step rather than a detail.** A new workers.dev
 *     URL answers 404, then 500, then 200, over about thirty seconds (`rules/02`
 *     section C2). Printing the URL and declaring success sends the reader to a 404
 *     at the exact moment they are deciding whether this product works.
 */
export const CREATE_PLAN: readonly CreatePlanStep[] = Object.freeze([
  { title: 'Check the Cloudflare login', consequence: 'nothing can be created without it' },
  { title: 'Create the database', consequence: 'the engine has nowhere to keep policies' },
  { title: 'Create the cache namespace', consequence: 'signing keys are fetched every request' },
  { title: 'Create the bucket', consequence: 'uploads have nowhere to go' },
  { title: 'Claim the workers.dev subdomain', consequence: 'the deployment has no address' },
  { title: 'Set the signing secret', consequence: 'the engine refuses every request' },
  { title: 'Upload the Worker', consequence: 'nothing is deployed' },
  { title: 'Turn on the workers.dev route', consequence: 'the address answers nothing' },
  { title: 'Wait for the address to answer', consequence: 'the first visit lands on a 404' },
]);

