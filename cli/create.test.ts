/**
 * The decisions `create-baseclf` makes before it touches a network.
 *
 * Onboarding is where this product is won or lost, and most of what can go wrong
 * with it goes wrong quietly: a binding named after the project deploys and then
 * answers every request with `undefined`, a frontend origin with a path on the end
 * is trimmed without a word, a name that suits three services out of four fails
 * halfway through provisioning. None of those need a network to test, so none of
 * them are left to be discovered on somebody's account.
 */

import { describe, expect, it } from 'vitest';

import {
  bindingsFor,
  CREATE_PLAN,
  checkFrontendOrigin,
  checkProjectName,
  collectAnswers,
  DEFAULT_FRONTEND_ORIGIN,
  DEFAULT_PROJECT_NAME,
  deriveResourceNames,
  generateSecret,
  MAX_ANSWER_ATTEMPTS,
  promptFor,
  REQUIRED_BINDING_NAMES,
  SECRET_BYTES,
  SIGNING_SECRET_NAME,
  STUDIO_ORIGIN,
  varsFor,
} from './create.js';
import { findVoiceViolations } from './output.js';

describe('the project name, which has to suit three services at once', () => {
  it('accepts the default it offers, or the default is not an answer', () => {
    expect(checkProjectName(DEFAULT_PROJECT_NAME).ok).toBe(true);
  });

  it.each(['my-app', 'baseclf2', 'a-b-c'])('accepts %s', (name) => {
    expect(checkProjectName(name).ok).toBe(true);
  });

  it.each([
    ['My-App', 'an uppercase letter'],
    ['my_app', 'an underscore'],
    ['1app', 'a leading digit'],
    ['-app', 'a leading hyphen'],
    ['app-', 'a trailing hyphen'],
    ['ab', 'too short'],
    [' app', 'a leading space'],
  ])('refuses %s, because of %s', (name) => {
    expect(checkProjectName(name).ok).toBe(false);
  });

  it('says which rule was broken rather than only that one was', () => {
    // "Invalid name" tells somebody nothing about which character to change.
    const check = checkProjectName('my_app');

    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('hyphens');
  });

  it('refuses a name too long for the suffixed resources to fit', () => {
    expect(checkProjectName('a'.repeat(60)).ok).toBe(false);
  });
});

describe('the frontend origin, whose failure mode is an opaque CORS error', () => {
  it('accepts the default it offers', () => {
    expect(checkFrontendOrigin(DEFAULT_FRONTEND_ORIGIN).ok).toBe(true);
  });

  it.each(['http://localhost:5173', 'https://app.example.com'])('accepts %s', (origin) => {
    expect(checkFrontendOrigin(origin).ok).toBe(true);
  });

  it('refuses an origin with a path, rather than trimming it in silence', () => {
    // `URL.origin` would drop the path and nothing would say so, and the reader
    // would be left believing they configured something they did not.
    const check = checkFrontendOrigin('https://app.example.com/dashboard');

    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('https://app.example.com');
  });

  it('refuses a scheme a browser will not send an origin for', () => {
    expect(checkFrontendOrigin('ftp://example.com').ok).toBe(false);
  });

  it('refuses something that is not a URL at all', () => {
    expect(checkFrontendOrigin('localhost:3000').ok).toBe(false);
  });

  it('accepts a comma separated list, since the engine reads the var as one', () => {
    // A single-origin prompt forced a choice between the app's origin and the
    // hosted Studio's, and whichever was dropped failed later as opaque CORS.
    expect(checkFrontendOrigin('http://localhost:3000, https://baseclf.dev').ok).toBe(true);
  });

  it('refuses a list by naming the entry that is wrong, not the whole line', () => {
    const check = checkFrontendOrigin('http://localhost:3000,https://app.example.com/dashboard');

    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain('https://app.example.com/dashboard');
  });

  it('refuses a trailing comma rather than trusting an empty entry', () => {
    expect(checkFrontendOrigin('http://localhost:3000,').ok).toBe(false);
  });
});

describe('resource names, derived rather than asked for', () => {
  it('🔴 does not include a KV namespace, since nothing reads one', () => {
    // Provisioning used to create one because the original plan listed it. Nothing
    // in `src/` reads `env.CACHE`, and the JWKS caching KV was meant for uses the
    // Cache API instead. Creating it put a resource on somebody's account, and a
    // step in their onboarding, for something that does not exist.
    expect(Object.keys(deriveResourceNames('shop'))).toEqual(['script', 'database', 'bucket']);
    expect(REQUIRED_BINDING_NAMES).not.toContain('CACHE');
  });

  it('gives each service its own name so an account stays readable', () => {
    expect(deriveResourceNames('shop')).toEqual({
      script: 'shop',
      database: 'shop',
      bucket: 'shop-objects',
    });
  });
});

describe('⭐ bindings, where a wrong name deploys and then answers undefined', () => {
  const names = deriveResourceNames('shop');
  const bindings = bindingsFor(names, 'd1_uuid', { A_VAR: 'v' }, false);

  it('names the bindings what src/ reads, not what the project is called', () => {
    // The trap from the other side. `src/` reads env.DB, env.CACHE and env.BUCKET
    // as literals, so bindings named `shop` upload cleanly, report success, and
    // leave every request with an undefined binding and nothing to search for.
    const named = bindings.map((binding) => binding.name);

    for (const required of REQUIRED_BINDING_NAMES) {
      expect(named).toContain(required);
    }
    expect(named).not.toContain('shop');
  });

  it('points each binding at its own resource', () => {
    expect(bindings).toContainEqual({
      kind: 'resource',
      type: 'd1',
      name: 'DB',
      id: 'd1_uuid',
    });
    expect(bindings).toContainEqual({
      kind: 'resource',
      type: 'r2_bucket',
      name: 'BUCKET',
      id: 'shop-objects',
    });
  });

  it('🔴 does NOT inherit a secret on a first deploy, which has none to inherit', () => {
    // The bug this replaces. `uploadScript` always sends `bindings_inherit=strict`,
    // which turns an inherit that resolves to nothing into an error rather than a
    // silent drop. An unconditional inherit therefore fails on a script that does
    // not exist yet, and that is every first run: the one every new reader does.
    expect(bindings.filter((binding) => binding.kind === 'inherit')).toEqual([]);
  });

  it('inherits it on a redeploy, so an upload cannot drop one already set', () => {
    const redeploy = bindingsFor(names, 'd1_uuid', {}, true);

    expect(redeploy).toContainEqual({ kind: 'inherit', name: SIGNING_SECRET_NAME });
  });

  it('never puts a secret value into a binding', () => {
    // There is no shape for it in the type, and this holds the composition to that:
    // a var accidentally carrying the secret would ship it in the upload body.
    const secretish = bindings.filter(
      (binding) => binding.kind === 'text' && /secret|password|token/i.test(binding.name),
    );

    expect(secretish).toEqual([]);
  });
});

describe('the variables a deployment cannot start without', () => {
  it('carries the deployment URL, since the engine refuses to infer one', () => {
    const vars = varsFor('https://shop.someone.workers.dev', 'http://localhost:5173');

    expect(vars.BETTER_AUTH_URL).toBe('https://shop.someone.workers.dev');
    // The frontend the reader named, plus the studio's fixed origin, so the
    // simulator works without a config edit and a redeploy later.
    expect(vars.BETTER_AUTH_TRUSTED_ORIGINS).toBe('http://localhost:5173,http://localhost:4000');
  });

  it('keeps every origin the reader listed, and appends the studio origin once', () => {
    const vars = varsFor('https://x.dev', 'http://localhost:5173, https://baseclf.dev');

    expect(vars.BETTER_AUTH_TRUSTED_ORIGINS).toBe(
      'http://localhost:5173,https://baseclf.dev,http://localhost:4000',
    );
  });

  it('does not duplicate the studio origin when the reader already listed it', () => {
    const vars = varsFor('https://x.dev', `http://localhost:5173,${STUDIO_ORIGIN}`);

    expect(vars.BETTER_AUTH_TRUSTED_ORIGINS).toBe('http://localhost:5173,http://localhost:4000');
  });

  it('leaves email and password off, which is a measurement not a preference', () => {
    // Hashing costs 58 ms of CPU against a free-plan budget of 10 ms for the whole
    // request. Turning it on by default would ship a deployment that fails on its
    // first sign-in, on the plan almost every new reader is on.
    expect(varsFor('https://x.dev', 'http://localhost:3000').BETTER_AUTH_EMAIL_PASSWORD).toBe(
      'false',
    );
  });
});

describe('the signing secret, generated rather than asked for', () => {
  it('is long enough to be one', () => {
    // A reader prompted for a secret types something memorable, and a memorable
    // signing key is the whole problem.
    expect(generateSecret().length).toBeGreaterThanOrEqual(SECRET_BYTES);
  });

  it('differs every time, or it is not a secret', () => {
    const made = new Set(Array.from({ length: 20 }, () => generateSecret()));

    expect(made.size).toBe(20);
  });

  it('is safe to put in a URL and in a header', () => {
    // It travels to Cloudflare in a request body and may end up in a config file.
    expect(generateSecret()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('the plan, whose order is the design', () => {
  const titles = CREATE_PLAN.map((step) => step.title);
  const at = (fragment: string) => titles.findIndex((title) => title.includes(fragment));

  it('claims the subdomain before uploading, since the URL is a var in the upload', () => {
    expect(at('subdomain')).toBeLessThan(at('Upload'));
  });

  it('🔴 sets the secret AFTER uploading, since a secret belongs to a script', () => {
    // The order the documented chain uses (rules/02 section C, steps 5 then 7), and
    // the only one that can work: there is nothing to set a secret on until the
    // script exists. This assertion used to read the other way round, on the
    // reasoning that the upload inherits the secret so the secret must come first.
    // That is right about a redeploy and impossible on a first run.
    expect(at('Upload')).toBeLessThan(at('secret'));
  });

  it('waits for the address last, rather than declaring success at a 404', () => {
    // A new workers.dev URL answers 404, then 500, then 200, over about thirty
    // seconds. Printing the URL and stopping sends the reader to a 404 at the exact
    // moment they are deciding whether this product works.
    expect(at('Wait')).toBe(titles.length - 1);
  });

  it('says what breaks for every step, since that is what a failure has to print', () => {
    for (const step of CREATE_PLAN) {
      expect(step.consequence.length).toBeGreaterThan(0);
    }
  });
});

describe('asking the two questions', () => {
  /** Answers each prompt from a list, then keeps returning empty. */
  function answering(lines: readonly string[]) {
    const asked: string[] = [];
    const written: string[] = [];
    let index = 0;

    const ask = (prompt: string) => {
      asked.push(prompt);
      const line = lines[index] ?? '';
      index += 1;
      return Promise.resolve(line);
    };

    return { ask, asked, written, write: (text: string) => written.push(text) };
  }

  it('takes the answers given', async () => {
    const harness = answering(['shop', 'http://localhost:5173']);

    const collected = await collectAnswers(harness.ask, harness.write);

    expect(collected).toEqual({
      ok: true,
      answers: { project: 'shop', frontendOrigin: 'http://localhost:5173' },
    });
  });

  it('takes the default when the reader just presses enter', async () => {
    const harness = answering(['', '']);

    const collected = await collectAnswers(harness.ask, harness.write);

    expect(collected.ok === true && collected.answers).toEqual({
      project: DEFAULT_PROJECT_NAME,
      frontendOrigin: DEFAULT_FRONTEND_ORIGIN,
    });
  });

  it('trims what was typed, since a trailing space is not part of a name', async () => {
    const harness = answering([' shop ', ' http://localhost:5173 ']);

    const collected = await collectAnswers(harness.ask, harness.write);

    expect(collected.ok === true && collected.answers.project).toBe('shop');
  });

  it('says why it is asking, on every question', async () => {
    // A reader who cannot tell what a question is for is a reader deciding whether
    // to keep going. BUILD-PROGRESS section V5 requires this of every field.
    const harness = answering(['', '']);

    await collectAnswers(harness.ask, harness.write);

    expect(harness.asked).toHaveLength(2);
    for (const prompt of harness.asked) {
      expect(prompt.split('\n')[1]?.trim().length).toBeGreaterThan(20);
    }
  });

  it('tells the reader the origin answer is a list, and what the hosted Studio needs', async () => {
    // The first real user pressed enter through this prompt and got a deployment
    // the hosted Studio could not talk to. The prompt has to say both things.
    const harness = answering(['', '']);

    await collectAnswers(harness.ask, harness.write);

    const originPrompt = harness.asked[1] ?? '';
    expect(originPrompt).toContain('Comma separate');
    expect(originPrompt).toContain('https://baseclf.dev');
  });

  it('asks again when the answer cannot be used, and says what was wrong', async () => {
    const harness = answering(['My_Shop', 'shop', 'http://localhost:5173']);

    const collected = await collectAnswers(harness.ask, harness.write);

    expect(collected.ok === true && collected.answers.project).toBe('shop');
    expect(harness.written.join('\n')).toContain('hyphens');
  });

  it('⭐ gives up rather than looping when nothing usable ever arrives', async () => {
    // The likeliest way here is not three typos. It is a script with nothing on
    // stdin, where an unbounded prompt is a command that never returns and never
    // says why.
    const harness = answering(['!!', '!!', '!!', '!!', '!!']);

    const collected = await collectAnswers(harness.ask, harness.write);

    expect(collected.ok).toBe(false);
    expect(harness.asked).toHaveLength(MAX_ANSWER_ATTEMPTS);
  });

  it('names the way out for a script, not just the failure', async () => {
    const harness = answering(['!!', '!!', '!!']);

    const collected = await collectAnswers(harness.ask, harness.write);

    expect(collected.ok === false && collected.lines.join(' ')).toContain('script');
  });

  it('stops at the first question rather than asking the second pointlessly', async () => {
    const harness = answering(['!!', '!!', '!!']);

    await collectAnswers(harness.ask, harness.write);

    // All three attempts went to the project name. Asking for an origin after
    // giving up on the name would collect an answer nothing is going to use.
    expect(new Set(harness.asked).size).toBe(1);
  });
});

describe('everything this file can print', () => {
  it('breaks no voice rule', async () => {
    // The rendered strings, not the source: the exclamation rule cannot survive
    // being run over code. Every reason and every plan line goes through, because
    // a checker that only covers what somebody remembered to list is one that drifts.
    const rendered = [
      ...CREATE_PLAN.flatMap((step) => [
        step.title,
        step.consequence,
        // The paragraph a survivable step prints is the longest prose the plan holds,
        // so leaving it out would exempt the most likely place for a rule to be
        // broken. That is the drift the comment above is about.
        ...(step.whenSkipped ?? []),
      ]),
      // The prompts are the first thing anybody reads, so they go through the same
      // check as everything else. Collected by driving the real questions rather
      // than by listing them here, because a list drifts from what is asked.
      ...(await (async () => {
        const asked: string[] = [];
        await collectAnswers(
          (prompt) => {
            asked.push(prompt);
            return Promise.resolve('');
          },
          () => undefined,
        );
        return asked;
      })()),
      promptFor('A question', 'Why it is needed.', 'a-default'),
      ...['My-App', 'my_app', 'ab', 'a'.repeat(60), ' app'].map((name) => {
        const check = checkProjectName(name);
        return check.ok ? '' : check.reason;
      }),
      ...['ftp://x.com', 'localhost:3000', 'https://a.com/b'].map((origin) => {
        const check = checkFrontendOrigin(origin);
        return check.ok ? '' : check.reason;
      }),
    ];

    expect(rendered.flatMap(findVoiceViolations)).toEqual([]);
  });
});
