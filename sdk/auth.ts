/**
 * Signing in, and the two tokens that are not the same token.
 *
 * 🔴 **The flow here has three steps where the client this resembles has one**, and
 * every part of that was measured before this file existed (`sdk/auth-surface.test.ts`,
 * 2026-08-16). Copying `supabase-js` would produce calls this deployment does not
 * answer, so the shape follows the endpoints rather than the habit:
 *
 *   1. `POST /api/auth/sign-in/social` answers `{url}`. It does **not** redirect. The
 *      caller navigates, which is the only arrangement that also works in Node and in
 *      a Worker where there is no `window` to send anywhere.
 *   2. Signing in hands back a **session token in the `set-auth-token` header**, not
 *      in the body. A client reading only the body has a signed-in user and nothing
 *      to do with it, and the README already calls this the step people get stuck on.
 *   3. `GET /api/auth/token` exchanges that session for the **JWT**, and the JWT is
 *      the only one the policy engine verifies.
 *
 * ⚠️ **The JWT lasts 900 seconds. Measured, not assumed.** So it is exchanged again
 * rather than kept: a client that cached one would work for fifteen minutes and then
 * start failing, which is long enough to look like something else went wrong.
 *
 * ## Where the session is kept, and why nowhere else
 *
 * In memory, for the life of the client object. Not `localStorage`, and that is a
 * decision rather than an omission: a token in `localStorage` is readable by any
 * script that ends up on the page, which turns one cross-site scripting bug into a
 * stolen session. Persisting it is the application's call, made with knowledge of its
 * own threat model, so `setSession` takes one back and `getSession` hands one out.
 */

import { BaseclfRequestError, type FetchLike } from './errors.js';

/** Every provider the deployment can be configured with. */
export type Provider = 'google' | 'github';

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly name?: string;
  readonly emailVerified?: boolean;
  readonly image?: string | null;
}

export interface AuthResult<T> {
  readonly data: T | null;
  readonly error: BaseclfRequestError | null;
}

/**
 * How close to expiry a token gets re-exchanged.
 *
 * Sixty seconds out of the nine hundred a token lasts. Enough that a request in
 * flight cannot cross the boundary, small enough that it is not exchanging on every
 * other call.
 */
const REFRESH_MARGIN_SECONDS = 60;

/** The `exp` claim, or null when the token is not one this can read. */
function expiryOf(jwt: string): number | null {
  const [, payload] = jwt.split('.');
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: number;
    };
    return typeof claims.exp === 'number' ? claims.exp : null;
  } catch {
    return null;
  }
}

export class AuthClient {
  readonly #url: string;
  readonly #fetch: FetchLike;

  /** The long-lived one, from `set-auth-token`. Authenticates against the provider. */
  #session: string | null = null;
  /** The short-lived one, which is what the engine verifies. */
  #jwt: string | null = null;
  #jwtExpiresAt: number | null = null;

  /**
   * The clock, injected so a test can watch a token age out without waiting.
   *
   * Same reason `isolateMemo` takes one: the behaviour worth proving is what happens
   * at 900 seconds, and a test that waited for it would be a test nobody runs.
   */
  readonly #now: () => number;

  constructor(url: string, fetcher: FetchLike, now: () => number = () => Date.now()) {
    this.#url = url;
    this.#fetch = fetcher;
    this.#now = now;
  }

  async #call(path: string, init: RequestInit = {}): Promise<Response> {
    return this.#fetch(`${this.#url}${path}`, init);
  }

  /** Read a session token out of a response, if it carried one. */
  #capture(response: Response): void {
    const token = response.headers.get('set-auth-token');
    if (token !== null && token !== '') {
      this.#session = token;
      // Any cached JWT belongs to whoever was signed in a moment ago.
      this.#jwt = null;
      this.#jwtExpiresAt = null;
    }
  }

  async #failure(response: Response): Promise<BaseclfRequestError> {
    const text = await response.text();
    let message = `The request failed with ${response.status}.`;
    let code = 'AUTH_FAILED';
    try {
      const body = JSON.parse(text) as { message?: string; code?: string };
      if (typeof body.message === 'string') message = body.message;
      if (typeof body.code === 'string') code = body.code;
    } catch {
      // Not JSON. The status is the diagnosis.
    }
    return new BaseclfRequestError(message, code, response.status);
  }

  /**
   * Begin a social sign-in, and hand back the address to send the browser to.
   *
   * ⚠️ It does not navigate. A client that reached for `window.location` would work
   * in a page and throw everywhere else, and this is the same object an application
   * uses on its server.
   */
  async signInWithOAuth(options: {
    provider: Provider;
    callbackURL: string;
  }): Promise<AuthResult<{ url: string }>> {
    const response = await this.#call('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: options.provider, callbackURL: options.callbackURL }),
    });

    if (!response.ok) return { data: null, error: await this.#failure(response) };

    const body = (await response.json()) as { url?: string };
    if (typeof body.url !== 'string') {
      return {
        data: null,
        error: new BaseclfRequestError(
          'The deployment accepted the sign-in but did not answer with a URL. That usually ' +
            `means ${options.provider} is not configured on it.`,
          'AUTH_NO_URL',
          response.status,
        ),
      };
    }

    return { data: { url: body.url }, error: null };
  }

  /**
   * Sign in with an email and a password.
   *
   * ⚠️ Off on most deployments, and deliberately: hashing one password costs about
   * 58 ms of CPU and a free plan allows 10 ms per request, so it is switched off
   * unless somebody turned it on. A refusal here is usually that rather than a wrong
   * password.
   */
  async signInWithPassword(credentials: {
    email: string;
    password: string;
  }): Promise<AuthResult<{ user: AuthUser }>> {
    return this.#emailCall('/api/auth/sign-in/email', credentials);
  }

  async signUp(credentials: {
    email: string;
    password: string;
    name?: string;
  }): Promise<AuthResult<{ user: AuthUser }>> {
    return this.#emailCall('/api/auth/sign-up/email', credentials);
  }

  async #emailCall(
    path: string,
    body: Record<string, unknown>,
  ): Promise<AuthResult<{ user: AuthUser }>> {
    const response = await this.#call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) return { data: null, error: await this.#failure(response) };

    this.#capture(response);
    const parsed = (await response.json()) as { user?: AuthUser };
    return { data: { user: parsed.user as AuthUser }, error: null };
  }

  /**
   * Take a session token the application obtained for itself.
   *
   * The browser half of the OAuth flow ends at a callback this client never sees, so
   * an application that read `set-auth-token` there hands it back here. Passing null
   * is how it forgets one.
   */
  setSession(sessionToken: string | null): void {
    this.#session = sessionToken;
    this.#jwt = null;
    this.#jwtExpiresAt = null;
  }

  /** The session token this client is holding, for an application that persists it. */
  getSession(): string | null {
    return this.#session;
  }

  /**
   * Who is signed in, or nobody.
   *
   * 🔴 **Signed out is a 200 with a body of `null`, not a 401.** Measured. So a client
   * that treated any non-200 as "signed out" would be right by accident and wrong the
   * first time the deployment had a real problem, which is the case where somebody
   * needs to be told something is broken rather than that they are logged out.
   */
  async getUser(): Promise<AuthResult<{ user: AuthUser | null }>> {
    if (this.#session === null) return { data: { user: null }, error: null };

    const response = await this.#call('/api/auth/get-session', {
      headers: { authorization: `Bearer ${this.#session}` },
    });

    if (!response.ok) return { data: null, error: await this.#failure(response) };

    const body = (await response.json()) as { user?: AuthUser } | null;
    return { data: { user: body?.user ?? null }, error: null };
  }

  /**
   * The JWT the engine verifies, exchanged from the session and re-exchanged near
   * expiry.
   *
   * ⚠️ Measured at 900 seconds. A client that cached one would work for fifteen
   * minutes and then start failing, which is long enough that nobody suspects the
   * token.
   */
  async getToken(): Promise<string | null> {
    if (this.#session === null) return null;

    const now = Math.floor(this.#now() / 1000);
    if (
      this.#jwt !== null &&
      this.#jwtExpiresAt !== null &&
      this.#jwtExpiresAt - now > REFRESH_MARGIN_SECONDS
    ) {
      return this.#jwt;
    }

    const response = await this.#call('/api/auth/token', {
      headers: { authorization: `Bearer ${this.#session}` },
    });

    // ⚠️ Failing closed rather than keeping the old one. An expired token that is
    // still being sent produces a 401 from the engine, which reads as a policy
    // refusal rather than as a client that could not refresh.
    if (!response.ok) {
      this.#jwt = null;
      this.#jwtExpiresAt = null;
      return null;
    }

    const body = (await response.json()) as { token?: string };
    if (typeof body.token !== 'string') return null;

    this.#jwt = body.token;
    this.#jwtExpiresAt = expiryOf(body.token);
    return this.#jwt;
  }

  /** End the session. The token stops working, which is asserted rather than assumed. */
  async signOut(): Promise<{ error: BaseclfRequestError | null }> {
    if (this.#session === null) return { error: null };

    const response = await this.#call('/api/auth/sign-out', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#session}`, 'content-type': 'application/json' },
    });

    // Cleared whatever the deployment said. A client still holding a session it was
    // told to drop is worse than one that dropped a session the server kept.
    this.#session = null;
    this.#jwt = null;
    this.#jwtExpiresAt = null;

    return { error: response.ok ? null : await this.#failure(response) };
  }
}
