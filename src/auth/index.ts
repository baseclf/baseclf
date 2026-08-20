/**
 * The identity provider, configured once and built lazily.
 *
 * Three decisions here are security decisions rather than configuration:
 *
 * 1. **The role is not read from the user record.** Better Auth's `user` table
 *    holds fields the user can edit through the account endpoints, so a role
 *    stored there would be a role the user could grant themselves. That is rule
 *    00 invariant I4 wearing a different hat, and it is the exact escalation
 *    the invariant exists to prevent. Every verified session is
 *    `authenticated`, full stop. Finer roles need a store only the server can
 *    write, and that store does not exist yet, so neither do finer roles.
 *
 * 2. **`role` and `app_metadata` must be put into the token deliberately.** The
 *    default payload has neither, which does not fail: verification succeeds,
 *    the subject arrives, and the policy engine sees no role and falls back to
 *    anon. A signed-in user would silently get the public view. `definePayload`
 *    is what closes that, and it only takes effect nested under `jwt`.
 *
 * 3. **A missing secret is fatal, not a default.** A deployment that signs
 *    sessions with a value somebody could guess is worse than one that refuses
 *    to start, because it looks like it is working.
 *
 * The instance is memoised per isolate and built inside `fetch`. Module scope
 * gets one second of CPU on Workers and this is not where to spend it.
 */

import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { bearer, jwt } from 'better-auth/plugins';

import { BaseclfError } from '../utils/errors.js';
import { logEvent } from '../utils/log.js';
import { readAppMetadata } from './app-metadata.js';
import { type ProviderEnv, socialProviders } from './providers.js';
import type { VerifierConfig } from './verify.js';

/** The role every verified session carries. See decision 1 above. */
export const AUTHENTICATED_ROLE = 'authenticated';

export interface AuthEnv extends ProviderEnv {
  readonly DB: D1Database;
  /** Signs sessions. From `wrangler secret`, never from source. */
  readonly BETTER_AUTH_SECRET?: string;
  /** The origin this deployment is served from. Wrong value, broken OAuth. */
  readonly BETTER_AUTH_URL?: string;
  /** Comma separated origins allowed to call the auth endpoints. */
  readonly BETTER_AUTH_TRUSTED_ORIGINS?: string;
  /**
   * Opt in to email and password sign-in. Off unless set to `true`.
   *
   * Off by default because it cannot work on the plan most people start on.
   * Hashing a password costs 58 ms of CPU, measured, against a free-plan
   * request budget of 10 ms, and that is inherent to the scrypt parameters
   * rather than something an implementation can optimise away. OAuth performs
   * no hash, so social login works on any plan. Turning this on without a paid
   * plan produces sign-ups that fail for real users and nowhere else, which is
   * the worst way to find out. See the auth skill, trap 2.
   */
  readonly BETTER_AUTH_EMAIL_PASSWORD?: string;
}

export interface AuthSettings {
  readonly secret: string;
  readonly baseURL: string;
  readonly trustedOrigins: readonly string[];
  readonly emailAndPassword: boolean;
}

function misconfigured(detail: string): BaseclfError {
  // 500, not 401. Nothing the caller did caused this, and telling them to sign
  // in again would send them round a loop that cannot end.
  return new BaseclfError('UNAUTHENTICATED', 500, {
    message: 'Authentication is not configured.',
    detail,
  });
}

/**
 * What is configured, reported rather than judged.
 *
 * Separate from `authSettings` because the two callers want opposite things.
 * The request path wants a refusal: a deployment missing its secret must not
 * serve anything. The diagnostic endpoint wants an answer, and it wants one
 * most urgently in exactly the case that makes `authSettings` throw. An
 * endpoint whose job is to explain a broken deployment cannot be an endpoint
 * that refuses to answer because the deployment is broken.
 *
 * Note what this reports about the secret: whether it is set, never anything
 * about its value. Presence is what an operator needs; validity is what an
 * attacker would like.
 */
export interface AuthConfig {
  readonly secretConfigured: boolean;
  /** As configured, trimmed. Empty when unset. Not validated here. */
  readonly baseURL: string;
  readonly trustedOrigins: readonly string[];
  readonly emailAndPassword: boolean;
}

export function authConfig(env: AuthEnv): AuthConfig {
  return {
    secretConfigured: (env.BETTER_AUTH_SECRET?.trim() ?? '').length > 0,
    baseURL: env.BETTER_AUTH_URL?.trim() ?? '',
    trustedOrigins: (env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    emailAndPassword: env.BETTER_AUTH_EMAIL_PASSWORD?.trim().toLowerCase() === 'true',
  };
}

/**
 * Read the settings, or refuse.
 *
 * Deliberately strict. Better Auth will accept a missing base URL and infer one
 * per request, which is convenient and is also how `redirect_uri_mismatch`
 * becomes somebody's afternoon. See the auth skill, trap 1.
 */
export function authSettings(env: AuthEnv): AuthSettings {
  const config = authConfig(env);

  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (!config.secretConfigured || secret === undefined) {
    throw misconfigured('BETTER_AUTH_SECRET is not set. Set it with `wrangler secret put`.');
  }

  if (config.baseURL.length === 0) {
    throw misconfigured('BETTER_AUTH_URL is not set. It must be the origin this Worker serves.');
  }

  return {
    secret,
    baseURL: config.baseURL,
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: config.emailAndPassword,
  };
}

/**
 * The claims a token mint reads for this user, or an empty object.
 *
 * A failed read is logged and answered with no claims rather than a failed
 * token. Absent claims only narrow what a `$auth.app.*` policy grants, so the
 * failure direction is closed; refusing the mint would take every policy down
 * with it. The log line is deliberate: silently missing claims is exactly how
 * V3 shipped tokens without a role, and a silence that costs correctness must
 * at least leave a trace.
 */
async function appClaims(env: AuthEnv, userId: string): Promise<Record<string, unknown>> {
  try {
    return await readAppMetadata(env.DB, userId);
  } catch (error) {
    logEvent({
      event: 'app_metadata_unavailable',
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return {};
  }
}

/**
 * The options, in one place.
 *
 * Separated from construction because the schema is derived from the options:
 * the jwt plugin owns the `jwks` table, so migrating with a different options
 * object than the instance uses creates a database that is missing a table
 * nobody notices until a token is requested and the endpoint answers 500 with
 * an empty body. Ask once, use for both.
 */
function authOptions(env: AuthEnv, settings: AuthSettings) {
  return {
    database: env.DB,
    secret: settings.secret,
    baseURL: settings.baseURL,
    trustedOrigins: [...settings.trustedOrigins],
    emailAndPassword: { enabled: settings.emailAndPassword },
    account: {
      /**
       * 🔴 A security trade, made deliberately, and the reason it is made is that
       * without it OAuth cannot complete at all for the front end this product is
       * built around.
       *
       * Better Auth stores the OAuth state twice: a row in `verification`, and a
       * signed cookie named `state`. The callback checks both. The sign-in that
       * created them was a cross-origin POST from the application, and this Worker
       * does not return `Access-Control-Allow-Credentials`, so the browser never
       * stored that cookie. At the callback there is nothing to compare against and
       * the reader is sent to `/api/auth/error?error=state_mismatch`, having just
       * authorised the application at the provider. Measured on a live deployment.
       *
       * ## What the cookie was protecting, and what is left
       *
       * It bound the callback to the same browser that began the flow. Without it,
       * login CSRF is possible in principle: an attacker starts a sign-in, obtains a
       * `code` and `state` for their own account, and gets a victim to load that
       * callback. The victim ends up signed in as the attacker, so whatever they
       * write next lands in the attacker's account.
       *
       * What still stands in the way:
       *
       *   - `state` is 32 random characters, and the verification row holding it is
       *     deleted the first time it is used, so a callback works exactly once
       *   - the row expires after ten minutes
       *   - `callbackURL` is validated against `trustedOrigins` when the sign-in is
       *     accepted, measured on a live deployment: `https://evil.example.com/steal`,
       *     `//evil.example.com/`, `/\/evil.example.com` and `https:/\/evil...` are
       *     each refused with 403 INVALID_CALLBACK_URL, so the redirect cannot be
       *     aimed anywhere the operator did not list
       *
       * ## Why this rather than the alternatives
       *
       * Better Auth makes the same trade itself: its `oauth-proxy` plugin passes
       * `skipStateCookieCheck: true` while keeping the origin check, for a situation
       * with the same shape. Allowing credentials instead would work today and bets
       * on third-party cookies, which browsers are removing. Serving the application
       * from this Worker's own origin needs no flag and no trade, and is the right
       * answer for anybody who can do it.
       *
       * ⚠️ This is a documented caveat, not a solved problem. The design that gives
       * the binding back without a cookie is a single use code exchanged over POST,
       * and that is the thing to build if this product ever carries something worth
       * more than a blog post.
       */
      skipStateCookieCheck: true,
    },
    // Only the providers whose id and secret are both present. Half a provider
    // is not offered, and `_diagnose` says which half is missing rather than
    // leaving somebody to work out why a button is not on the page.
    socialProviders: socialProviders(env),
    plugins: [
      // Tokens in a header rather than a cookie. The frontend is on another
      // origin, and a third-party cookie is blocked by Safari today and by
      // Chrome soon. See the auth skill, trap 3.
      bearer(),
      jwt({
        // ES256 rather than the EdDSA default, because these tokens are
        // verified by other people's code. Trap 4.
        jwks: { keyPairConfig: { alg: 'ES256' } },
        jwt: {
          // Nested here on purpose. At the top level this is accepted and
          // ignored, and the tokens come out without a role in them.
          definePayload: async ({ user }) => ({
            email: user.email,
            role: AUTHENTICATED_ROLE,
            // Server-written only, from `_app_metadata`, which nothing on the
            // HTTP surface can write: the operator sets it over their own
            // credential with `baseclf user set-app`. `user_metadata` has no
            // equivalent here and never will: rule 00 invariant I4.
            app_metadata: await appClaims(env, user.id),
          }),
        },
      }),
    ],
  };
}

/**
 * Create the tables Better Auth needs, using the same options as the instance.
 *
 * A one-time provisioning step, not something to put on the request path:
 * concurrent isolates would race each other. `better-auth migrate` cannot do
 * this because the CLI runs in Node and cannot reach a D1 binding, but the
 * programmatic API runs wherever it is called, including here.
 */
/**
 * The statements the migration would run, without running them.
 *
 * `runAuthMigrations` needs a D1 binding, and a binding only exists inside a
 * Worker, so it cannot reach the database of a deployment being provisioned
 * from the outside. This is the other half of that problem: emit the SQL here,
 * apply it with whatever does have reach.
 *
 * Derived from the same options as the instance, for the same reason as above.
 * A hand-written options object omits the jwks table the jwt plugin owns, and
 * the first symptom is the JWKS endpoint answering 500, which then makes every
 * token unverifiable while everything else looks healthy.
 */
export async function compileAuthMigrations(env: AuthEnv): Promise<string> {
  const migrations = await getMigrations(authOptions(env, authSettings(env)));
  return migrations.compileMigrations();
}

export async function runAuthMigrations(env: AuthEnv): Promise<readonly string[]> {
  const migrations = await getMigrations(authOptions(env, authSettings(env)));
  const created = migrations.toBeCreated.map((entry) => entry.table);
  await migrations.runMigrations();
  return created;
}

function buildAuth(env: AuthEnv, settings: AuthSettings) {
  return betterAuth(authOptions(env, settings));
}

type AuthInstance = ReturnType<typeof buildAuth>;

/**
 * What the instance was built from, reduced to something comparable.
 *
 * Provider ids are in here so that changing which providers exist rebuilds the
 * instance. Without that, a test that adds a provider would be served the
 * instance built before it and would pass while proving nothing, which is a
 * failure mode this project has already been bitten by twice.
 */
function fingerprint(settings: AuthSettings, env: AuthEnv): string {
  return [
    settings.secret,
    settings.baseURL,
    Object.keys(socialProviders(env)).sort().join('+'),
  ].join('\u0000');
}

let cached: { readonly fingerprint: string; readonly instance: AuthInstance } | null = null;

/** For tests, which need a fresh instance per fixture. */
export function resetAuth(): void {
  cached = null;
}

/**
 * The Better Auth instance for this deployment.
 *
 * Memoised against the settings rather than unconditionally, so a test that
 * changes them is not served a stale instance.
 */
export function getAuth(env: AuthEnv): AuthInstance {
  const settings = authSettings(env);
  const key = fingerprint(settings, env);

  if (cached !== null && cached.fingerprint === key) return cached.instance;

  const instance = buildAuth(env, settings);
  cached = { fingerprint: key, instance };
  return instance;
}

/** What the edge verifier needs in order to check a token from this issuer. */
export function verifierConfig(env: AuthEnv): VerifierConfig {
  const { baseURL } = authSettings(env);

  return {
    // Names the key set for the cache. Never requested. See `verify.ts`.
    keySetUrl: `${baseURL}/api/auth/jwks`,
    // Read in process, because the issuer is this same Worker. Going over the
    // network for it is what broke every token from V3 until 2026-08-15: a
    // Worker fetching its own `*.workers.dev` JWKS URL is answered 404, while
    // the same URL answers 200 from outside, so nothing looking from outside
    // could see it.
    readKeySet: () => getAuth(env).api.getJwks(),
    issuer: baseURL,
    // Better Auth sets `aud` to the base URL. Measured, not assumed: the token
    // contract in the skill used to claim a service name here.
    audience: baseURL,
  };
}

export const AUTH_PREFIX = '/api/auth/';

/** Whether a path belongs to the identity provider rather than to the engine. */
export function isAuthPath(pathname: string): boolean {
  return pathname === AUTH_PREFIX.slice(0, -1) || pathname.startsWith(AUTH_PREFIX);
}
