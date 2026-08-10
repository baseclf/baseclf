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
import type { VerifierConfig } from './verify.js';

/** The role every verified session carries. See decision 1 above. */
export const AUTHENTICATED_ROLE = 'authenticated';

export interface AuthEnv {
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
 * Read the settings, or refuse.
 *
 * Deliberately strict. Better Auth will accept a missing base URL and infer one
 * per request, which is convenient and is also how `redirect_uri_mismatch`
 * becomes somebody's afternoon. See the auth skill, trap 1.
 */
export function authSettings(env: AuthEnv): AuthSettings {
  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (!secret) {
    throw misconfigured('BETTER_AUTH_SECRET is not set. Set it with `wrangler secret put`.');
  }

  const baseURL = env.BETTER_AUTH_URL?.trim();
  if (!baseURL) {
    throw misconfigured('BETTER_AUTH_URL is not set. It must be the origin this Worker serves.');
  }

  const trustedOrigins = (env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return {
    secret,
    baseURL,
    trustedOrigins,
    emailAndPassword: env.BETTER_AUTH_EMAIL_PASSWORD?.trim().toLowerCase() === 'true',
  };
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
          definePayload: ({ user }) => ({
            email: user.email,
            role: AUTHENTICATED_ROLE,
            // Server-written only. `user_metadata` has no equivalent here and
            // never will: rule 00 invariant I4.
            app_metadata: {},
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

let cached: { readonly settings: AuthSettings; readonly instance: AuthInstance } | null = null;

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

  if (
    cached !== null &&
    cached.settings.secret === settings.secret &&
    cached.settings.baseURL === settings.baseURL
  ) {
    return cached.instance;
  }

  const instance = buildAuth(env, settings);
  cached = { settings, instance };
  return instance;
}

/** What the edge verifier needs in order to check a token from this issuer. */
export function verifierConfig(env: AuthEnv): VerifierConfig {
  const { baseURL } = authSettings(env);

  return {
    jwksUrl: `${baseURL}/api/auth/jwks`,
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
