/**
 * The storage boundary, tested from the refusing side.
 *
 * The slice is finished when an avatar can be uploaded to `avatars/{uid}/` and an
 * upload into somebody else's directory is refused, so the tests that carry the
 * weight are the ones that try to get out of the directory the policy describes.
 *
 * Several of these assert that something is *unrepresentable* rather than that it
 * is rejected by a rule. Those read as unnecessary until somebody relaxes the
 * character set for a reason that sounds good at the time.
 */

import { describe, expect, it } from 'vitest';

import type { AuthCtx } from '../policy/types.js';
import { BaseclfError } from '../utils/errors.js';
import {
  assertUploadAllowed,
  authorizeStorage,
  type StorageBucketDefinition,
  type StorageGrant,
  type StorageOperation,
  validateStorageBucket,
} from './policy.js';

const ANN: AuthCtx = {
  role: 'authenticated',
  uid: 'u_ann',
  email: 'ann@example.test',
  app: {},
};

const BOB: AuthCtx = { ...ANN, uid: 'u_bob', email: 'bob@example.test' };

const ANON: AuthCtx = { role: 'anon', uid: null, email: null, app: {} };

const AVATARS: StorageBucketDefinition = {
  bucket: 'avatars',
  enabled: true,
  policies: [
    {
      name: 'upload_own_avatar',
      for: 'upload',
      to: ['authenticated'],
      prefix: 'avatars/$auth.uid/',
      maxSizeBytes: 1024,
      allowedMimeTypes: ['image/png', 'image/jpeg'],
    },
    {
      name: 'read_own_avatar',
      for: 'download',
      to: ['authenticated'],
      prefix: 'avatars/$auth.uid/',
    },
  ],
};

function registry(...definitions: StorageBucketDefinition[]) {
  return new Map(definitions.map((definition) => [definition.bucket, definition]));
}

function authorize(
  overrides: {
    bucket?: string;
    operation?: StorageOperation;
    auth?: AuthCtx;
    fileName?: string;
    buckets?: ReadonlyMap<string, StorageBucketDefinition>;
  } = {},
) {
  return authorizeStorage({
    buckets: overrides.buckets ?? registry(AVATARS),
    bucket: overrides.bucket ?? 'avatars',
    operation: overrides.operation ?? 'upload',
    auth: overrides.auth ?? ANN,
    fileName: overrides.fileName ?? 'me.png',
  });
}

/**
 * Assert a refusal, and assert it is the *same* refusal every other one is.
 *
 * Checking the status and code rather than that something threw, because the whole
 * point of invariant I5 here is that a caller cannot tell an absent object from a
 * forbidden one, and a test that only checks for a throw would pass just as well
 * if one of them started answering 403.
 */
function expectNotFound(work: () => unknown): BaseclfError {
  let thrown: unknown;
  try {
    work();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(BaseclfError);
  const error = thrown as BaseclfError;
  expect(error.status).toBe(404);
  expect(error.toResponseBody()).toEqual({ error: 'Not found.', code: 'NOT_FOUND' });
  return error;
}

describe('the key a caller ends up with', () => {
  it('is built from the policy prefix and the name, with the claim substituted', () => {
    expect(authorize().key).toBe('avatars/u_ann/me.png');
  });

  it('differs by identity for the same request', () => {
    // The whole slice in one assertion: same URL, same file name, two callers,
    // two directories.
    expect(authorize({ auth: ANN }).key).toBe('avatars/u_ann/me.png');
    expect(authorize({ auth: BOB }).key).toBe('avatars/u_bob/me.png');
  });

  it('names the policy that allowed it', () => {
    expect(authorize().policyName).toBe('upload_own_avatar');
  });

  it('carries the limits of that policy, and nothing for a download', () => {
    expect(authorize().maxSizeBytes).toBe(1024);
    expect(authorize({ operation: 'download' }).maxSizeBytes).toBeUndefined();
  });
});

describe('a caller trying to reach another directory', () => {
  it('cannot, because a name may not contain a separator', () => {
    // Not "is rejected by a traversal rule". There is no traversal rule; a name
    // with a slash in it is not a name.
    expectNotFound(() => authorize({ fileName: '../u_bob/theirs.png' }));
    expectNotFound(() => authorize({ fileName: 'u_bob/theirs.png' }));
    expectNotFound(() => authorize({ fileName: '/etc/passwd' }));
  });

  it('cannot use a name that is only relative segments', () => {
    expectNotFound(() => authorize({ fileName: '..' }));
    expectNotFound(() => authorize({ fileName: '.' }));
  });

  it('cannot start a name with a dot, so hidden names are out too', () => {
    expectNotFound(() => authorize({ fileName: '.env' }));
  });

  it('cannot smuggle a separator in as an escape', () => {
    // Percent and backslash are outside the set, so neither an encoded slash nor
    // a Windows one is a name. Decoding happens before this in the router, but
    // this file should refuse them even if it did not.
    expectNotFound(() => authorize({ fileName: '..%2Fu_bob%2Ftheirs.png' }));
    expectNotFound(() => authorize({ fileName: '..\\u_bob\\theirs.png' }));
  });

  it('cannot use a name long enough to matter', () => {
    expectNotFound(() => authorize({ fileName: `${'a'.repeat(129)}.png` }));
    expect(authorize({ fileName: 'a'.repeat(128) }).key).toBe(`avatars/u_ann/${'a'.repeat(128)}`);
  });

  it('cannot use an empty name', () => {
    expectNotFound(() => authorize({ fileName: '' }));
  });
});

/**
 * The other half of the same question, and the half that was open.
 *
 * Everything above is about the part of the key the caller types. These are
 * about the part the engine substitutes, which the file above treated as safe
 * because it came from a verified token. Verified says who wrote a claim, not
 * what it is safe to build a path out of, and the two are different questions:
 * measured on 2026-08-22, a claim of `..` produced `avatars/../secret.png` and
 * was allowed, while the identical `..` written into the template is refused
 * when the policy is saved.
 *
 * Not reachable through `$auth.uid` today, since Better Auth builds ids from
 * `a-z`, `0-9`, `A-Z` and `-_`. These exist because `$auth.app.<key>` would put
 * a value somebody types by hand in the same position.
 */
describe('a claim standing in for a path segment', () => {
  const withUid = (uid: string) => ({ ...ANN, uid });

  it('cannot be a relative segment, the way a template cannot', () => {
    expectNotFound(() => authorize({ auth: withUid('..') }));
    expectNotFound(() => authorize({ auth: withUid('.') }));
  });

  it('cannot carry a separator in any spelling', () => {
    expectNotFound(() => authorize({ auth: withUid('u_ann/u_bob') }));
    expectNotFound(() => authorize({ auth: withUid('u_ann\\u_bob') }));
    expectNotFound(() => authorize({ auth: withUid('u_ann%2Fu_bob') }));
  });

  it('cannot be blank, whitespace, or a control character', () => {
    expectNotFound(() => authorize({ auth: withUid('') }));
    expectNotFound(() => authorize({ auth: withUid('  ') }));
    expectNotFound(() => authorize({ auth: withUid('u_ann u_bob') }));
    expectNotFound(() => authorize({ auth: withUid('u_ann\nu_bob') }));
  });

  it('cannot be long enough to matter', () => {
    expectNotFound(() => authorize({ auth: withUid('a'.repeat(65)) }));
    expect(authorize({ auth: withUid('a'.repeat(64)) }).key).toBe(
      `avatars/${'a'.repeat(64)}/me.png`,
    );
  });

  it('accepts every shape the identity provider actually issues', () => {
    // Better Auth composes ids from a-z, 0-9, A-Z and -_ (read from its
    // generator). A rule that refused one of those would refuse real callers on
    // deployments that already work, so each character class is named here.
    expect(authorize({ auth: withUid('abc') }).key).toBe('avatars/abc/me.png');
    expect(authorize({ auth: withUid('ABC123') }).key).toBe('avatars/ABC123/me.png');
    expect(authorize({ auth: withUid('a-b_c') }).key).toBe('avatars/a-b_c/me.png');
  });
});

describe('fail-closed, at each of the three places it could become a default', () => {
  it('refuses a bucket that is not in the registry', () => {
    expectNotFound(() => authorize({ bucket: 'not-registered' }));
  });

  it('refuses a bucket that is registered but not enabled', () => {
    const disabled = registry({ ...AVATARS, enabled: false });
    expectNotFound(() => authorize({ buckets: disabled }));
  });

  it('refuses an operation the bucket has no policy for', () => {
    // `avatars` grants upload and download. Nothing grants delete, so delete is
    // not a thing that can be done, rather than a thing that is allowed by
    // default because nobody wrote it down.
    //
    // The diagnostic is asserted, not just the status, and a mutation is why.
    // Turning the no-matching-policy check off left the request falling through
    // to the refusal at the end of the function, which is real defence in depth
    // and answered 404 all the same, so a test that only checked the status could
    // not tell the two apart. It can now.
    const refused = expectNotFound(() => authorize({ operation: 'delete' }));

    expect(refused.detail).toContain('no delete policy');
    expect(refused.detail).toContain('authenticated');
  });

  it('refuses a role the policy does not name', () => {
    const refused = expectNotFound(() => authorize({ auth: ANON }));

    expect(refused.detail).toContain('no upload policy');
    expect(refused.detail).toContain('anon');
  });

  it('refuses when the claim the prefix needs is absent', () => {
    // The dangerous case, and the reason a missing claim is not an empty string:
    // substituting nothing would give `avatars//me.png`, one directory shared by
    // everybody who is not signed in.
    const anonUpload = registry({
      ...AVATARS,
      policies: [{ ...AVATARS.policies[0]!, to: ['anon'] }],
    });

    const refused = expectNotFound(() => authorize({ auth: ANON, buckets: anonUpload }));
    expect(refused.detail).toContain('$auth.uid');
  });

  it('refuses a claim that itself contains a separator', () => {
    // A claim is verified, not sanitised. A uid with a slash in it would reach
    // outside the directory its own template describes.
    const smuggled: AuthCtx = { ...ANN, uid: 'u_ann/../u_bob' };
    expectNotFound(() => authorize({ auth: smuggled }));
  });
});

describe('what a refusal tells the caller', () => {
  it('says the same thing whatever the reason', () => {
    // Invariant I5, at the storage boundary. "That bucket does not exist", "you
    // have no policy" and "that name is not allowed" are three useful facts for
    // somebody probing, so the caller gets none of them.
    const reasons = [
      () => authorize({ bucket: 'not-registered' }),
      () => authorize({ operation: 'delete' }),
      () => authorize({ auth: ANON }),
      () => authorize({ fileName: '../escape' }),
    ].map((work) => expectNotFound(work));

    const bodies = reasons.map((error) => JSON.stringify(error.toResponseBody()));
    expect(new Set(bodies).size).toBe(1);

    // And the reasons are all different on the server, so the sameness above is
    // not because nothing is being distinguished.
    expect(new Set(reasons.map((error) => error.detail)).size).toBe(reasons.length);
  });

  it('never puts the bucket name or a claim in what the client sees', () => {
    const refused = expectNotFound(() => authorize({ bucket: 'internal-secrets' }));
    const body = JSON.stringify(refused.toResponseBody());

    expect(body).not.toContain('internal-secrets');
    expect(body).not.toContain('u_ann');
  });
});

describe('a policy that must not be saved at all', () => {
  function expectInvalid(definition: StorageBucketDefinition): BaseclfError {
    let thrown: unknown;
    try {
      validateStorageBucket(definition);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BaseclfError);
    return thrown as BaseclfError;
  }

  const withPolicy = (policy: Partial<StorageBucketDefinition['policies'][number]>) => ({
    ...AVATARS,
    policies: [{ ...AVATARS.policies[0]!, ...policy }],
  });

  it('accepts the ordinary case', () => {
    expect(() => validateStorageBucket(AVATARS)).not.toThrow();
  });

  it('refuses a prefix built from user_metadata, naming the invariant', () => {
    // Invariant I4 at a different boundary. The user writes user_metadata, so a
    // prefix built from it is a prefix the caller chooses, which is the whole
    // thing this file exists to prevent.
    const error = expectInvalid(withPolicy({ prefix: 'avatars/$auth.user.folder/' }));

    expect(error.status).toBe(400);
    expect(error.detail).toContain('I4');
    expect(error.detail).toContain('user_metadata');
  });

  it('refuses an unrecognised token rather than leaving it in the key', () => {
    // The silent failure this prevents: a prefix of `avatars/$auth.tenant/` that
    // resolved to the literal string would be one shared directory, and nothing
    // would go wrong while it happened.
    const error = expectInvalid(withPolicy({ prefix: 'avatars/$auth.tenant/' }));
    expect(error.detail).toContain('$auth.tenant');
  });

  it('refuses $auth.email, which is safe but should not be in a key', () => {
    const error = expectInvalid(withPolicy({ prefix: 'avatars/$auth.email/' }));
    expect(error.detail).toContain('$auth.email');
  });

  it('refuses a prefix with no trailing separator', () => {
    // `avatars/u_ann` also matches `avatars/u_annex/secret`, so one user's
    // directory reaches into the directory of a user whose id merely starts the
    // same way.
    const error = expectInvalid(withPolicy({ prefix: 'avatars/$auth.uid' }));
    expect(error.detail).toContain('separator');
  });

  it('refuses a prefix with a relative or empty segment', () => {
    expectInvalid(withPolicy({ prefix: 'avatars/../' }));
    expectInvalid(withPolicy({ prefix: 'avatars//' }));
    expectInvalid(withPolicy({ prefix: '/avatars/' }));
  });

  it('refuses limits on an operation they cannot apply to', () => {
    // A limit that does nothing must not look as though it does something. Same
    // reasoning as insert policies being required to state `using: true`.
    const error = expectInvalid({
      ...AVATARS,
      policies: [{ ...AVATARS.policies[1]!, maxSizeBytes: 10 }],
    });
    expect(error.detail).toContain('does not apply');
  });

  it('refuses an empty allowedMimeTypes, which would refuse everything', () => {
    expectInvalid(withPolicy({ allowedMimeTypes: [] }));
  });

  it('refuses a size limit that is not a positive integer', () => {
    expectInvalid(withPolicy({ maxSizeBytes: 0 }));
    expectInvalid(withPolicy({ maxSizeBytes: -1 }));
    expectInvalid(withPolicy({ maxSizeBytes: 1.5 }));
  });

  it('refuses two policies with the same name', () => {
    const error = expectInvalid({
      ...AVATARS,
      policies: [AVATARS.policies[0]!, { ...AVATARS.policies[0]! }],
    });
    expect(error.detail).toContain('two policies named');
  });

  it('refuses a policy that grants nothing', () => {
    expectInvalid(withPolicy({ to: [] }));
  });
});

describe('the limits on an upload, before anything is written', () => {
  const grant: StorageGrant = authorize();

  it('accepts a declared length inside the limit', () => {
    expect(() => assertUploadAllowed(grant, 1024, 'image/png')).not.toThrow();
  });

  it('refuses a declared length over it with 413', () => {
    try {
      assertUploadAllowed(grant, 1025, 'image/png');
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as BaseclfError).status).toBe(413);
    }
  });

  it('refuses a declared type the policy does not list, with 415', () => {
    try {
      assertUploadAllowed(grant, 10, 'application/x-msdownload');
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as BaseclfError).status).toBe(415);
    }
  });

  it('ignores the parameters after the type', () => {
    // `text/plain; charset=utf-8` is the same type as `text/plain`. Comparing the
    // whole header would refuse an ordinary request for a reason nobody could
    // guess from the message.
    const text = authorizeStorage({
      buckets: registry(withMime(['text/plain'])),
      bucket: 'avatars',
      operation: 'upload',
      auth: ANN,
      fileName: 'notes.txt',
    });

    expect(() => assertUploadAllowed(text, 10, 'text/plain; charset=utf-8')).not.toThrow();
    expect(() => assertUploadAllowed(text, 10, 'TEXT/PLAIN')).not.toThrow();
  });

  it('refuses a missing type when the policy lists any', () => {
    try {
      assertUploadAllowed(grant, 10, null);
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as BaseclfError).status).toBe(415);
    }
  });

  it('accepts any type when the policy lists none', () => {
    const anything = authorizeStorage({
      buckets: registry(withMime(undefined)),
      bucket: 'avatars',
      operation: 'upload',
      auth: ANN,
      fileName: 'anything.bin',
    });

    expect(() => assertUploadAllowed(anything, 10, 'application/octet-stream')).not.toThrow();
  });

  it('cannot enforce a length nobody declared', () => {
    // Recorded rather than worked around, because it is the reason the router
    // still has to cap the stream it writes. A caller that omits Content-Length,
    // or understates it, passes this check and then sends whatever it likes.
    expect(() => assertUploadAllowed(grant, null, 'image/png')).not.toThrow();
  });

  /**
   * The same bucket with one upload policy and the declared types replaced.
   *
   * Built rather than spread from `AVATARS`, because `allowedMimeTypes` is an
   * optional property and spreading `undefined` into it is a different thing from
   * leaving it out. Writing the policy whole makes "the deployment listed no
   * types" unambiguous.
   */
  function withMime(types: readonly string[] | undefined): StorageBucketDefinition {
    return {
      bucket: 'avatars',
      enabled: true,
      policies: [
        {
          name: 'upload_relaxed',
          for: 'upload',
          to: ['authenticated'],
          prefix: 'avatars/$auth.uid/',
          maxSizeBytes: 1_000_000,
          ...(types === undefined ? {} : { allowedMimeTypes: types }),
        },
      ],
    };
  }
});
