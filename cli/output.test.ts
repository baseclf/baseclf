/**
 * The design system, applied to a terminal and checked by a machine.
 *
 * `_design_system` states the voice rules in prose, and prose drifts. The binary
 * half of them is checkable, so it is checked here, which is the same move
 * `scripts/check-design-tokens.mjs` makes for colour: a rule nobody runs is a rule
 * that quietly stops being true.
 *
 * The rule that gets the most attention below is the one that reads like
 * formatting. A copyable value has to sit at column zero, because a redirect URI
 * with two spaces in front of it does not double-click cleanly, and the person who
 * mis-pastes it gets `redirect_uri_mismatch` with nothing in any log to explain it.
 * That is the step people give up at.
 */

import { describe, expect, it } from 'vitest';

import {
  ansiFor,
  copyable,
  findVoiceViolations,
  markFor,
  nextAction,
  note,
  PLAIN,
  resultLine,
  SPINNER_FRAMES,
  stepLine,
  styledResultLine,
  type Verdict,
} from './output.js';

const VERDICTS: readonly Verdict[] = ['allow', 'deny', 'attention'];

describe('the palette', () => {
  it('is exactly three colours, mapped to the standard ANSI codes', () => {
    // A terminal cannot read a CSS token, so this mapping is the whole of colour in
    // the CLI. If a fourth appears, something is being coloured that should not be.
    expect(VERDICTS.map(ansiFor)).toEqual([32, 31, 33]);
    expect(new Set(VERDICTS.map(ansiFor)).size).toBe(3);
  });

  it('uses no mark that its own voice checker would refuse', () => {
    // The first version of this file used '!' for attention and failed here. The
    // rule is binary, so the mark changed rather than the rule.
    for (const verdict of VERDICTS) {
      expect(findVoiceViolations(markFor(verdict)), verdict).toEqual([]);
    }
  });

  it('never signals with colour alone', () => {
    // Roughly one male developer in twelve cannot tell this green from this red, and
    // a piped log has no colour at all. The mark is what carries the meaning.
    for (const verdict of VERDICTS) {
      expect(markFor(verdict).length).toBeGreaterThan(0);
      expect(resultLine(verdict, 'something happened')).toContain(markFor(verdict));
    }
  });

  it('emits no escape codes when the caller says the terminal has no colour', () => {
    for (const verdict of VERDICTS) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the subject. These assertions are about ANSI codes, so a regex without a control character would be a regex about something else.
      expect(styledResultLine(verdict, 'text', PLAIN)).not.toMatch(/\[/);
    }
  });

  it('emits them when it does, around the mark and not the text', () => {
    const line = styledResultLine('deny', 'the table is not exposed', { colour: true });

    expect(line).toContain('[31m');
    // The text is left unpainted on purpose: a long warning wrapped in escape codes
    // is harder to read, and a piped log fills with them.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the subject. A regex about ANSI codes without a control character in it would be a regex about something else.
    expect(line).toMatch(/\[0m the table is not exposed$/);
  });

  it('colours the mark for each verdict with that verdict, and no other', () => {
    for (const verdict of VERDICTS) {
      const line = styledResultLine(verdict, 'text', { colour: true });
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the subject. A regex about ANSI codes without a control character in it would be a regex about something else.
      const codes = [...line.matchAll(/\[(\d+)m/g)].map((match) => Number(match[1]));

      expect(codes).toEqual([ansiFor(verdict), 0]);
    }
  });
});

describe('a copyable value', () => {
  it('sits at column zero, so a double-click selects it and nothing else', () => {
    // The rule that decides whether onboarding completes. See the note at the top.
    const uri = 'https://baseclf-8f2c.raspy-firefly.workers.dev/api/auth/callback/google';
    const rendered = copyable(uri);

    const valueLine = rendered.split('\n').find((line) => line.includes(uri));
    expect(valueLine).toBe(uri);
    expect(valueLine).not.toMatch(/^\s/);
  });

  it('is set apart by blank lines, so it does not read as part of a sentence', () => {
    expect(copyable('value').split('\n')).toEqual(['', 'value', '']);
  });

  it('is the only thing unindented, unlike a note', () => {
    expect(note('this is context')).toMatch(/^\s{2}\S/);
  });
});

describe('a step in progress', () => {
  it('cycles through spinner frames rather than printing a new line each time', () => {
    expect(stepLine(0, 'creating the database')).toBe('⠋ creating the database');
    expect(stepLine(SPINNER_FRAMES.length, 'creating the database')).toBe(
      '⠋ creating the database',
    );
    expect(stepLine(1, 'x')).not.toBe(stepLine(0, 'x'));
  });

  it('uses no emoji in any frame', () => {
    for (const frame of SPINNER_FRAMES) {
      expect(findVoiceViolations(frame)).toEqual([]);
    }
  });
});

describe('how output ends', () => {
  it('names the next concrete action rather than reporting completion', () => {
    // A CLI that ends with a success mark and no instruction leaves the reader to
    // work out what a half-configured deployment needs, and the half they are
    // missing is usually the OAuth app, which fails silently.
    const rendered = nextAction({
      goal: 'enable Google sign-in, about two minutes',
      steps: [
        'Open https://console.cloud.google.com/apis/credentials',
        'Create credentials, OAuth client ID, web application',
        'Paste this exact value into "Authorized redirect URIs":',
      ],
      copy: 'https://baseclf-8f2c.raspy-firefly.workers.dev/api/auth/callback/google',
      verify: 'baseclf doctor https://baseclf-8f2c.raspy-firefly.workers.dev',
    });

    expect(rendered).toContain('Next: enable Google sign-in');
    expect(rendered).toContain('Check: baseclf doctor');
    expect(rendered).not.toMatch(/\bDone\b/);
  });

  it('numbers the steps, and leaves the value out of them', () => {
    const rendered = nextAction({
      goal: 'set the signing secret',
      steps: ['Run the command below'],
      copy: 'wrangler secret put BETTER_AUTH_SECRET',
    });

    expect(rendered).toContain('  1. Run the command below');
    const valueLine = rendered.split('\n').find((line) => line.startsWith('wrangler'));
    expect(valueLine).toBe('wrangler secret put BETTER_AUTH_SECRET');
  });
});

describe('the voice rules, as something a machine checks', () => {
  it('catches an em-dash and an en-dash', () => {
    // Binary rule. "Use sparingly" was tried and did not hold, and it is the single
    // most reliable signature of machine-written text.
    expect(findVoiceViolations('the policy failed — try again')).toHaveLength(1);
    expect(findVoiceViolations('pages 3–5')).toHaveLength(1);
    expect(findVoiceViolations('a plain hyphen - is fine')).toEqual([]);
  });

  it('catches an exclamation mark, including in a success line', () => {
    expect(findVoiceViolations('Policy saved!')).toHaveLength(1);
  });

  it('catches an emoji', () => {
    expect(findVoiceViolations('deployed \u{1F680}')).toHaveLength(1);
    // The marks are dingbats rather than emoji, which is why they survive the ban.
    expect(findVoiceViolations('✓ deployed')).toEqual([]);
    expect(findVoiceViolations('✗ refused')).toEqual([]);
  });

  it('catches a filler verb from the banned list', () => {
    expect(findVoiceViolations('a seamless experience')).toHaveLength(1);
    expect(findVoiceViolations('unleash your data')).toHaveLength(1);
  });

  it('catches a safety claim, which rule 00 forbids outright', () => {
    expect(findVoiceViolations('Your data is safe with BaseCLF')).toHaveLength(1);
    expect(findVoiceViolations('100% secure')).toHaveLength(1);
    // The permitted form says what is enforced instead of claiming an outcome.
    expect(
      findVoiceViolations('BaseCLF enforces policies on every request through this Worker.'),
    ).toEqual([]);
  });

  it('catches a generic placeholder name and a fake-perfect number', () => {
    expect(findVoiceViolations('for example Acme Corp')).toHaveLength(1);
    expect(findVoiceViolations('99.99% uptime')).toHaveLength(1);
  });

  it('reports every rule a line breaks, not just the first', () => {
    expect(findVoiceViolations('Awesome \u{1F389} — 100% secure!').length).toBeGreaterThan(2);
  });

  it('says why, not only that something is wrong', () => {
    // A checker that reports a violation without the reason teaches nobody anything,
    // and the next person writes the same line again.
    const [why] = findVoiceViolations('a seamless — experience');
    expect(why).toBeTruthy();
    expect((why ?? '').length).toBeGreaterThan(20);
  });
});
