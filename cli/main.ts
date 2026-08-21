/**
 * Argument to exit code, with nothing platform-specific in it.
 *
 * The Node-specific part of this CLI is `bin.ts`, and it is four lines long. This
 * file holds everything else, takes its writer and its style as arguments, and
 * returns the exit code rather than calling `process.exit`. So the command can be
 * run in a test and its whole output asserted, which is the only way the voice rules
 * get checked on what a reader actually sees.
 *
 * Usage text lives here rather than in a help framework on purpose. There is one
 * command so far, and a framework that prints a generated summary would print
 * something less useful than a paragraph somebody wrote.
 */

// Same source as the Worker reports on /health, and for the same reason: a version
// typed by hand is right on the day it is typed. No import attribute, deliberately.
// See the note in `src/index.ts`.
import { version as BASECLF_VERSION } from '../package.json';
import { runDoctor } from './doctor.js';
import { LOGIN_FIXED_TEXT, type LoginHost, runLogin } from './login.js';
import { findVoiceViolations, type Style } from './output.js';
import { POLICY_FIXED_TEXT, type PolicyHost, runPolicy } from './policy.js';
import { renderReport } from './report.js';
import { CREATE_FIXED_TEXT, type CreateHost, runCreate } from './run-create.js';
import {
  type Host,
  NO_HOST,
  runSecretSet,
  SECRET_FIXED_TEXT,
  SECRET_USAGE,
  type SecretOutcome,
} from './secret.js';
import { runStudio, STUDIO_FIXED_TEXT, type StudioHost } from './studio.js';
import { runUser, USER_FIXED_TEXT } from './user.js';

export type Writer = (text: string) => void;
export type { LoginHost } from './login.js';
export type { PolicyHost } from './policy.js';
export type { CreateHost } from './run-create.js';
export type { Host } from './secret.js';

/** Exit codes, named so a script can be written against them. */
export const EXIT = Object.freeze({
  ok: 0,
  /** Something is wrong with the deployment. */
  problems: 1,
  /** Something is wrong with how the command was called. */
  usage: 2,
});

/**
 * What each outcome of a subcommand costs at the shell.
 *
 * Written as a map rather than decided at each return, because the distinction it
 * encodes is the interface: `usage` means retrying the identical command will not
 * help, and `problems` means the work was attempted and did not finish.
 */
const OUTCOME_EXIT: Readonly<Record<SecretOutcome, number>> = Object.freeze({
  ok: EXIT.ok,
  usage: EXIT.usage,
  failed: EXIT.problems,
});

const USAGE = [
  'baseclf: row-level security for Cloudflare D1',
  '',
  'Commands:',
  '  login              Log in to Cloudflare, and say which account you landed on',
  '  create             Create the resources and deploy the engine to your account',
  '  policy <verb>      Expose a table, list what is exposed, or stop exposing one',
  '  user set-app       Store server-set claims for one user, readable as $auth.app.*',
  '  studio             Start the local result bridge for the Studio simulator',
  '  doctor <url>       Ask a deployment what is wrong with it, and what to do about it',
  '  secret set <KEY>   Set one secret on a deployed Worker, reading the value from stdin',
  '',
  '  --version          Print the version of this CLI',
  '',
  'BaseCLF enforces policies on requests that go through your Worker. It does not',
  'enforce anything on `wrangler d1 execute`, which writes straight to the database.',
].join('\n');

/**
 * The argument list `create-baseclf` runs, from the one it was handed.
 *
 * `npx create-baseclf` resolves a package rather than a subcommand, so the verb is
 * chosen here instead of typed by the reader.
 *
 * ⚠️ Everything except the version flag, which has to reach the top level. Prepending
 * the verb sends it into the create option parser, which refuses it as an unknown
 * option, so asking the binary which version it is answered with an error. That was
 * true on the one binary that is the first thing anybody runs, and the version of a
 * cached `npx` package is exactly what somebody would be trying to find out.
 *
 * Lives here rather than in the binary so it can be tested. The binary is a top level
 * await, so importing it to test it would run the CLI.
 */
export function createArgv(args: readonly string[]): readonly string[] {
  const askedForVersion = args.length === 1 && (args[0] === '--version' || args[0] === '-v');
  return askedForVersion ? args : ['create', ...args];
}

/**
 * Run the CLI.
 *
 * Returns an exit code instead of setting one, so the whole thing is a function of
 * its arguments.
 */
export async function main(
  argv: readonly string[],
  write: Writer,
  style: Style,
  host: Host = NO_HOST,
  createHost?: CreateHost,
  loginHost?: LoginHost,
  policyHost?: PolicyHost,
  studioHost?: StudioHost,
): Promise<number> {
  const [command, ...rest] = argv;

  // ⚠️ Before the help branch, and printed bare so a script can read it.
  //
  // `npx` resolves a package once and then serves it from a cache, so the version
  // somebody is running is not the version on the registry, and until this existed
  // there was no way to ask. That is not hypothetical here: 0.1.0 could deploy a
  // Worker and had no way to write a policy into it, and anybody holding it in a
  // cache had nothing to compare against the fix.
  if (command === '--version' || command === '-v') {
    write(BASECLF_VERSION);
    return EXIT.ok;
  }

  if (command === undefined || command === '--help' || command === '-h') {
    write(USAGE);
    // Asking for help is not a mistake, so it is not an error code. Calling the
    // command with nothing is, because a script that did that by accident should
    // fail rather than look like it succeeded.
    return command === undefined ? EXIT.usage : EXIT.ok;
  }

  if (command === 'login') {
    if (loginHost === undefined) {
      write('baseclf login needs a runtime that can reach the network and run wrangler.');
      return EXIT.usage;
    }
    return OUTCOME_EXIT[await runLogin(rest, write, style, loginHost)];
  }

  if (command === 'policy') {
    if (policyHost === undefined) {
      write('baseclf policy needs a runtime that can reach the network and read files.');
      return EXIT.usage;
    }
    return OUTCOME_EXIT[await runPolicy(rest, write, style, policyHost)];
  }

  if (command === 'studio') {
    if (studioHost === undefined) {
      write('baseclf studio needs a runtime that can reach the network and bind a port.');
      return EXIT.usage;
    }
    return OUTCOME_EXIT[await runStudio(rest, write, style, studioHost)];
  }

  // The same host as `policy`, because it needs exactly the same reach: a file,
  // a credential, and the deployment's database over the REST API.
  if (command === 'user') {
    if (policyHost === undefined) {
      write('baseclf user needs a runtime that can reach the network and read files.');
      return EXIT.usage;
    }
    return OUTCOME_EXIT[await runUser(rest, write, style, policyHost)];
  }

  if (command === 'create') {
    if (createHost === undefined) {
      // Nothing to run it with means nothing was provisioned, and saying so beats a
      // crash on the first call into an undefined seam.
      write('baseclf create needs a runtime that can reach the network and read files.');
      return EXIT.usage;
    }
    return OUTCOME_EXIT[await runCreate(rest, write, style, createHost)];
  }

  if (command === 'secret') {
    const [verb, ...arguments_] = rest;

    // `set` is the only verb, and it is still required. A `secret` group that did
    // something when called with nothing would eventually do it when a script meant
    // to say `delete`, and there is no undo for either.
    if (verb !== 'set') {
      write(
        verb === undefined
          ? `baseclf secret needs a verb. The only one is "set".\n\n${SECRET_USAGE}`
          : `baseclf secret: there is no "${verb}" verb.\n\n${SECRET_USAGE}`,
      );
      return EXIT.usage;
    }

    return OUTCOME_EXIT[await runSecretSet(arguments_, write, style, host)];
  }

  if (command !== 'doctor') {
    write(`baseclf: there is no "${command}" command.\n\n${USAGE}`);
    return EXIT.usage;
  }

  const [url] = rest;
  if (url === undefined) {
    write(
      [
        'baseclf doctor needs the URL of the deployment to ask.',
        '',
        '  baseclf doctor https://baseclf-8f2c.raspy-firefly.workers.dev',
      ].join('\n'),
    );
    return EXIT.usage;
  }

  const report = await runDoctor(url);
  write(renderReport(report, style));

  return report.ok ? EXIT.ok : EXIT.problems;
}

/**
 * Every fixed string this command can print, for the voice rules to be checked
 * against.
 *
 * Exported rather than reached into by the test, so that adding a new block of text
 * means adding it here, and the check keeps covering everything. A checker that only
 * covers what somebody remembered to list is a checker that drifts.
 */
export const FIXED_TEXT: readonly string[] = Object.freeze([
  USAGE,
  ...SECRET_FIXED_TEXT,
  ...CREATE_FIXED_TEXT,
  ...LOGIN_FIXED_TEXT,
  ...POLICY_FIXED_TEXT,
  ...USER_FIXED_TEXT,
  ...STUDIO_FIXED_TEXT,
]);

/** The voice rules, over everything in `FIXED_TEXT`. Used by the tests. */
export function fixedTextViolations(): readonly string[] {
  return FIXED_TEXT.flatMap(findVoiceViolations);
}
