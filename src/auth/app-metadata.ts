/**
 * Server-set claims, and the store they come from.
 *
 * `$auth.app.*` is the sanctioned counterpart of the forbidden `user_metadata`
 * (rule 00, invariant I4): a policy may trust it precisely because the end user
 * has no way to write it. Until this table existed that trust had nothing behind
 * it. `definePayload` emitted an empty object, so a policy referencing
 * `$auth.app.plan` compiled, ran, and never matched a row: fail-closed, and also
 * useless. Debt 13.
 *
 * ## Who writes it, and who reads it
 *
 * Written only by the operator, from their own machine, over the D1 REST API
 * (`baseclf user set-app`). There is deliberately no HTTP surface on the Worker
 * that writes here: an endpoint that grants claims is an escalation surface, and
 * the product does not need one to exist.
 *
 * Read once per token mint, inside `definePayload`, so a change lands in the
 * next JWT the user exchanges their session for. Tokens live fifteen minutes,
 * so that is the propagation bound, and the CLI says so rather than implying it
 * is instant.
 *
 * The `_` prefix keeps the table off every public surface through the same
 * independent layers every engine table already relies on (rule 00, I8).
 */

import type { D1Executor } from '../db/dialect.js';
import { assertExecutable, type CompiledStatement } from '../db/guards.js';
import { BaseclfError } from '../utils/errors.js';
import { logEvent } from '../utils/log.js';

export const APP_METADATA_TABLE = '_app_metadata';

/**
 * The whole document rides inside every JWT this user is minted, and the JWT
 * rides on every request. A generous claim set is a few hundred bytes; this cap
 * exists so a paste mistake does not turn every request into a megabyte.
 */
export const MAX_APP_METADATA_BYTES = 2048;

/** Nesting deeper than this is a structure, not a claim set. */
const MAX_DEPTH = 3;

/**
 * The same shape the rest of the engine accepts for names. A claim is addressed
 * from policy documents as `$auth.app.<key>`, so a key the policy grammar cannot
 * spell is a claim nothing can ever read.
 */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * STRICT with an explicit NOT NULL key, like every engine table, because an
 * ordinary `TEXT PRIMARY KEY` accepts NULL (measured, rules/01 section G1) and
 * a claims row no lookup can find is a grant that exists and does nothing.
 */
export const APP_METADATA_DDL = `CREATE TABLE IF NOT EXISTS _app_metadata (
     user_id    TEXT    PRIMARY KEY NOT NULL,
     metadata   TEXT    NOT NULL,
     updated_at INTEGER NOT NULL
   ) STRICT`;

export const APP_METADATA_SCHEMA: readonly string[] = Object.freeze([APP_METADATA_DDL]);

function invalid(message: string): BaseclfError {
  return new BaseclfError('INVALID_EXPR', 400, { message });
}

/**
 * Only shapes JSON can carry without changing them. `JSON.stringify` silently
 * drops a function or an `undefined` inside an object, which would store
 * something different from what the operator wrote, so those are refused here
 * rather than quietly edited out.
 */
function assertClaimValue(value: unknown, depth: number, path: string): void {
  if (depth > MAX_DEPTH) {
    throw invalid(`"${path}" nests deeper than ${MAX_DEPTH} levels. Claims are flat facts.`);
  }

  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(`"${path}" is not a finite number.`);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertClaimValue(item, depth + 1, `${path}[${index}]`);
    });
    return;
  }

  if (typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (!KEY_PATTERN.test(key)) {
        throw invalid(
          `"${path}.${key}" is not a usable claim name. Use letters, digits and "_", starting with a letter.`,
        );
      }
      assertClaimValue(inner, depth + 1, `${path}.${key}`);
    }
    return;
  }

  throw invalid(`"${path}" is a ${typeof value}, which JSON cannot carry.`);
}

/**
 * The document an operator may store, or a refusal saying which part is not one.
 *
 * Validated where it is saved rather than where it is read, the same discipline
 * rule 00 I4 demands of policy documents: a bad document must never reach the
 * database, because the read side runs on every token mint and is the wrong
 * place to discover it.
 */
export function validateAppMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('App metadata must be one JSON object of claims.');
  }

  const document = value as Record<string, unknown>;
  for (const [key, inner] of Object.entries(document)) {
    if (!KEY_PATTERN.test(key)) {
      throw invalid(
        `"${key}" is not a usable claim name. Use letters, digits and "_", starting with a letter.`,
      );
    }
    assertClaimValue(inner, 2, key);
  }

  const bytes = new TextEncoder().encode(JSON.stringify(document)).length;
  if (bytes > MAX_APP_METADATA_BYTES) {
    throw invalid(
      `This document is ${bytes} bytes and the ceiling is ${MAX_APP_METADATA_BYTES}. ` +
        'It travels inside every JWT this user is minted, on every request.',
    );
  }

  return document;
}

/**
 * Store one user's claims, replacing whatever was there.
 *
 * One statement, so there is no moment where the row is half written. `?2` is
 * reused by ordinal, which hand-written SQL may do (rules/01 section G7) even
 * though the query builder cannot.
 */
export function upsertAppMetadataStatement(userId: string, metadata: unknown): CompiledStatement {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw invalid('A user id is required.');
  }

  const document = validateAppMetadata(metadata);

  const statement: CompiledStatement = {
    sql:
      `INSERT INTO ${APP_METADATA_TABLE} (user_id, metadata, updated_at) ` +
      `VALUES (?1, ?2, unixepoch()) ` +
      `ON CONFLICT(user_id) DO UPDATE SET metadata = ?2, updated_at = unixepoch()`,
    parameters: [userId, JSON.stringify(document)],
  };
  assertExecutable(statement);
  return statement;
}

/**
 * The claims stored for one user, or an empty object.
 *
 * Empty on a missing row, and empty on a row this file's writer cannot have
 * produced. Absent claims only ever narrow what a policy grants, so the failure
 * direction is closed; the log line is where the operator finds out their store
 * holds something the validator would have refused.
 */
export async function readAppMetadata(
  executor: D1Executor,
  userId: string,
): Promise<Record<string, unknown>> {
  const statement: CompiledStatement = {
    sql: `SELECT metadata FROM ${APP_METADATA_TABLE} WHERE user_id = ?1`,
    parameters: [userId],
  };
  assertExecutable(statement);

  const row = await executor
    .prepare(statement.sql)
    .bind(...statement.parameters)
    .first<{ metadata?: unknown }>();

  if (row === null || typeof row?.metadata !== 'string') return {};

  try {
    const parsed: unknown = JSON.parse(row.metadata);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Falls through to the log line below.
  }

  logEvent({ event: 'app_metadata_ignored', reason: 'stored value is not a JSON object' });
  return {};
}
