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

import { EXIT, fixedTextViolations, main } from './main.js';
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
