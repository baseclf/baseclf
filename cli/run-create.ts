/**
 * Run the plan in `create.ts`, from nothing to an address that answers.
 *
 * `create.ts` holds the decisions and this holds the order and the failure handling.
 * The split is not tidiness: the decisions are what a reader argues with, and keeping
 * them out of the part that makes network calls is what lets them be read and tested
 * without one.
 *
 * ## The two things that make a second run safe
 *
 * A first run is the run that gets interrupted, so every step below is safe to repeat.
 * Two of them are not obviously so:
 *
 *   1. 🔴 **The signing secret is generated only when there is not one already.**
 *      Regenerating it on a redeploy would invalidate every session and every token
 *      that was ever issued, which reads to a reader as "the update logged all my
 *      users out" and to us as a successful run. `scriptSecretNames` answers three
 *      ways and each needs different handling; the note on it has the detail.
 *   2. 🔴 **The upload inherits the secret only when the script already has it.**
 *      `bindings_inherit=strict` is always on, deliberately, because without it a
 *      binding that fails to resolve is dropped in silence. That is the behaviour we
 *      want and it means an unconditional `inherit` fails on a script that does not
 *      exist yet, which is every first run. Fixed in `0494e8a` after shipping it.
 *
 * ## What this file will not do
 *
 * It never prints the token, the signing secret, a prefix of either, or a length.
 * `rules/02` section C1 is the reason, and the reason is worth more than the rule: a
 * length narrows a guess, and a terminal ends up in a screenshot.
 */

import {
  type Account,
  CloudflareError,
  type Credentials,
  enableWorkersDev,
  ensureBucket,
  ensureDatabase,
  ensureSubdomain,
  explainCode,
  type Fetcher,
  listAccounts,
  putSchedules,
  putSecret,
  scriptSecretNames,
  uploadScript,
} from './cloudflare.js';
import {
  bindingsFor,
  CREATE_COMPATIBILITY_DATE,
  CREATE_CRONS,
  CREATE_PLAN,
  type CreateAnswers,
  collectAnswers,
  deriveResourceNames,
  generateSecret,
  SIGNING_SECRET_NAME,
  varsFor,
} from './create.js';
import { waitForDeployment } from './deploy.js';
import { nextAction, note, type Style, styledResultLine } from './output.js';
import {
  chooseCredential,
  type MachinePaths,
  readOAuthCredential,
  readWhoami,
  wranglerAuthPath,
} from './wrangler-credential.js';

type Write = (text: string) => void;

export type CreateOutcome = 'ok' | 'usage' | 'failed';

/** What the runtime provides that this file cannot reach for itself. */
export interface CreateHost {
  readonly fetcher: Fetcher;
  /** The Worker bundle, read from the installed package at the edge. */
  readonly readWorkerBundle: () => Promise<string>;
  /**
   * Run `wrangler whoami` and hand back what it printed.
   *
   * ⭐ Called for its side effect as much as its output. Measured on 2026-08-12: an
   * OAuth access token lasts one hour, and any wrangler command refreshes it and
   * rewrites the credential file. Reading the file without this first finds an
   * expired token for anybody who logged in earlier in the day, which is most people.
   *
   * Returns null when wrangler could not be run at all.
   */
  readonly refreshLogin: () => Promise<string | null>;
  /** The credential file, after the refresh. Undefined when there is none. */
  readonly readAuthFile: (path: string) => string | undefined;
  readonly paths: MachinePaths;
  /** A `.env` in the working directory, when there is one. */
  readonly envFile?: string | undefined;
  readonly now: () => Date;
  /** One line from the reader. */
  readonly ask: (prompt: string) => Promise<string>;
  /** Injected so a test does not spend the propagation grace period in real time. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export const CREATE_USAGE = [
  'npx create-baseclf',
  '',
  'Creates a database, a bucket and a Worker on your own Cloudflare account, and',
  'deploys the engine to them. Nothing goes anywhere else: the credential comes from',
  'the wrangler login already on this machine and never leaves it.',
  '',
  'Two questions, and both have a default. Run it again to update an existing',
  'deployment, which keeps the database, the bucket and the signing secret.',
  '',
  'BaseCLF enforces policies on requests that go through your Worker. It does not',
  'enforce anything on `wrangler d1 execute`, which writes straight to the database.',
].join('\n');

/**
 * Get a credential, or explain what to do about not having one.
 *
 * The refresh comes first and the read second, in that order, for the reason on
 * `refreshLogin`.
 */
async function resolveCredential(
  host: CreateHost,
  write: Write,
  style: Style,
): Promise<{ token: string; warnings: readonly string[] } | null> {
  const derived = wranglerAuthPath(host.paths);

  // 🔴 The file is read before wrangler is run, and the order is the whole point.
  //
  // An earlier version refreshed first, unconditionally, and that made a working
  // login depend on `npx wrangler` resolving. Measured on 2026-08-12 in a directory
  // with no local wrangler: `npx` goes to install the newest one, and that install
  // was broken at the time (wrangler 4.121.0 asks for a miniflare version that does
  // not exist). The result was a reader with a perfectly good credential being told
  // to log in.
  //
  // A token that is still good needs nothing run. The refresh below is for the case
  // it was written for, which is a token that has aged out of its hour.
  let oauth = readOAuthCredential(host.readAuthFile(derived), host.now(), derived);

  if (!oauth.ok) {
    const whoami = await host.refreshLogin();

    if (whoami === null) {
      write(styledResultLine('deny', 'That Cloudflare login needs refreshing, and wrangler', style));
      write(note('could not be run to do it. These logins last an hour.'));
      write(note(''));
      write(note('Run this once, then try again:'));
      write(note('  npx wrangler login'));
      return null;
    }

    // Only now is there an authoritative answer about where the file is, and it is
    // worth preferring: the derivation above copies wrangler's rule, and wrangler
    // saying so beats copying it correctly.
    const path = readWhoami(whoami).configPath ?? derived;
    oauth = readOAuthCredential(host.readAuthFile(path), host.now(), path);
  }

  const choice = chooseCredential(
    {
      fromEnvironment: host.paths.env.CLOUDFLARE_API_TOKEN,
      fromFile: readEnvFileToken(host.envFile),
    },
    oauth,
  );

  if (!choice.ok) {
    write(styledResultLine('deny', 'No Cloudflare login to use.', style));
    for (const line of choice.lines) write(note(line));
    return null;
  }

  return { token: choice.credential.token, warnings: choice.credential.warnings };
}

/**
 * `CLOUDFLARE_API_TOKEN` out of a `.env`, if it is in there.
 *
 * Deliberately not a parser. `cli/secret.ts` has one, and importing it here would tie
 * two commands together for one line of string handling.
 */
function readEnvFileToken(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const line = text.split(/\r?\n/).find((each) => /^\s*CLOUDFLARE_API_TOKEN\s*=/.test(each));
  if (line === undefined) return undefined;
  const value = line.slice(line.indexOf('=') + 1).trim();
  return value === '' ? undefined : value.replace(/^["']|["']$/g, '');
}

/**
 * Pick the account, or refuse when there is a choice to make.
 *
 * Refusing is the point. Somebody with a personal account and a work account gets
 * their deployment wherever the response happened to put it first, and finding out
 * costs them a resource on a bill that is not theirs.
 */
async function resolveAccount(
  host: CreateHost,
  token: string,
  write: Write,
  style: Style,
): Promise<Account | null> {
  const accounts = await listAccounts(host.fetcher, token);

  if (accounts.length === 0) {
    write(styledResultLine('deny', 'That login has no Cloudflare account on it.', style));
    return null;
  }

  if (accounts.length > 1) {
    write(styledResultLine('attention', 'That login can reach more than one account.', style));
    write(note('Pick one and pass it, so this does not deploy to the wrong bill:'));
    for (const account of accounts) write(note(`  ${account.name}`));
    write(note('Set CLOUDFLARE_ACCOUNT_ID to the id of the one you want, then run again.'));
    return null;
  }

  return accounts[0] ?? null;
}

interface StepContext {
  readonly credentials: Credentials;
  readonly answers: CreateAnswers;
}

/**
 * Everything the plan does, in the plan's order.
 *
 * ⚠️ The titles come from `CREATE_PLAN` rather than being written again here, and a
 * test holds the two lists to each other. Two copies of an ordering is how the
 * ordering drifts, and three of these orderings are load-bearing (see `CREATE_PLAN`).
 */
async function runPlan(
  host: CreateHost,
  context: StepContext,
  write: Write,
  style: Style,
): Promise<{ ok: true; url: string } | { ok: false }> {
  const { credentials, answers } = context;
  const names = deriveResourceNames(answers.project);

  let stepIndex = 0;
  const step = (): { title: string; consequence: string } => {
    const entry = CREATE_PLAN[stepIndex];
    stepIndex += 1;
    return entry ?? { title: 'Unnamed step', consequence: 'unknown' };
  };

  const fail = (
    entry: { title: string; consequence: string },
    reason: string,
    /** Cloudflare's own codes, when the failure came from it. */
    codes: readonly number[] = [],
  ): { ok: false } => {
    write(styledResultLine('deny', `${entry.title}: ${reason}`, style));
    write(note(`Without this, ${entry.consequence}.`));

    // Specific advice when there is any, and only then. A generic paragraph attached
    // to every failure teaches people to stop reading the ones that matter.
    const advice = explainCode(codes);
    for (const line of advice) write(line === '' ? '' : note(line));

    if (advice.length === 0) {
      write(note('Nothing here is undone by running it again. Fix the cause and rerun.'));
    }

    return { ok: false };
  };

  // Step 1 is the credential, and it already happened: there was nothing to check the
  // login with until it was resolved. Consuming its entry keeps the indexes honest.
  const login = step();
  write(styledResultLine('allow', login.title, style));

  try {
    const database = step();
    const { database: db, created: dbCreated } = await ensureDatabase(
      host.fetcher,
      credentials,
      names.database,
    );
    write(
      styledResultLine('allow', `${database.title}${dbCreated ? '' : ' (already there)'}`, style),
    );

    const bucket = step();
    const { created: bucketCreated } = await ensureBucket(host.fetcher, credentials, names.bucket);
    write(
      styledResultLine('allow', `${bucket.title}${bucketCreated ? '' : ' (already there)'}`, style),
    );

    const subdomain = step();
    const { subdomain: sub } = await ensureSubdomain(host.fetcher, credentials, answers.project);
    const url = `https://${names.script}.${sub}.workers.dev`;
    write(styledResultLine('allow', subdomain.title, style));

    // Asked before the upload because the answer decides what the upload contains.
    const existingSecrets = await scriptSecretNames(host.fetcher, credentials, names.script);
    const hasSigningSecret = (existingSecrets ?? []).includes(SIGNING_SECRET_NAME);

    const upload = step();
    await uploadScript(host.fetcher, credentials, {
      name: names.script,
      modules: [{ name: 'index.js', content: await host.readWorkerBundle() }],
      mainModule: 'index.js',
      compatibilityDate: CREATE_COMPATIBILITY_DATE,
      bindings: bindingsFor(names, db.uuid, varsFor(url, answers.frontendOrigin), hasSigningSecret),
    });
    write(styledResultLine('allow', upload.title, style));

    const secret = step();
    if (hasSigningSecret) {
      // Not regenerated, and this is the whole reason the check above exists. A new
      // signing secret invalidates every session and every token already issued.
      write(styledResultLine('allow', `${secret.title} (kept the existing one)`, style));
    } else {
      await putSecret(
        host.fetcher,
        credentials,
        names.script,
        SIGNING_SECRET_NAME,
        generateSecret(),
      );
      write(styledResultLine('allow', secret.title, style));
    }

    const route = step();
    await enableWorkersDev(host.fetcher, credentials, names.script);
    write(styledResultLine('allow', route.title, style));

    const schedules = step();
    await putSchedules(host.fetcher, credentials, names.script, CREATE_CRONS);
    write(styledResultLine('allow', schedules.title, style));

    const waiting = step();
    const outcome = await waitForDeployment(
      host.fetcher,
      url,
      // Spread rather than passed, because `exactOptionalPropertyTypes` makes an
      // explicit undefined a different thing from an absent key, and the default
      // timer only applies when the key is absent.
      host.sleep === undefined ? {} : { sleep: host.sleep },
    );

    if (outcome.kind === 'live') {
      write(styledResultLine('allow', waiting.title, style));
      return { ok: true, url };
    }

    if (outcome.kind === 'wrong-server') {
      return fail(waiting, `${url} is answering, but it is not this deployment.`);
    }

    // Deliberately not a failure. Everything is provisioned and a new address takes
    // about thirty seconds to propagate, sometimes longer, and `doctor` has more to
    // say about it than another poll here would.
    write(styledResultLine('attention', `${waiting.title}: not answering yet.`, style));
    write(note('Everything is deployed. New addresses take about thirty seconds.'));
    write(note(`Check it with: npx baseclf doctor ${url}`));
    return { ok: true, url };
  } catch (error) {
    return fail(
      CREATE_PLAN[Math.max(0, stepIndex - 1)] ?? {
        title: 'Provisioning',
        consequence: 'nothing is deployed',
      },
      error instanceof Error ? error.message : String(error),
      error instanceof CloudflareError ? error.codes : [],
    );
  }
}

/**
 * The command.
 *
 * Returns the outcome rather than an exit code, the same way `runSecretSet` does, so
 * the mapping from meaning to number stays in one place in `main.ts`.
 */
export async function runCreate(
  argv: readonly string[],
  write: Write,
  style: Style,
  host: CreateHost,
): Promise<CreateOutcome> {
  if (argv.includes('--help') || argv.includes('-h')) {
    write(CREATE_USAGE);
    return 'ok';
  }

  const unknown = argv.find((argument) => argument.startsWith('-'));
  if (unknown !== undefined) {
    write(`create-baseclf: there is no "${unknown}" option.\n\n${CREATE_USAGE}`);
    return 'usage';
  }

  const credential = await resolveCredential(host, write, style);
  if (credential === null) return 'failed';

  for (const warning of credential.warnings) write(note(warning));

  const account = await resolveAccount(host, credential.token, write, style);
  if (account === null) return 'failed';

  const collected = await collectAnswers(host.ask, write);
  if (!collected.ok) {
    for (const line of collected.lines) write(note(line));
    return 'usage';
  }

  const result = await runPlan(
    host,
    { credentials: { accountId: account.id, token: credential.token }, answers: collected.answers },
    write,
    style,
  );

  if (!result.ok) return 'failed';

  write(
    nextAction({
      goal: 'let people sign in',
      steps: [
        'Create an OAuth app with Google or GitHub.',
        'Paste this as the redirect URI, exactly as it is here:',
      ],
      copy: `${result.url}/api/auth/callback/google`,
      verify: `npx baseclf doctor ${result.url}`,
    }),
  );

  return 'ok';
}

/** Every fixed string this command can print, for the voice rules to check. */
export const CREATE_FIXED_TEXT: readonly string[] = Object.freeze([CREATE_USAGE]);
