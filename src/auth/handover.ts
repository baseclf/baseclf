/**
 * Hand the session to the page the provider sends the reader back to.
 *
 * ## The problem this exists for, measured rather than assumed
 *
 * Better Auth ends its OAuth callback with `setSessionCookie` and a redirect. For a
 * front end served from the deployment's own origin that is the whole story. For one
 * on another origin, which is the case this product is built around, it delivers
 * nothing usable:
 *
 *   1. The cookie belongs to the deployment's origin. Another origin cannot read it.
 *   2. It cannot send one either. This Worker deliberately withholds
 *      `Access-Control-Allow-Credentials`, because bearer tokens are the transport
 *      and ambient cookies are what that choice avoids.
 *   3. The redirect carries no token of its own.
 *   4. The bearer plugin does put `set-auth-token` on that response, but a browser
 *      following a redirect never gives the response to a page.
 *
 * So the page arrived signed out after a sign-in that worked, with nothing to read
 * and no error to show, and the reader blamed their provider account.
 *
 * ## Why a fragment
 *
 * The token goes in the URL fragment, `#session=...`, which is the one part of a URL
 * a browser does not send anywhere. Not to the server it is fetching, not in a
 * `Referer`, not into a proxy log. The application reads it and replaces the history
 * entry, which is what `examples/blog` does on load.
 *
 * ⚠️ It is still in that browser's history until the page replaces it, and a session
 * in history is worse than a session in memory. The stronger design is a single use
 * code exchanged for the session over POST, which never puts the credential in a URL
 * at all. That is more machinery than this, and it is the thing to build if sessions
 * here ever get long lived or start carrying more than they do now.
 *
 * ## Why appending it is safe
 *
 * Because the destination was already checked. `originCheckMiddleware` validates
 * `callbackURL` against `trustedOrigins` when the sign-in is accepted, and refuses
 * anything else with 403 `INVALID_CALLBACK_URL`. The value carried through the OAuth
 * state and arriving here is the one that passed that check, so this adds a token to
 * a response already destined for an origin the operator listed.
 *
 * Measured against a live deployment rather than read, across the shapes that would
 * matter, because `//host` is another origin wearing a relative path's clothes:
 *
 *   https://evil.example.com/steal   403 INVALID_CALLBACK_URL
 *   //evil.example.com/              403 INVALID_CALLBACK_URL
 *   /\/evil.example.com              403 INVALID_CALLBACK_URL
 *   https:/\/evil.example.com        403 INVALID_CALLBACK_URL
 *   /ok-relative                     accepted
 *
 * ⚠️ There is no second origin check here, on purpose. It would be a second
 * implementation of one judgement, which this project has paid for twice: `_diagnose`
 * and the CORS layer disagreeing about the same list sent an operator to fix a
 * configuration that was already correct. Re-run the five lines above instead.
 *
 * 🔴 That guarantee is the whole safety argument, and it lives in a dependency. If a
 * future version of Better Auth stops validating `callbackURL`, this turns an open
 * redirect into a session leak. The narrowing below is the second line of defence:
 * only the callback path, only a redirect, only when a session was actually created.
 */

/** Only the provider callback. Every other redirect this Worker makes is left alone. */
const CALLBACK_PREFIX = '/api/auth/callback/';

/** What the application reads the session out of. */
const FRAGMENT_KEY = 'session';

/**
 * Returns `response` unchanged unless it is an OAuth callback redirect carrying a
 * freshly created session, in which case the session is added to the target's
 * fragment.
 */
export function handOverSession(request: Request, response: Response): Response {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(CALLBACK_PREFIX)) return response;

  // A redirect and nothing else. The callback answers other things on the error
  // paths, and none of them should grow a session.
  if (response.status < 300 || response.status >= 400) return response;

  const location = response.headers.get('location');
  if (location === null || location === '') return response;

  // Absent when the callback did not establish a session, which is every failure
  // mode it has. No session, nothing to hand over.
  const token = response.headers.get('set-auth-token');
  if (token === null || token === '') return response;

  let target: URL;
  try {
    // `callbackURL` may be relative, which Better Auth allows and resolves against
    // the deployment. Resolving against the request keeps that working.
    target = new URL(location, request.url);
  } catch {
    // A Location this cannot parse is one to leave exactly as it is rather than
    // guess at. The reader still lands somewhere; they just land signed out.
    return response;
  }

  // Preserve a fragment the target already had rather than overwriting it. The
  // callbackURL is the application's own, and it may be routing on that fragment.
  const existing = target.hash.startsWith('#') ? target.hash.slice(1) : target.hash;
  const handed = `${FRAGMENT_KEY}=${encodeURIComponent(token)}`;
  target.hash = existing === '' ? handed : `${existing}&${handed}`;

  const headers = new Headers(response.headers);
  headers.set('location', target.toString());

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
