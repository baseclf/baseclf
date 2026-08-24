/**
 * `baseclf storage` — write a bucket's rules without writing SQL.
 *
 * Storage policies have been storable since V4 and there has been no way to store
 * one except an `INSERT` typed by hand. That is the same gap `baseclf policy` was
 * inserted to close for tables: a product that deploys but cannot be configured is a
 * product that deploys.
 *
 * Everything security-shaped is borrowed rather than rebuilt. The document is
 * validated by the engine's own `validateStorageBucket`, the credential is resolved
 * the way every other command resolves it, and the write order is the one that keeps
 * every half-finished state closed. See `storage-document.ts` for both.
 */

import { STORAGE_SCHEMA } from '../src/storage/schema.js';
import { type D1Endpoint, runSql } from './d1-api.js';
import { nextAction, note, type Style, styledResultLine } from './output.js';
import { DEFAULT_PROJECT, endpointFor, type PolicyHost, type PolicyOutcome } from './policy.js';
import {
  readStorageDocument,
  type StorageDocument,
  storageRemoveStatements,
  storageWriteStatements,
} from './storage-document.js';

type Write = (line: string) => void;

export const STORAGE_USAGE = [
  'baseclf storage apply <file>    Store the bucket rules in this file',
  'baseclf storage list            Show which buckets are registered, and how many rules each has',
  'baseclf storage rm <bucket>     Stop serving a bucket, and delete its rules',
  '',
  'Options:',
  '  --project <name>   Which deployment. Defaults to "baseclf", the same default',
  '                     create-baseclf uses, which is also the database name.',
  '  --confirm          Required by rm. Deleting rules is not undoable.',
  '',
  'A document looks like this:',
  '',
  '  {',
  '    "bucket": "avatars",',
  '    "enabled": true,',
  '    "policies": [',
  '      { "name": "upload_own", "for": "upload", "to": ["authenticated"],',
  '        "prefix": "avatars/$auth.uid/", "maxSizeBytes": 1048576,',
  '        "allowedMimeTypes": ["image/png"] },',
  '      { "name": "list_own", "for": "list", "to": ["authenticated"],',
  '        "prefix": "avatars/$auth.uid/" }',
  '    ]',
  '  }',
  '',
  'The prefix is a template, and the claim in it is what makes one directory per',
  'caller. It has to end in "/", because without the separator a prefix also matches',
  'keys belonging to any id that merely starts the same way.',
  '',
  'Applying is safe to repeat. It replaces every rule on that bucket, and while it',
  'runs the bucket is not served at all, so an interrupted run leaves it closed',
  'rather than half open.',
].join('\n');

interface Options {
  readonly project: string;
  readonly confirm: boolean;
  readonly rest: readonly string[];
}

/**
 * Read the flags.
 *
 * Unknown options are refused rather than ignored, for the reason the policy command
 * gives: a misspelled `--project` that was skipped would write into whichever
 * deployment the default names, and that is a mistake only noticed from the other
 * side.
 */
export function parseStorageOptions(argv: readonly string[]): Options | { readonly error: string } {
  let project = DEFAULT_PROJECT;
  let confirm = false;
  const rest: string[] = [];

  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at];
    if (argument === undefined) continue;

    if (argument === '--confirm') {
      confirm = true;
      continue;
    }
    if (argument === '--project') {
      const value = argv[at + 1];
      if (value === undefined || value.startsWith('--')) {
        return { error: '--project needs a name after it.' };
      }
      project = value;
      at += 1;
      continue;
    }
    if (argument.startsWith('--')) {
      return { error: `there is no ${argument} option.` };
    }

    rest.push(argument);
  }

  return { project, confirm, rest };
}

function explain(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function loadDocument(
  host: PolicyHost,
  file: string,
  write: Write,
  style: Style,
): StorageDocument | null {
  const text = host.readFile(file);
  if (text === undefined) {
    write(styledResultLine('deny', `There is no file at ${file}.`, style));
    return null;
  }

  try {
    return readStorageDocument(text);
  } catch (cause) {
    write(styledResultLine('deny', 'That document was refused.', style));
    write(note(explain(cause)));
    return null;
  }
}

interface BucketRow {
  bucket: string;
  enabled: number;
  version: number;
}

/** The version this bucket is on, or zero when it has never been written. */
async function storedVersion(endpoint: D1Endpoint, bucket: string): Promise<number> {
  const [result] = await runSql(
    endpoint,
    'SELECT "version" FROM "_storage_buckets" WHERE "bucket" = ?1',
    [bucket],
  );
  const row = (result?.rows ?? [])[0] as { version?: unknown } | undefined;
  return typeof row?.version === 'number' ? row.version : 0;
}

async function apply(
  endpoint: D1Endpoint,
  document: StorageDocument,
  write: Write,
  style: Style,
): Promise<PolicyOutcome> {
  const { bucket, policies } = document.definition;

  // The whole storage schema, from the engine's own constant, for the reason the
  // policy command records: the Worker creates these tables on a request to
  // `/rest/v1` or `/storage/v1`, so a deployment that has been created and checked
  // but never asked for data has none of them, and this would otherwise fail with a
  // raw SQLite error naming a table the reader has never heard of.
  for (const statement of STORAGE_SCHEMA) await runSql(endpoint, statement);

  const version = (await storedVersion(endpoint, bucket)) + 1;

  // One statement per request, because the endpoint refuses parameters otherwise.
  // The first one closes the bucket and the last one opens it, so an interruption
  // leaves it unreachable rather than reachable with half a rule set.
  for (const statement of storageWriteStatements(document, version)) {
    await runSql(endpoint, statement.sql, statement.params);
  }

  write(
    styledResultLine(
      'allow',
      `"${bucket}" is registered with ${policies.length} ${policies.length === 1 ? 'rule' : 'rules'}, version ${version}.`,
      style,
    ),
  );

  // The addresses rather than a description of them. A reader who has just written
  // their first storage policy has no other way to know what the URL looks like, and
  // the shape is the part that is not guessable: one segment is the bucket, a second
  // is a file name, and there is never a third.
  write(
    nextAction({
      goal: 'use it',
      steps: [
        'Upload with a bearer token, and list what is there. One segment is the',
        'bucket, a second is a file name, and there is never a third.',
      ],
      copy: [
        `PUT  https://<deployment>/storage/v1/${bucket}/<file-name>`,
        `GET  https://<deployment>/storage/v1/${bucket}`,
      ],
      verify: 'baseclf storage list',
    }),
  );

  // ⚠️ Not a number, on purpose. Measured twice on a real deployment and the answers
  // were 57 seconds and over 393 seconds apart, for the same code and the same
  // traffic. A reader told "about a minute" reads a six minute wait as a fault.
  write(note('A change reaches a running deployment once its isolates recycle.'));

  return 'ok';
}

async function list(endpoint: D1Endpoint, write: Write, style: Style): Promise<PolicyOutcome> {
  // `.rows`, not the result. The policy command has a comment about getting this
  // wrong and `as` bridging the difference silently; the same shape is here.
  const [bucketResult] = await runSql(
    endpoint,
    'SELECT "bucket", "enabled", "version" FROM "_storage_buckets" ORDER BY "bucket"',
  );
  const [countResult] = await runSql(
    endpoint,
    'SELECT "bucket", COUNT(*) AS "n" FROM "_storage_policies" GROUP BY "bucket"',
  );

  const counts = new Map(
    (countResult?.rows ?? []).map((row) => {
      const { bucket, n } = row as { bucket: string; n: number };
      return [bucket, n] as const;
    }),
  );

  const buckets = (bucketResult?.rows ?? []).map((row) => row as BucketRow);

  if (buckets.length === 0) {
    write(styledResultLine('attention', 'No bucket is registered.', style));
    write(note('Nothing can be uploaded or read through /storage/v1 until one is.'));
    write(note('Write a document and run: baseclf storage apply <file>'));
    return 'ok';
  }

  for (const row of buckets) {
    const rules = counts.get(row.bucket) ?? 0;

    // A bucket with no rules is not a working bucket. Invariant I1 makes the engine
    // refuse every request for it, so reporting it as registered and nothing else
    // would report the opposite of what a request will get.
    const verdict = row.enabled === 1 && rules > 0 ? 'allow' : 'attention';
    const why =
      row.enabled !== 1
        ? 'disabled'
        : rules === 0
          ? 'no rules, so every request is refused'
          : `${rules} ${rules === 1 ? 'rule' : 'rules'}`;

    write(styledResultLine(verdict, `${row.bucket}: ${why}, version ${row.version}`, style));
  }

  return 'ok';
}

function refuseUnconfirmed(bucket: string, write: Write, style: Style): PolicyOutcome {
  write(styledResultLine('attention', `This would delete every rule on "${bucket}".`, style));
  write(note('The objects stay in R2. What goes is the only thing that lets anybody'));
  write(note('reach them through this deployment, and it is not recoverable from here.'));
  write(
    nextAction({
      goal: 'remove it anyway',
      steps: ['Run it again with the flag, if that is what you want:'],
      copy: `baseclf storage rm ${bucket} --confirm`,
    }),
  );
  return 'usage';
}

async function remove(
  endpoint: D1Endpoint,
  bucket: string,
  write: Write,
  style: Style,
): Promise<PolicyOutcome> {
  for (const statement of storageRemoveStatements(bucket)) {
    await runSql(endpoint, statement.sql, statement.params);
  }

  // Said without claiming the bucket was there. `DELETE` on a row that does not
  // exist is not an error, and reporting "removed" for a name nobody registered
  // would be a sentence a reader could act on wrongly.
  write(styledResultLine('allow', `"${bucket}" is not served by this deployment.`, style));
  write(note('Any objects already in R2 are still in R2. This removed the rules.'));
  return 'ok';
}

export async function runStorage(
  argv: readonly string[],
  write: Write,
  style: Style,
  host: PolicyHost,
): Promise<PolicyOutcome> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    write(STORAGE_USAGE);
    return argv.length === 0 ? 'usage' : 'ok';
  }

  const parsed = parseStorageOptions(argv);
  if ('error' in parsed) {
    write(`baseclf storage: ${parsed.error}\n\n${STORAGE_USAGE}`);
    return 'usage';
  }

  const [verb, target] = parsed.rest;

  if (verb !== 'apply' && verb !== 'list' && verb !== 'rm') {
    write(
      verb === undefined
        ? `baseclf storage needs a verb.\n\n${STORAGE_USAGE}`
        : `baseclf storage: there is no "${verb}" verb.\n\n${STORAGE_USAGE}`,
    );
    return 'usage';
  }

  if (verb !== 'list' && target === undefined) {
    write(`baseclf storage ${verb} needs ${verb === 'apply' ? 'a file' : 'a bucket name'}.`);
    return 'usage';
  }

  // Before the credential, so the first thing that is wrong is the thing reported.
  // A reader who mistyped a filename should not be told to log in first.
  const document = verb === 'apply' ? loadDocument(host, target ?? '', write, style) : null;
  if (verb === 'apply' && document === null) return 'usage';

  if (verb === 'rm' && !parsed.confirm) return refuseUnconfirmed(target ?? '', write, style);

  const resolved = await host.credentials();
  if (resolved === null) return 'failed';
  for (const warning of resolved.warnings) write(note(warning));

  const endpoint = await endpointFor(host, resolved.credentials, parsed.project, write, style);
  if (endpoint === null) return 'failed';

  try {
    if (verb === 'list') return await list(endpoint, write, style);
    if (verb === 'rm') return await remove(endpoint, target ?? '', write, style);
    if (document === null) return 'usage';
    return await apply(endpoint, document, write, style);
  } catch (cause) {
    write(styledResultLine('deny', 'The database refused that.', style));
    write(note(explain(cause)));
    return 'failed';
  }
}

export const STORAGE_FIXED_TEXT: readonly string[] = Object.freeze([STORAGE_USAGE]);
