/**
 * Every policy document the README and `examples/` show, run through the engine.
 *
 * 🔴 These are the documents somebody copies on their first day, and until this
 * existed nothing checked them. The README's example had been verified once, by hand,
 * on the day it was written. A change to the DSL would have left it wrong with a green
 * suite, and the reader would find out from a refusal on their own deployment while
 * following the instructions.
 *
 * Checked with `readPolicyDocument`, which is what `baseclf policy apply` calls, so
 * this fails for the reasons a real apply fails.
 *
 * ⚠️ Not `parseTableDefinition`, and the difference is not academic. The first draft
 * of this file used the parser directly and the refused example **parsed fine**: the
 * parser only walks the binds some policy refers to, and that example's forbidden bind
 * is referenced by nothing. Checking one layer below the one the command uses is how a
 * test comes to disagree with the product it is testing.
 *
 * What none of this can check is the catalogue. `validateTableDefinition` needs a live
 * schema, and the README describes its table in prose rather than owning one.
 */
import { describe, expect, it } from 'vitest';
import accepted from '../examples/posts.policy.json?raw';
import refused from '../examples/posts.refused.policy.json?raw';
import readme from '../README.md?raw';
import { readPolicyDocument } from './policy-document.js';
import { readStorageDocument } from './storage-document.js';

/**
 * The fenced blocks that are whole policy documents.
 *
 * A block naming `table` and `policies` is a document. The others in the README are
 * single policies shown on their own, which the parser has no entry point for and
 * which are not what anybody copies into a file.
 */
function policyDocumentsIn(markdown: string): string[] {
  const blocks = markdown.matchAll(/```jsonc?\n([\s\S]*?)```/g);

  return (
    [...blocks]
      .map(([, body]) => body ?? '')
      // The README uses jsonc so it can annotate a line. Comments are stripped rather
      // than banned, because the annotation is why those examples read well.
      .map((body) => body.replace(/\s*\/\/.*$/gm, ''))
      .filter((body) => body.includes('"table"') && body.includes('"policies"'))
  );
}

/**
 * The fenced blocks that are whole storage documents.
 *
 * Same rule as above, on the other pair of keys. Added when `baseclf storage`
 * arrived and the README stopped showing raw SQL: the storage example became a
 * document somebody copies on their first day, with nothing checking it, which is
 * precisely the state this file was written to end for table policies.
 */
function storageDocumentsIn(markdown: string): string[] {
  const blocks = markdown.matchAll(/```jsonc?\n([\s\S]*?)```/g);

  return [...blocks]
    .map(([, body]) => body ?? '')
    .map((body) => body.replace(/\s*\/\/.*$/gm, ''))
    .filter((body) => body.includes('"bucket"') && body.includes('"policies"'));
}

describe('the storage documents a reader copies', () => {
  it('finds them rather than silently checking nothing', () => {
    expect(storageDocumentsIn(readme).length).toBeGreaterThanOrEqual(1);
  });

  it('accepts every storage document in the README', () => {
    // Through `readStorageDocument`, which is what `baseclf storage apply` calls, so
    // this fails for the reasons a real apply fails. A prefix missing its trailing
    // separator is the one a reader is most likely to copy wrong, and the engine
    // refuses it rather than storing a rule that reaches into a neighbouring id.
    for (const document of storageDocumentsIn(readme)) {
      expect(() => readStorageDocument(document)).not.toThrow();
    }
  });

  it('shows documents that would actually serve something', () => {
    // The same trap as the table example had: a document that parses, stores, and
    // reaches nobody. Absent means enabled for a storage document, so this catches an
    // example written with `enabled: false` rather than one that omitted the field.
    for (const document of storageDocumentsIn(readme)) {
      expect(readStorageDocument(document).definition.enabled).toBe(true);
      expect(readStorageDocument(document).definition.policies.length).toBeGreaterThan(0);
    }
  });
});

describe('the documents a reader copies', () => {
  it('finds the README documents rather than silently checking nothing', () => {
    // ⚠️ Without this the suite passes when the regex stops matching, which is the
    // failure this whole file exists to prevent, one level up.
    expect(policyDocumentsIn(readme).length).toBeGreaterThanOrEqual(3);
  });

  it('accepts every policy document in the README', () => {
    // 🔴 This failed the first time it ran, on the example under "Declare a policy
    // once, as data", which is the first document a reader sees. Its `read_published`
    // policy had no `columns`, and a policy with no columns grants nothing, so the
    // engine refuses it. The front page had been showing a document the product would
    // not accept, and it took a test to notice.
    for (const document of policyDocumentsIn(readme)) {
      expect(() => readPolicyDocument(document)).not.toThrow();
    }
  });

  it('shows documents that would actually expose something', () => {
    // 🔴 The same example was also missing `enabled`, which parses and stores and
    // reaches nobody. Absent means closed, by invariant I1, so the default is right
    // and the example was wrong. Applying it against a live deployment is what
    // surfaced it: the command stored two rules and then said the table could not be
    // reached, which no assertion about parsing would ever have said.
    //
    // The parse test above cannot catch this, because a disabled document is valid.
    for (const document of policyDocumentsIn(readme)) {
      expect(readPolicyDocument(document).definition.enabled).toBe(true);
    }
  });

  it('accepts the example that is meant to be applied', () => {
    const { definition } = readPolicyDocument(accepted);

    expect(definition.table).toBe('posts');
    expect(definition.enabled).toBe(true);
    // ⚠️ A literal list rather than a count, and it earns its keep: adding `write_own`
    // for the sample application broke this, which is how the prose in
    // `examples/README.md` got corrected in the same change. That file said nobody
    // had an insert policy, and it would have gone on saying so.
    expect(definition.policies.map((policy) => policy.name)).toEqual([
      'read_published',
      'read_own_or_published',
      'update_own',
      'write_own',
    ]);
  });

  it('refuses the example that is meant to be refused', () => {
    // Invariant I4, in the form the README claims it takes: the bind holding
    // `$auth.user.id` is referenced by no policy, so a check that only walked the
    // policies would accept this and store it.
    expect(() => readPolicyDocument(refused)).toThrow(/user metadata/i);
  });
});
