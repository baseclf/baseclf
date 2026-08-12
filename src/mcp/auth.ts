/**
 * Who may reach the MCP endpoint, and how a client finds that out.
 *
 * ## A shared secret, and why that is the right shape here
 *
 * The customer runs this deployment on their own Cloudflare account and is the only
 * user of it. There is no third party to authorise, no consent screen, and nobody to
 * issue tokens to but themselves. An OAuth authorization server for one person is
 * machinery guarding a door only its owner walks through.
 *
 * The spec agrees that far: authorization is OPTIONAL overall. What it does not offer
 * is a partial-compliance lane, so the parts that apply to a resource server still
 * apply. Verified against the `2026-07-28` spec on 2026-08-12:
 *
 *   - The server MUST implement RFC 9728 Protected Resource Metadata.
 *   - The server MUST validate that a token was issued for it, and MUST answer 401
 *     otherwise.
 *   - A 401 MUST carry a `WWW-Authenticate` challenge pointing at that metadata.
 *
 * All three are honoured below. What is honestly missing is an authorization server:
 * the metadata document advertises none, because there is none. That field is optional
 * in RFC 9728 and clients handle its absence (`@modelcontextprotocol/client` reads it
 * as `authorization_servers && length > 0`), so a client discovers the resource, finds
 * nothing to authorise against, and falls back to the token its operator gave it.
 *
 * ⚠️ **Not described here as OAuth, and it should never be.** It is a bearer token in
 * a spec-shaped wrapper. `rules/00` bans the reassuring sentence, and this file is
 * exactly where one would be tempting.
 */

import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';

/**
 * How long a verified static token is claimed to be good for.
 *
 * 🔴 This exists because the SDK refuses a token whose `expiresAt` is unset, which its
 * own documentation states plainly: bearer verification "rejects tokens whose
 * `AuthInfo.expiresAt` is unset (matches v1 behavior)". That check is written for OAuth
 * access tokens, which really do expire.
 *
 * A shared secret set with `wrangler secret put` does not expire, so any value here is
 * an assertion nobody can check. It is deliberately short rather than far in the
 * future: a client that caches the answer re-verifies within the minute, and the value
 * can never be mistaken for a real lifetime.
 *
 * ⚠️ It grants nothing. Rotating the secret revokes access at the next request,
 * whatever this says, because verification compares against the current secret every
 * time.
 */
const ASSERTED_LIFETIME_SECONDS = 60;

/** The scope a token has to carry. One scope, because there is one thing to do. */
export const MCP_SCOPE = 'mcp';

/** The client id reported for a token that is a shared secret rather than a client. */
const SHARED_SECRET_CLIENT_ID = 'baseclf-operator';

export interface McpAuthEnv {
  /** The shared secret. Absent means the MCP endpoint is off, not open. */
  readonly MCP_TOKEN?: string;
}

/**
 * Compare two secrets without letting the time taken say how much matched.
 *
 * `crypto.subtle.timingSafeEqual` needs equal-length buffers and throws otherwise,
 * which would itself be a length oracle. Hashing both sides first makes every
 * comparison the same length, so a wrong token of the wrong length is indistinguishable
 * from a wrong token of the right length.
 */
async function secretsMatch(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);

  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * The verifier the SDK's bearer middleware calls.
 *
 * ⚠️ Throws rather than returning null for an unknown token, because that is the
 * contract: the middleware turns a throw into a 401 with the challenge, and a returned
 * value into an authenticated request. Returning something falsy would be read as an
 * `AuthInfo`.
 *
 * 🔴 **It must be the SDK's `OAuthError`, not this project's error class**, and the
 * first version got that wrong. The middleware maps `OAuthError` with
 * `InvalidToken` to a `401` carrying the discovery challenge, and lets anything else
 * propagate: a `BaseclfError` came back as a **500**, so a wrong token was reported as
 * a broken deployment. The documentation says so, and the code still had to be run to
 * find out.
 *
 * ⚠️ A deployment with no `MCP_TOKEN` refuses everything. That is invariant I1 applied
 * to a new surface: an endpoint nobody configured is not an endpoint without a lock.
 *
 * ⚠️ Both refusals carry the same code and the same words. A message distinguishing
 * "no secret configured here" from "your secret is wrong" would tell an outsider which
 * deployments are worth guessing at.
 */
export function createTokenVerifier(env: McpAuthEnv, resource: URL) {
  return {
    async verifyAccessToken(token: string) {
      const expected = env.MCP_TOKEN;

      if (expected === undefined || expected === '') {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Not authorised.');
      }

      // Never the token, never its length, never how far it matched.
      if (!(await secretsMatch(token, expected))) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Not authorised.');
      }

      return {
        token,
        clientId: SHARED_SECRET_CLIENT_ID,
        scopes: [MCP_SCOPE],
        expiresAt: Math.floor(Date.now() / 1000) + ASSERTED_LIFETIME_SECONDS,
        // RFC 8707. Setting it means the SDK checks the token was meant for this
        // server rather than a different one, which is the audience validation the
        // spec requires of a resource server.
        resource,
      };
    },
  };
}

/**
 * The RFC 9728 document, built here rather than by the SDK helper.
 *
 * `oauthMetadataResponse` from the SDK serves both well-known documents, but it
 * requires `oauthMetadata` describing an authorization server, and there is not one.
 * Passing a fabricated one to reuse a helper would put a lie in a discovery document.
 *
 * `authorization_servers` is therefore absent rather than empty, which is what "there
 * is no authorization server" looks like in this format.
 */
export function protectedResourceMetadata(resource: URL): Record<string, unknown> {
  return {
    resource: resource.href,
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'BaseCLF',
  };
}
