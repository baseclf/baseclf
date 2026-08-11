/**
 * Which token wins, and whether the reader is told.
 *
 * These tests are unusually specific about wording, and that is on purpose. The
 * failure they guard against is not a wrong decision, it is a correct decision nobody
 * knew had been made: a stale `CLOUDFLARE_API_TOKEN` in the environment beat a `.env`
 * file silently, so every attempt to fix the token was testing a third one. The
 * symptoms named permissions, and the permissions were fine. A day went into it.
 *
 * So the assertions check that the warning says the two things a reader cannot work
 * out on their own: that the environment wins, and that removing the variable from
 * user scope is not enough because the parent process kept a copy.
 *
 * ⚠️ Every case below uses obviously fake values. Nothing here prints a token, a
 * prefix of one, or its length, and there is a test for that too: a length narrows a
 * guess, and a terminal ends up in a screenshot.
 */

import { describe, expect, it } from 'vitest';

import { decideToken, explainRefusal } from './token.js';

// Fake tokens, and both of their properties are corrections the tests forced.
//
// They read as placeholders rather than as random strings, because a fake that looks
// exactly like a real token is a liability in a public repository: a secret scanner
// flags it, a reader cannot tell, and `scripts/guard-commit.mjs` blocked the commit
// that first used realistic-looking ones. The guard was right to. Its pattern needs
// twenty or more characters after the prefix, so these are shorter than that, which
// also means nothing here can be mistaken for a credential.
//
// Their bodies are also words the code has no reason to say. An earlier version named
// them after where they came from, and the leak test then failed on the cfat_ warning,
// which legitimately contains the phrase "account-owned" that the fake also
// contained. A canary has to be a string the code would never write on its own.
const FROM_FILE = 'cfut_EXAMPLE_FILE';
const FROM_ENVIRONMENT = 'cfut_EXAMPLE_ENVVAR';
const FROM_ARGUMENT = 'cfut_EXAMPLE_ARGV';
const ACCOUNT_OWNED = 'cfat_EXAMPLE_SECOND';

describe('which token wins', () => {
  it('prefers the command line over everything', () => {
    const decision = decideToken({
      fromArgument: FROM_ARGUMENT,
      fromEnvironment: FROM_ENVIRONMENT,
      fromFile: FROM_FILE,
    });

    expect(decision.source).toBe('argument');
    expect(decision.token).toBe(FROM_ARGUMENT);
  });

  it('prefers the environment over a file, which is the trap', () => {
    const decision = decideToken({ fromEnvironment: FROM_ENVIRONMENT, fromFile: FROM_FILE });

    expect(decision.source).toBe('environment');
    expect(decision.token).toBe(FROM_ENVIRONMENT);
  });

  it('uses the file when nothing else is set', () => {
    const decision = decideToken({ fromFile: FROM_FILE });

    expect(decision.source).toBe('file');
    expect(decision.warnings).toEqual([]);
  });

  it('treats blank and whitespace as absent', () => {
    // An empty variable is a real state, and treating it as a token means a refusal
    // that says nothing.
    expect(decideToken({ fromEnvironment: '   ', fromFile: FROM_FILE }).source).toBe('file');
    expect(decideToken({ fromEnvironment: '' }).source).toBe('none');
  });
});

describe('⭐ the warning the day was lost to', () => {
  it('fires when the environment holds a different token from the file', () => {
    const decision = decideToken({ fromEnvironment: FROM_ENVIRONMENT, fromFile: FROM_FILE });

    expect(decision.warnings.length).toBeGreaterThanOrEqual(2);
    expect(decision.warnings[0]).toContain('always wins');
    expect(decision.warnings[0]).toContain('.env value is being ignored');
  });

  it('says that removing it from user scope is not enough', () => {
    // The half that took longest. A parent process that started before the removal
    // keeps its own copy, and every child inherits it, so the terminal has to be
    // restarted. Nothing about the symptom suggests that.
    const [, second] = decideToken({
      fromEnvironment: FROM_ENVIRONMENT,
      fromFile: FROM_FILE,
    }).warnings;

    expect(second).toContain('parent process');
    expect(second).toContain('restarted');
    expect(second).toContain('Remove-Item Env:CLOUDFLARE_API_TOKEN');
  });

  it('says the symptoms point at permissions, because they do', () => {
    // `d1 list` answers "Authentication error" and suggests checking permissions. A
    // reader who follows that suggestion finds nothing wrong and concludes the tool
    // is broken, which is the conclusion this project drew and had to retract.
    const [first] = decideToken({
      fromEnvironment: FROM_ENVIRONMENT,
      fromFile: FROM_FILE,
    }).warnings;

    expect(first).toContain('permissions');
  });

  it('stays quiet when both hold the same token', () => {
    // A variable that agrees with the file is not a surprise, and a warning about it
    // would be noise that teaches people to skip warnings.
    const decision = decideToken({ fromEnvironment: FROM_FILE, fromFile: FROM_FILE });

    expect(decision.warnings).toEqual([]);
  });

  it('stays quiet when only the environment holds one', () => {
    const decision = decideToken({ fromEnvironment: FROM_ENVIRONMENT });
    expect(decision.warnings).toEqual([]);
  });
});

describe('the two token prefixes', () => {
  it('says what Cloudflare says about cfat_, and admits it is unverified', () => {
    // Documentation rather than measurement. The experiment that would have tested it
    // was the one the environment variable ruined, so the warning has to carry that
    // uncertainty instead of stating a fact.
    const decision = decideToken({ fromFile: ACCOUNT_OWNED });
    const warning = decision.warnings.find((line) => line.includes('cfat_'));

    expect(warning).toBeDefined();
    expect(warning).toContain('not verified this ourselves');
  });

  it('says something mild about a token with no recognised prefix', () => {
    // An older token without a prefix is legitimate, so this cannot be a refusal.
    const decision = decideToken({ fromFile: 'some-older-token-without-a-prefix' });

    expect(decision.token).toBe('some-older-token-without-a-prefix');
    expect(decision.warnings.some((line) => line.includes('carry on'))).toBe(true);
  });

  it('says nothing about a cfut_ token, which is the one that works', () => {
    expect(decideToken({ fromFile: FROM_FILE }).warnings).toEqual([]);
  });
});

describe('no token at all', () => {
  it('says where to make one, rather than only that none was found', () => {
    const decision = decideToken({});

    expect(decision.source).toBe('none');
    expect(decision.token).toBeUndefined();
    expect(decision.warnings[0]).toContain('My Profile');
  });
});

describe('⚠️ what is never printed', () => {
  it('puts no token, prefix or length into any warning', () => {
    // A length narrows a guess, and a terminal ends up in a screenshot. Checked across
    // every case that produces warnings, rather than trusted to care.
    const cases = [
      decideToken({ fromEnvironment: FROM_ENVIRONMENT, fromFile: FROM_FILE }),
      decideToken({ fromArgument: FROM_ARGUMENT, fromEnvironment: FROM_ENVIRONMENT }),
      decideToken({ fromFile: ACCOUNT_OWNED }),
      decideToken({}),
    ];

    for (const decision of cases) {
      const text = decision.warnings.join('\n');

      for (const secret of [FROM_ENVIRONMENT, FROM_FILE, FROM_ARGUMENT, ACCOUNT_OWNED]) {
        expect(text).not.toContain(secret);
        // Not even a fragment past the prefix. A masked secret is a secret with
        // fewer characters left to guess.
        expect(text).not.toContain(secret.slice(5, 17));
      }

      expect(text).not.toMatch(/\b\d{2,} characters\b/);
    }
  });
});

describe('explaining a refusal', () => {
  it('names where the token came from before it mentions permissions', () => {
    // Cloudflare's own message says "please ensure it has the correct permissions",
    // which sends the reader to a page where nothing is wrong. The thing to check
    // first is which credential is being held.
    const decision = decideToken({ fromEnvironment: FROM_ENVIRONMENT, fromFile: FROM_FILE });
    const lines = explainRefusal(403, decision);

    expect(lines[0]).toContain('environment variable');
    expect(lines[0]).toContain('first thing to check');
  });

  it('adds the command to clear it when the environment is the source', () => {
    const decision = decideToken({ fromEnvironment: FROM_ENVIRONMENT });
    const lines = explainRefusal(401, decision);

    expect(lines.some((line) => line.includes('Remove-Item Env:CLOUDFLARE_API_TOKEN'))).toBe(true);
  });

  it('says nothing for a status that is not about credentials', () => {
    // A 500 is not a token problem, and explaining tokens would send somebody the
    // wrong way for the second time.
    expect(explainRefusal(500, decideToken({ fromFile: FROM_FILE }))).toEqual([]);
  });
});
