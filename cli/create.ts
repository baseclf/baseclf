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
 *   1. **A project name.** It names three resources on the reader's own account, so
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
 * The name becomes a Worker script, a D1 database and an R2 bucket, and those three
 * do not share a naming rule. This project has not measured where each one draws
 * its line, and `CLAUDE.md` is explicit that an unmeasured limit is to be reported
 * as unknown rather than inferred.
 *
 * So the pattern is the conservative intersection: lowercase letters, digits and
 * hyphens, starting with a letter, ending with a letter or digit. It is narrower
 * than any of the three almost certainly allows. That costs a reader the occasional
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
        'has to suit three different services at once.',
    };
  }
  return { ok: true };
}

/** Whether one entry is an origin, and bare: a scheme and a host, with no path on the end. */
function checkOneOrigin(value: string): NameCheck {
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

/**
 * Whether an answer is one origin or a comma separated list of them.
 *
 * A list, because the engine already reads `BETTER_AUTH_TRUSTED_ORIGINS` as one and
 * a single-origin prompt forced a real choice nobody should face: the first person
 * to set up from the hosted Studio had to pick between the origin their app runs on
 * and the origin the Studio runs on, and whichever they dropped failed later with
 * an opaque CORS error.
 */
export function checkFrontendOrigin(value: string): NameCheck {
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => entry === '')) {
    return {
      ok: false,
      reason: 'That list has an empty entry in it. Drop the extra comma.',
    };
  }

  for (const entry of entries) {
    const verdict = checkOneOrigin(entry);
    if (!verdict.ok) {
      // Name the entry when there is more than one, so the reader fixes the right
      // part of the list instead of rereading all of it.
      return entries.length === 1
        ? verdict
        : { ok: false, reason: `In "${entry}": ${verdict.reason}` };
    }
  }

  return { ok: true };
}

export interface ResourceNames {
  readonly script: string;
  readonly database: string;
  readonly bucket: string;
}

/**
 * ⚠️ There is no KV namespace here, and there used to be.
 *
 * The plan this project started from listed one, and provisioning was written to
 * create it. Nothing reads it: `grep` over `src/` finds no `env.CACHE`, no
 * `KVNamespace`, and `Env` declares only `DB` and `BUCKET`. The JWKS caching that
 * KV was meant for uses the Cache API instead (`auth/verify.ts`), which is a
 * different decision made for a measured reason: KV has a sixty second minimum TTL
 * (`rules/02` section E).
 *
 * So creating one would put a resource on somebody's account, and a step in their
 * onboarding, for something that does not exist. It comes back when code that
 * reads it does, and not before.
 */

/**
 * The resource names, derived rather than asked for.
 *
 * More questions would buy nothing: nobody has an opinion about what the bucket
 * behind their deployment is called, and every extra field is another place to
 * stop. The bucket is suffixed rather than sharing the bare name, so an account
 * holding several of these is readable in the dashboard without opening anything.
 */
export function deriveResourceNames(project: string): ResourceNames {
  return {
    script: project,
    database: project,
    bucket: `${project}-objects`,
  };
}

/**
 * The bindings the Worker is deployed with.
 *
 * ⚠️ The binding NAMES are fixed and are not derived from the project name. `src/`
 * reads `env.DB` and `env.BUCKET` as literals, so a deployment whose bindings are
 * named after the project would upload cleanly, report success, and answer every
 * request with an undefined binding. That is the first of the four traps in
 * `cloudflare.ts`, reached from the other direction.
 *
 * 🔴 This is not hypothetical. On 2026-08-11 `wrangler r2 bucket create` offered to
 * add the binding to the config and suggested `baseclf_objects`, derived from the
 * bucket name. Accepting it deployed a Worker with no `env.BUCKET`, and nothing on
 * any surface said so. `rules/02` section B1.
 *
 * The resource id for each goes under a different field per type, which is why this
 * builds `ScriptBinding` values rather than raw objects: `BINDING_ID_FIELD` is the
 * one place that mapping is written down.
 */
export function bindingsFor(
  names: ResourceNames,
  databaseId: string,
  vars: Readonly<Record<string, string>>,
  /**
   * Whether the deployment already has a signing secret to carry forward.
   *
   * 🔴 Conditional, and getting this wrong breaks the first deployment anybody
   * makes. `uploadScript` always sends `bindings_inherit=strict`, which turns an
   * inherit that resolves to nothing into an **error** rather than a silent drop.
   * That is the behaviour that was wanted, and it means an unconditional inherit
   * fails on a script that does not exist yet, which is every first run.
   *
   * On a redeploy it is the opposite: the bindings array is what the deployment
   * ends up with, so a secret that is already set has to be named or it may not
   * survive. Whether an upload really drops one has not been measured; naming it
   * when it exists is correct either way, which is why the design does not depend
   * on knowing.
   */
  inheritSecret: boolean,
): readonly ScriptBinding[] {
  return [
    { kind: 'resource', type: 'd1', name: 'DB', id: databaseId },
    { kind: 'resource', type: 'r2_bucket', name: 'BUCKET', id: names.bucket },
    ...Object.entries(vars).map(([name, value]): ScriptBinding => ({ kind: 'text', name, value })),
    ...(inheritSecret
      ? [{ kind: 'inherit', name: SIGNING_SECRET_NAME } as const satisfies ScriptBinding]
      : []),
  ];
}

/** The one secret a deployment cannot start without. */
export const SIGNING_SECRET_NAME = 'BETTER_AUTH_SECRET';

/** The binding names `src/` reads. Exported so a test can hold them to the code. */
export const REQUIRED_BINDING_NAMES: readonly string[] = Object.freeze(['DB', 'BUCKET']);

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
/**
 * Where `baseclf studio` serves its pages, allowed on every deployment so the
 * Studio works without a config edit and a redeploy. An origin on this list
 * gets CORS answers and nothing else; every request still carries its own
 * credential, so allowing a localhost origin grants no access by itself.
 */
export const STUDIO_ORIGIN = 'http://localhost:4000';

export function varsFor(deploymentUrl: string, frontendOrigin: string): Record<string, string> {
  // The answer may be a comma separated list. Normalise the spacing, keep the
  // reader's order, and append the studio origin once rather than blindly: an
  // answer that already lists it must not produce a duplicate entry.
  const entries = frontendOrigin
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const origins = [...new Set([...entries, STUDIO_ORIGIN])].join(',');
  return {
    BETTER_AUTH_URL: deploymentUrl,
    BETTER_AUTH_TRUSTED_ORIGINS: origins,
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

/**
 * Read one line from the reader.
 *
 * Injected, because reading a line needs `node:` and the rest of this file is meant
 * to run in the same test runner as the engine. It returns the line raw, empty
 * included: deciding that an empty answer means the default is a decision, and
 * decisions belong on this side of the seam where they are covered. The Node shell
 * does the reading and nothing else.
 */
export type Ask = (prompt: string) => Promise<string>;

type Writer = (text: string) => void;

/**
 * How many times one question may be answered wrongly before this gives up.
 *
 * There is a cap because there has to be one. `ask` can be attached to something
 * that is not a person: a pipe that is already at end of file returns empty
 * forever, and without a bound that is a command that never returns and never says
 * why. Three is enough for a typo and few enough to notice.
 */
export const MAX_ANSWER_ATTEMPTS = 3;

/**
 * One question, with the reason it is being asked and the answer that is assumed.
 *
 * The reason is not decoration. `BUILD-PROGRESS` section V5 is explicit that every
 * field has to be able to say why it is needed, because a reader who cannot tell
 * what a question is for is a reader deciding whether to keep going.
 */
export function promptFor(question: string, why: string, fallback: string): string {
  return `${question}\n  ${why}\n  [${fallback}] `;
}

export type Collected =
  | { readonly ok: true; readonly answers: CreateAnswers }
  | { readonly ok: false; readonly lines: readonly string[] };

/**
 * Ask one question until the answer is usable, or until the attempts run out.
 *
 * An empty line takes the default, which is the convention every prompt follows and
 * is why `ask` hands the line back raw rather than deciding for itself.
 */
async function askUntilValid(
  ask: Ask,
  write: Writer,
  prompt: string,
  fallback: string,
  check: (value: string) => NameCheck,
): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_ANSWER_ATTEMPTS; attempt += 1) {
    const raw = (await ask(prompt)).trim();
    const value = raw === '' ? fallback : raw;

    const verdict = check(value);
    if (verdict.ok) return value;

    write(`  ${verdict.reason}`);
  }

  return null;
}

/**
 * The two questions, in order, with everything else decided elsewhere.
 *
 * Returns the refusal rather than throwing it, because running out of attempts is
 * not an error in the sense the error handler means: nothing went wrong, the
 * command simply has nothing to go on, and the exit code for that is the one that
 * says retrying the identical invocation will not help.
 */
export async function collectAnswers(ask: Ask, write: Writer): Promise<Collected> {
  const project = await askUntilValid(
    ask,
    write,
    promptFor(
      'Project name',
      'Names the database, the bucket and the Worker on your account.',
      DEFAULT_PROJECT_NAME,
    ),
    DEFAULT_PROJECT_NAME,
    checkProjectName,
  );

  if (project === null) return { ok: false, lines: [gaveUp('a project name')] };

  const frontendOrigin = await askUntilValid(
    ask,
    write,
    promptFor(
      'Frontend origin',
      'Browsers can call this API only from origins listed here. The default\n' +
        '  suits an app running on your machine, and nothing else. Comma separate\n' +
        '  more than one; include https://baseclf.dev to also manage this\n' +
        '  deployment from the hosted Studio.',
      DEFAULT_FRONTEND_ORIGIN,
    ),
    DEFAULT_FRONTEND_ORIGIN,
    checkFrontendOrigin,
  );

  if (frontendOrigin === null) return { ok: false, lines: [gaveUp('a frontend origin')] };

  return { ok: true, answers: { project, frontendOrigin } };
}

/**
 * What to say when the attempts run out.
 *
 * Names the flag as well as the failure, because the likeliest way to reach this is
 * not three typos: it is a script running the command with nothing on stdin, and
 * that reader needs the non-interactive way in rather than an invitation to try
 * again more carefully.
 */
function gaveUp(what: string): string {
  return (
    `Stopped after ${MAX_ANSWER_ATTEMPTS} attempts at ${what}. ` +
    'If you are running this from a script, pass the answers as arguments instead.'
  );
}

export interface CreatePlanStep {
  readonly title: string;
  /** What breaks if this step is skipped. Printed when a step fails. */
  readonly consequence: string;
  /**
   * What to say when this step fails and the run carries on regardless.
   *
   * Present on the one step whose failure still leaves a deployment that works, and
   * absent everywhere else because for every other step there is nothing to carry on
   * to. A test holds that count at one, so attaching these lines to a second step is
   * a decision somebody has to make on purpose rather than by copying a field.
   */
  readonly whenSkipped?: readonly string[];
}

/**
 * The order the steps run in, and it is not arbitrary.
 *
 * Three of the orderings are load-bearing:
 *
 *   - The **subdomain comes before the upload**, because `BETTER_AUTH_URL` is a var
 *     in the upload body and it is not knowable until the subdomain exists.
 *   - 🔴 The **secret is set after the upload**, which is the order the documented
 *     chain uses (`rules/02` section C, steps 5 then 7) and the only order that can
 *     work: a secret belongs to a script, so there is nothing to set one on until
 *     the script exists. An earlier version of this file had it the other way
 *     round, reasoning that the upload inherits the secret so the secret must come
 *     first. That reasoning is right about a redeploy and impossible on a first run,
 *     and a first run is the one every new reader does. `bindingsFor` takes whether
 *     to inherit rather than always doing it, which is what makes both orders work.
 *   - **Waiting comes last and is a step rather than a detail.** A new workers.dev
 *     URL answers 404, then 500, then 200, over about thirty seconds (`rules/02`
 *     section C2). Printing the URL and declaring success sends the reader to a 404
 *     at the exact moment they are deciding whether this product works.
 */
export const CREATE_PLAN: readonly CreatePlanStep[] = Object.freeze([
  { title: 'Check the Cloudflare login', consequence: 'nothing can be created without it' },
  { title: 'Create the database', consequence: 'the engine has nowhere to keep policies' },
  { title: 'Create the bucket', consequence: 'uploads have nowhere to go' },
  { title: 'Claim the workers.dev subdomain', consequence: 'the deployment has no address' },
  { title: 'Upload the Worker', consequence: 'nothing is deployed' },
  { title: 'Set the signing secret', consequence: 'the engine refuses every request' },
  { title: 'Turn on the workers.dev route', consequence: 'the address answers nothing' },
  // Easy to leave out, because a deployment without it looks completely healthy: every
  // request is answered correctly and the scheduled work simply never runs. Here that
  // is the rate limit sweep and the storage reconciliation, so the symptom arrives
  // months later as a table that grew without bound, with nothing pointing back at the
  // step that was skipped.
  //
  // 🔴 It is also the one step that does not stop the run, and it took a real account
  // to find out why it has to be. Cloudflare allows five cron triggers per account on
  // the free plan, counted across every Worker on it, so somebody who already has five
  // is refused here for a reason that has nothing to do with this deployment. By then
  // the database, the bucket, the Worker and the route are all up and the API answers.
  // Treating that as a failed run threw the address away with it, and the address is
  // the one thing in the whole plan a reader cannot work out for themselves. Measured
  // on 2026-08-15: eight steps green, no address printed, a working deployment that
  // read as a total failure.
  {
    title: 'Set the scheduled work',
    consequence: 'nothing is ever swept or reconciled',
    // Deliberately says nothing about which refusal this was. Cloudflare's own message
    // is printed on the line above and it names the cause; the cron limit one even
    // names the number and the plan. Repeating a guess at the cause here would be
    // wrong for every other way this call can fail, and this text cannot tell them
    // apart.
    whenSkipped: Object.freeze([
      'Everything else is deployed and the API answers. What is missing is the hourly',
      'sweep of the rate limit table and the reconciliation between the bucket and the',
      'database, so the cost of leaving it is a table that grows without bound, months',
      'from now.',
      '',
      'The line above is Cloudflare refusing, and it gives the reason. Deal with that,',
      'then run this again to add the schedule. Nothing created so far is lost.',
    ]),
  },
  { title: 'Wait for the address to answer', consequence: 'the first visit lands on a 404' },
]);

/**
 * The schedule the Worker's `scheduled` handler expects, matching `wrangler.jsonc`.
 *
 * Seventeen past the hour rather than on the hour: everything on the platform that
 * runs hourly runs at zero, and a sweep that competes with that queue for a
 * single-threaded database is a sweep that takes longer for no reason.
 */
export const CREATE_CRONS: readonly string[] = Object.freeze(['17 * * * *']);

/**
 * The compatibility date the Worker bundle was built against.
 *
 * ⚠️ Not a default and not today's date. `rules/02` section B records that an upload
 * without one is dated **2021-11-02**, and every API the engine depends on behaves
 * differently there. It has to match what the bundle was compiled with, so
 * `scripts/build-cli.mjs` fails the build when this and `wrangler.jsonc` disagree.
 */
export const CREATE_COMPATIBILITY_DATE = '2026-07-28';
