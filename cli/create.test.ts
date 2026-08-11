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
  checkFrontendOrigin,
  checkProjectName,
  CREATE_PLAN,
  DEFAULT_FRONTEND_ORIGIN,
  DEFAULT_PROJECT_NAME,
  deriveResourceNames,
  generateSecret,
  REQUIRED_BINDING_NAMES,
  SECRET_BYTES,
  varsFor,
} from './create.js';
import { findVoiceViolations } from './output.js';

describe('the project name, which has to suit four services at once', () => {
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
});

describe('resource names, derived rather than asked for', () => {
  it('gives each service its own name so an account stays readable', () => {
    expect(deriveResourceNames('shop')).toEqual({
      script: 'shop',
      database: 'shop',
      namespace: 'shop-cache',
      bucket: 'shop-objects',
    });
  });
});

describe('⭐ bindings, where a wrong name deploys and then answers undefined', () => {
  const names = deriveResourceNames('shop');
  const bindings = bindingsFor(names, 'd1_uuid', 'kv_id', { A_VAR: 'v' });

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

  it('inherits the signing secret rather than carrying it in the upload body', () => {
    // Secrets go in on their own endpoint. Naming it here is what stops the deploy
    // dropping one that is already set, and `bindings_inherit=strict` turns a
    // missing one into an error instead of a silent absence.
    expect(bindings).toContainEqual({ kind: 'inherit', name: 'BETTER_AUTH_SECRET' });
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
    expect(vars.BETTER_AUTH_TRUSTED_ORIGINS).toBe('http://localhost:5173');
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

  it('sets the secret before uploading, since the upload inherits it', () => {
    // `bindings_inherit=strict` makes an unresolvable inherit an error rather than
    // a silent drop. Loud was the point; failing was not.
    expect(at('secret')).toBeLessThan(at('Upload'));
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

describe('everything this file can print', () => {
  it('breaks no voice rule', () => {
    // The rendered strings, not the source: the exclamation rule cannot survive
    // being run over code. Every reason and every plan line goes through, because
    // a checker that only covers what somebody remembered to list is one that drifts.
    const rendered = [
      ...CREATE_PLAN.flatMap((step) => [step.title, step.consequence]),
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
