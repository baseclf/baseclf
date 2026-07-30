/**
 * Who a request is.
 *
 * V1 has no identity provider, so this file has exactly one honest answer:
 * anonymous. That is a stub in the sense that it will grow, not in the sense
 * that it is loose.
 *
 * In particular there is no header, query parameter or cookie that can change
 * the role. A development shortcut of that shape is how a staging convenience
 * becomes a production hole, and it would be live in every deployment between
 * now and V3. Callers that need to act as another role, which for now means
 * tests and the demo script, construct the context directly and never travel
 * over HTTP to do it.
 *
 * V3 replaces the source with a verified token. The shape it produces is
 * already fixed here, including the one thing that will not be added to it:
 * `user_metadata` has no home in `AuthCtx`, so a policy has nothing to read
 * even if someone later decides it would be convenient (rule 00, invariant I4).
 */

import { ANONYMOUS, type AuthCtx } from '../policy/types.js';

export function anonymousContext(): AuthCtx {
  return ANONYMOUS;
}

/** The claims a verified token is allowed to contribute. */
export interface VerifiedClaims {
  readonly sub?: unknown;
  readonly role?: unknown;
  readonly email?: unknown;
  readonly app_metadata?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Build a context from claims that have already had their signature checked.
 *
 * Not wired to a route yet. It exists now so that the shape, and the omission
 * of user metadata, are settled before there is any pressure to ship quickly.
 */
export function contextFromClaims(claims: VerifiedClaims): AuthCtx {
  const app =
    typeof claims.app_metadata === 'object' &&
    claims.app_metadata !== null &&
    !Array.isArray(claims.app_metadata)
      ? Object.freeze({ ...(claims.app_metadata as Record<string, unknown>) })
      : Object.freeze({});

  return Object.freeze({
    role: asString(claims.role) ?? ANONYMOUS.role,
    uid: asString(claims.sub),
    email: asString(claims.email),
    app,
  });
}
