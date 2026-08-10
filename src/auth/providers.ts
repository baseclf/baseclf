/**
 * Which social providers this deployment can actually offer.
 *
 * Three decisions here are worth stating, because each of them is the kind of
 * thing that gets "simplified" later by someone who does not know why it is
 * shaped this way.
 *
 * 1. **A missing provider is not an error.** `BETTER_AUTH_SECRET` missing is
 *    fatal, because a deployment that signs sessions with a guessable value
 *    looks like it works. Google being absent is just a deployment that does
 *    not offer Google. Nothing here ever throws.
 *
 * 2. **Half a provider is no provider, and it says so.** An id without a
 *    secret cannot complete a sign-in, so it is not handed to Better Auth. But
 *    dropping it silently is how an operator ends up staring at a login page
 *    with a button missing and no explanation anywhere. The status report
 *    exists so that the half-configured case is louder than the absent one.
 *
 * 3. **Names go out, values do not.** `providerStatuses` reports variable
 *    names and booleans only, because it feeds a public diagnostic endpoint.
 *    Credential values leave this module through exactly one function,
 *    `socialProviders`, whose only caller is the identity provider itself.
 *    That split is structural rather than a matter of remembering: the status
 *    type has nowhere to put a value.
 *
 * Everything here is a pure function over explicit arguments. The module knows
 * nothing about the worker's env type or the auth instance, so the diagnostic
 * endpoint and the identity provider can both use it without an import cycle.
 */

/** The providers this version knows how to configure. */
export type ProviderId = 'google' | 'github';

export const PROVIDER_IDS: readonly ProviderId[] = Object.freeze(['google', 'github'] as const);

/** For prose. The wire format uses the id. */
export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = Object.freeze({
  google: 'Google',
  github: 'GitHub',
});

/** The environment this module reads. A deliberate subset of the worker's env. */
export interface ProviderEnv {
  readonly GOOGLE_CLIENT_ID?: string;
  readonly GOOGLE_CLIENT_SECRET?: string;
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
}

/** What Better Auth needs per provider. Never leaves this process. */
export interface OAuthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The `socialProviders` option, holding only the providers that are complete. */
export type SocialProviders = { readonly [K in ProviderId]?: OAuthCredentials };

/**
 * What a provider looks like from outside.
 *
 * Note what is not here: no value, no length, no masked prefix, no "the secret
 * looks wrong". Presence and absence, and the names of the variables that
 * would fix the absence.
 */
export interface ProviderStatus {
  readonly provider: ProviderId;
  readonly configured: boolean;
  /** Names of the variables that are not set. Empty when configured. */
  readonly missing: readonly string[];
  /** The address to register in the provider's console. See the auth skill, trap 1. */
  readonly redirectUri: string;
}

type CredentialVars = {
  readonly id: keyof ProviderEnv;
  readonly secret: keyof ProviderEnv;
};

const CREDENTIAL_VARS: Readonly<Record<ProviderId, CredentialVars>> = Object.freeze({
  google: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
  github: { id: 'GITHUB_CLIENT_ID', secret: 'GITHUB_CLIENT_SECRET' },
});

/** Both variable names a provider needs, in the order an operator sets them. */
export const CREDENTIAL_VARIABLES: Readonly<Record<ProviderId, readonly string[]>> = Object.freeze({
  google: Object.freeze([CREDENTIAL_VARS.google.id, CREDENTIAL_VARS.google.secret]),
  github: Object.freeze([CREDENTIAL_VARS.github.id, CREDENTIAL_VARS.github.secret]),
});

/**
 * Where the identity provider is mounted.
 *
 * Duplicated from `AUTH_PREFIX` rather than imported, because importing it
 * would make this module depend on the module that will depend on it. The
 * callback path is part of a URL people paste into a third party's console, so
 * it is not going to move quietly.
 */
const CALLBACK_PATH = '/api/auth/callback';

function present(value: string | undefined): string | null {
  // A variable set to an empty string, or to the spaces left behind by a
  // copy-paste, is not configuration. Treating it as present produces a
  // sign-in that fails at the provider instead of a diagnosis that says which
  // variable to fix.
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}

/**
 * The bare origin of the configured base URL.
 *
 * `URL.origin` rather than string surgery, because the result is reported by a
 * public endpoint. A URL may carry credentials in front of the host, and
 * `https://operator:secret@host` trimmed of its trailing slash is still
 * `https://operator:secret@host`; reduced to an origin it is `https://host`.
 * It also normalises host case and drops a default port, so two spellings of
 * the same origin produce the same redirect URI.
 *
 * A value that is not a URL yields an empty string. The callback address built
 * from it is then visibly relative, which is honest: there is no usable
 * redirect URI for a deployment whose base URL is not an origin, and the
 * diagnostic report says exactly that.
 */
function origin(baseURL: string): string {
  try {
    const { origin } = new URL(baseURL.trim());
    return origin === 'null' ? '' : origin;
  } catch {
    return '';
  }
}

/**
 * The redirect URI for one provider.
 *
 * This exact string is what has to be pasted into the Google or GitHub console,
 * character for character. A trailing slash on the base URL would produce a
 * double slash here, which providers compare literally and reject, so it is
 * stripped.
 */
export function callbackUrl(baseURL: string, provider: ProviderId): string {
  return `${origin(baseURL)}${CALLBACK_PATH}/${provider}`;
}

/**
 * The providers that are completely configured, in the shape Better Auth takes.
 *
 * Only complete pairs appear. A provider with an id and no secret is absent
 * here and loud in `providerStatuses`.
 */
export function socialProviders(env: ProviderEnv): SocialProviders {
  const configured: { -readonly [K in ProviderId]?: OAuthCredentials } = {};

  for (const provider of PROVIDER_IDS) {
    const vars = CREDENTIAL_VARS[provider];
    const clientId = present(env[vars.id]);
    const clientSecret = present(env[vars.secret]);

    if (clientId !== null && clientSecret !== null) {
      configured[provider] = Object.freeze({ clientId, clientSecret });
    }
  }

  return Object.freeze(configured);
}

/**
 * Every provider, configured or not, and what it would take to configure it.
 *
 * Every provider is reported rather than only the configured ones: the point of
 * the report is the provider that is missing, and the redirect URI is needed
 * before the OAuth app exists, not after.
 */
export function providerStatuses(env: ProviderEnv, baseURL: string): readonly ProviderStatus[] {
  return Object.freeze(
    PROVIDER_IDS.map((provider) => {
      const vars = CREDENTIAL_VARS[provider];
      const missing: string[] = [];

      if (present(env[vars.id]) === null) missing.push(vars.id);
      if (present(env[vars.secret]) === null) missing.push(vars.secret);

      return Object.freeze({
        provider,
        configured: missing.length === 0,
        missing: Object.freeze(missing),
        redirectUri: callbackUrl(baseURL, provider),
      });
    }),
  );
}
