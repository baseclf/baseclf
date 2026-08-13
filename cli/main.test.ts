/**
 * The command as a function of its arguments.
 *
 * `main` returns an exit code and writes through a passed-in writer, so the whole
 * output can be asserted. That is the only way the voice rules get checked on what a
 * reader actually sees rather than on the pieces it is assembled from.
 *
 * The exit codes get their own tests because they are an interface. Somebody will
 * write `baseclf doctor "$URL" || exit 1` in a deploy script, and a command that
 * returns zero for a deployment nobody can sign in to makes that script a lie.
 */

import { describe, expect, it } from 'vitest';

import { version } from '../package.json';
import { createArgv, EXIT, fixedTextViolations, main } from './main.js';
import { findVoiceViolations, PLAIN } from './output.js';

async function run(...argv: readonly string[]): Promise<{ code: number; out: string }> {
  const written: string[] = [];
  const code = await main(argv, (text) => written.push(text), PLAIN);
  return { code, out: written.join('\n') };
}

describe('being called wrongly', () => {
  it('prints usage and fails when called with nothing', async () => {
    // A script that reached here by accident should fail rather than look like it
    // succeeded.
    const { code, out } = await run();

    expect(code).toBe(EXIT.usage);
    expect(out).toContain('doctor <url>');
  });

  it('answers which version it is, bare enough for a script to read', async () => {
    // ⚠️ `npx` resolves a package once and serves it from a cache afterwards, so the
    // version somebody is running is not the version on the registry. Until this
    // existed there was no way to ask: 0.1.0 could deploy a Worker and had no way to
    // write a policy into it, and anybody holding it had nothing to compare.
    for (const flag of ['--version', '-v']) {
      const { code, out } = await run(flag);

      expect(code).toBe(EXIT.ok);
      expect(out.trim()).toBe(version);
      // Bare, so `npx baseclf --version` is usable in a condition. A usage banner
      // here would mean every caller has to parse prose to get a number.
      expect(out).not.toContain('Commands:');
    }
  });

  it('lets create-baseclf answer the same question, without starting a project', async () => {
    // ⚠️ Missed on this binary while the other one was being fixed, and this is the
    // one somebody runs first. The verb is prepended for every other argument list,
    // which sent the flag into the create option parser and answered a question about
    // the version with "there is no --version option".
    for (const flag of ['--version', '-v']) {
      const { code, out } = await run(...createArgv([flag]));

      expect(code).toBe(EXIT.ok);
      expect(out.trim()).toBe(version);
    }

    // Anything else still gets the verb, or `npx create-baseclf` stops creating.
    expect(createArgv([])).toEqual(['create']);
    expect(createArgv(['--help'])).toEqual(['create', '--help']);
    expect(createArgv(['--version', '--yes'])).toEqual(['create', '--version', '--yes']);
  });

  it('prints usage and succeeds when help was what was asked for', async () => {
    // Asking for help is not a mistake.
    for (const flag of ['--help', '-h']) {
      expect((await run(flag)).code).toBe(EXIT.ok);
    }
  });

  it('names the command it does not have, rather than only printing usage', async () => {
    const { code, out } = await run('deploy');

    expect(code).toBe(EXIT.usage);
    expect(out).toContain('there is no "deploy" command');
  });

  it('says what doctor is missing, with an example that could be pasted', async () => {
    const { code, out } = await run('doctor');

    expect(code).toBe(EXIT.usage);
    expect(out).toContain('needs the URL');
    expect(out).toContain('https://');
  });

  it('separates a usage mistake from a broken deployment in the exit code', async () => {
    // Two different problems for the caller. A script that cannot tell "I called
    // this wrong" from "the deployment is broken" retries the wrong one.
    expect(EXIT.usage).not.toBe(EXIT.problems);
    expect(EXIT.ok).toBe(0);
  });
});

describe('being called for a deployment that is not there', () => {
  // An earlier version of this block pointed `doctor` at a real `.invalid` hostname
  // to watch it fail. It worked, and it was wrong for two reasons: the suite reached
  // the network, which makes it slow and dependent on DNS, and workerd logged four
  // uncaught rejections for the four probes, which is noise a reader has to learn to
  // ignore. Reaching the network from a test is also the thing this project's own
  // auth tests refuse loudly.
  //
  // What that test was really checking is that `main` maps a failed report to
  // `EXIT.problems`, and the case below does that without leaving the process. How
  // `doctor` behaves against an unreachable host belongs to `doctor.test.ts`, where
  // the fetcher is injected.
  it('rejects a URL that is not one without asking the network', async () => {
    const { code, out } = await run('doctor', 'baseclf.example.workers.dev');

    expect(code).toBe(EXIT.problems);
    expect(out).toContain('is not a URL');
  });
});

describe('what the fixed text says', () => {
  it('obeys every voice rule that can be checked', () => {
    // Usage text is the easiest place for an exclamation mark or an em-dash to
    // appear, because nobody thinks of it as product copy.
    expect(fixedTextViolations()).toEqual([]);
  });

  it('names the caveat rather than claiming safety', async () => {
    // Rule 00 forbids "your data is safe" anywhere. Usage text is a place somebody
    // would reach for a reassuring sentence, so the honest one is there instead.
    const { out } = await run('--help');

    expect(out).toContain('enforces policies');
    expect(out).toContain('wrangler d1 execute');
  });

  it('obeys the voice rules on every error path too', async () => {
    const outputs = await Promise.all([
      run(),
      run('deploy'),
      run('doctor'),
      run('doctor', 'not-a-url'),
    ]);

    for (const { out } of outputs) {
      expect(findVoiceViolations(out), out).toEqual([]);
    }
  });
});
