/**
 * The session handed to a page on another origin, and every case where it is not.
 *
 * ⚠️ These drive `handOverSession` directly rather than through the Worker, and the
 * reason is worth stating. The behaviour it fixes only exists in a browser: a real
 * provider redirect, followed by a real browser, landing on a real page. Nothing in
 * this suite can produce that. What is checkable here is the shape of the response,
 * so that is what is checked, and the narrowing is checked harder than the happy
 * path because the narrowing is the safety argument.
 */

import { describe, expect, it } from 'vitest';

import { handOverSession } from './handover.js';

const CALLBACK = 'https://engine.test/api/auth/callback/github';

function redirect(location: string, token: string | null, status = 302): Response {
  const headers = new Headers({ location });
  if (token !== null) headers.set('set-auth-token', token);
  return new Response(null, { status, headers });
}

const from = (url = CALLBACK): Request => new Request(url);

describe('handing the session to the page the provider returns to', () => {
  it('adds the session to the fragment of the redirect target', () => {
    const out = handOverSession(from(), redirect('https://app.test/', 'sess_abc'));

    expect(out.headers.get('location')).toBe('https://app.test/#session=sess_abc');
  });

  it('puts it in the fragment rather than the query, which is the whole point', () => {
    // A fragment is the one part of a URL a browser sends nowhere: not to the server
    // it fetches, not in a Referer, not into a proxy log. A query string would put a
    // live session into all three.
    const out = handOverSession(from(), redirect('https://app.test/read', 'sess_abc'));
    const target = new URL(out.headers.get('location') ?? '');

    expect(target.search).toBe('');
    expect(target.hash).toBe('#session=sess_abc');
  });

  it('escapes a token so it cannot break out of the fragment', () => {
    const out = handOverSession(from(), redirect('https://app.test/', 'a&b=c#d'));

    expect(out.headers.get('location')).toBe('https://app.test/#session=a%26b%3Dc%23d');
  });

  it('keeps a fragment the application already had', () => {
    // The callbackURL belongs to the application and it may be routing on that
    // fragment. Overwriting it would sign somebody in on the wrong screen.
    const out = handOverSession(from(), redirect('https://app.test/#/inbox', 'sess_abc'));

    expect(out.headers.get('location')).toBe('https://app.test/#/inbox&session=sess_abc');
  });

  it('resolves a relative target against the deployment', () => {
    // Better Auth allows a relative callbackURL and resolves it against its own
    // origin. Losing that would turn a working configuration into a broken redirect.
    const out = handOverSession(from(), redirect('/welcome', 'sess_abc'));

    expect(out.headers.get('location')).toBe('https://engine.test/welcome#session=sess_abc');
  });

  it('leaves every other path alone, including other auth redirects', () => {
    // 🔴 Narrow on purpose. This is the second line of defence behind Better Auth's
    // own check that callbackURL is a trusted origin: even if that check regressed,
    // only the callback path could ever carry a session outward.
    const elsewhere = redirect('https://app.test/', 'sess_abc');
    const out = handOverSession(from('https://engine.test/api/auth/sign-out'), elsewhere);

    expect(out.headers.get('location')).toBe('https://app.test/');
  });

  it('leaves a callback that is not a redirect alone', () => {
    const body = new Response('{}', {
      status: 200,
      headers: { 'set-auth-token': 'sess_abc', location: 'https://app.test/' },
    });
    const out = handOverSession(from(), body);

    expect(out.headers.get('location')).toBe('https://app.test/');
  });

  it('leaves a redirect with no session alone', () => {
    // Every failure path of the callback redirects without establishing a session.
    // None of them should grow one.
    const out = handOverSession(from(), redirect('https://app.test/?error=denied', null));

    expect(out.headers.get('location')).toBe('https://app.test/?error=denied');
  });

  it('leaves a location it cannot parse exactly as it is', () => {
    // ⚠️ Harder to reach than it looks, and the first version of this test was wrong
    // about it. Resolved against a base, almost any string is a valid relative URL:
    // `::not a url::` becomes a path on the deployment's own origin. A malformed
    // authority is one of the few things that actually throws.
    const out = handOverSession(from(), redirect('http://[', 'sess_abc'));

    expect(out.headers.get('location')).toBe('http://[');
  });

  // 🔴 There is deliberately no test here for an off-origin Location.
  //
  // Writing one would mean asserting what this does with a destination it should
  // never receive, which locks in the answer instead of preventing the case. The
  // thing that prevents it is Better Auth refusing an untrusted `callbackURL` at
  // sign-in, measured against a live deployment across the four shapes worth trying:
  // `//evil.example.com/`, `/\/evil.example.com` and `https:/\/evil.example.com` are
  // each refused with 403 INVALID_CALLBACK_URL before any provider is contacted, and
  // a genuine relative path is accepted.
  //
  // A second origin check here would be a second implementation of one judgement,
  // which is the shape this project has already paid for twice: `_diagnose` and the
  // CORS layer disagreeing about the same list sent an operator to fix a
  // configuration that was correct. The defence that costs nothing is the narrowing
  // above, so only a callback, only a redirect, only with a session.

  it('carries the status and the rest of the headers through', () => {
    const original = redirect('https://app.test/', 'sess_abc', 307);
    original.headers.set('set-cookie', 'session=sess_abc; Path=/');

    const out = handOverSession(from(), original);

    expect(out.status).toBe(307);
    expect(out.headers.get('set-cookie')).toBe('session=sess_abc; Path=/');
  });
});
