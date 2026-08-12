/**
 * One shape for every tool answer, and one place that decides what a refusal says.
 *
 * ## Why this is not written per tool
 *
 * A tool that catches its own errors and builds its own payload is a tool that can
 * disagree with the rest of the engine about invariant I5. That already happened
 * once: in V2 the status and the message were made identical for "not there" and
 * "not yours", and the `code` field still told them apart, which is the same side
 * channel wearing a different hat.
 *
 * The HTTP path collapses every 404 through `BaseclfError.toResponseBody`. So does
 * this, by calling it rather than by reimplementing the rule, because the rule is
 * "any 404 added later is covered without anyone remembering this".
 *
 * ## What the model sees
 *
 * ⚠️ The fence goes around `content`, which is the text a model reads, and not
 * around `structuredContent`, which is a parsed object for the client. A client
 * that flattens `structuredContent` straight into a prompt gets unfenced data and
 * this file cannot stop it. That is a real limit, written down rather than papered
 * over.
 */

import { BaseclfError } from '../../utils/errors.js';
import { wrapWithUntrustedDataBoundary } from '../boundary.js';

/**
 * What `registerTool` handlers return. Structural, so the SDK types stay at the edge.
 *
 * ⚠️ A `type` rather than an `interface`, and the array is not `readonly`. Both are
 * forced by the SDK's `CallToolResult`, which carries an index signature: TypeScript
 * gives an implicit index signature to a type alias and not to an interface, and a
 * `readonly` array is not assignable to a mutable one. Found by the compiler, which
 * is the right way to find it.
 */
export type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Answer with data.
 *
 * `structuredContent` is mandatory once a tool declares an `outputSchema`, and all
 * four of these do. Measured against the installed SDK on 2026-08-12: it throws
 * `-32602` when the schema is there and the structured half is not, so this is the
 * only correct success shape rather than a stylistic choice.
 */
export function toolSuccess(structured: Record<string, unknown>): ToolResult {
  return {
    content: [
      { type: 'text', text: wrapWithUntrustedDataBoundary(JSON.stringify(structured, null, 2)) },
    ],
    structuredContent: structured,
  };
}

/**
 * Answer with a refusal.
 *
 * ⚠️ Returned rather than thrown. A throw reaches the SDK, which puts
 * `error.message` into the reply verbatim, so any error the engine raises with a
 * detailed message would be published by a layer that never agreed to publish it.
 * Going through `toResponseBody` keeps `detail` server-side, which is exactly the
 * split invariant I9 draws: the person who deployed this sees the reason, the
 * person probing it sees "Not found."
 *
 * An unknown error says nothing at all. It is not ours to describe, and describing
 * it is how a stack trace ends up in a transcript.
 */
export function toolFailure(error: unknown): ToolResult {
  const body =
    error instanceof BaseclfError
      ? error.toResponseBody()
      : { error: 'The request could not be completed.', code: 'INTERNAL' };

  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    isError: true,
  };
}

/** Run a tool body, and make sure both exits go through the shapes above. */
export async function runTool(body: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    return toolSuccess(await body());
  } catch (error) {
    return toolFailure(error);
  }
}
