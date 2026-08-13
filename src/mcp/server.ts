/**
 * The MCP endpoint.
 *
 * ## What this file does not do
 *
 * ⭐ Almost none of the protocol. Measured on 2026-08-12 by reading the installed
 * packages rather than the documentation: `@modelcontextprotocol/server@2.0.0` already
 * carries `-32020` header-mismatch handling, the `Mcp-Method` and `Mcp-Name` headers,
 * `server/discover`, `ttlMs` and `cacheScope`, `resultType`, `inputRequests`, and
 * `text/event-stream`. `agents@0.20.1` carries the Worker-facing half.
 *
 * So the transport is not ours to write, and writing any of it again would be a second
 * implementation to keep in step with a specification that changed twice this year.
 * What is ours: who may call, what the tools are, and the boundary around data those
 * tools return.
 *
 * ## Two corrections to the note this was built from
 *
 * `skills/mcp-server` said the `2026-07-28` revision left only Streamable HTTP and that
 * SSE was gone. Verified against the spec: **SSE is not gone.** A server MUST be able to
 * answer a request with either `application/json` or `text/event-stream`, and stdio is
 * still a transport. What was removed is the standalone GET stream, protocol sessions,
 * and `Last-Event-ID` resumability. The SDK handles all of it; the correction matters
 * because a reader of that note would have gone looking for code to delete.
 *
 * ## Origin
 *
 * The spec makes Origin validation a MUST, against DNS rebinding. `createMcpHandler`
 * does it: `allowedOriginHostnames` defaults to localhost-class origins plus the
 * endpoint's own `workers.dev` hostname. A deployment on a custom domain has to say so,
 * which is why the option is set from the request rather than left out.
 */

import {
  getOAuthProtectedResourceMetadataUrl,
  McpServer,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';

// No import attribute, deliberately. See the note in `src/index.ts`.
import { version as BASECLF_VERSION } from '../../package.json';

import { createTokenVerifier, MCP_SCOPE, protectedResourceMetadata } from './auth.js';
import { type McpToolEnv, registerTools } from './tools/index.js';

/** The one path this endpoint answers on. */
export const MCP_ROUTE = '/mcp';

/** Where the RFC 9728 document lives, derived the way the SDK derives it. */
export function metadataUrlFor(origin: string): string {
  return getOAuthProtectedResourceMetadataUrl(new URL(`${origin}${MCP_ROUTE}`));
}

/**
 * The server, built per request.
 *
 * Stateless by design: `McpAgent` was deprecated in `agents@0.20.0` and the current
 * shape is a fresh server per request with no Durable Object behind it. Building it
 * inside the request also keeps it off the one-second startup budget (`rules/02` §A).
 *
 * Rebuilding per request costs nothing worth counting: the tools close over `env`,
 * and the catalogue and registry behind them are memoised per isolate, so a second
 * request registers four objects and reads no database.
 */
export function createServer(env: McpToolEnv): McpServer {
  // ⚠️ Read from the manifest. This said 0.1.0 while the package was 0.4.0, which is
  // the version a client is handed in the handshake and the one it would quote while
  // reporting that a tool behaved oddly. Third surface with the same fault in one
  // day: `/health` answered 0.0.0 and neither binary had a `--version` at all.
  const server = new McpServer({ name: 'baseclf', version: BASECLF_VERSION });
  registerTools(server, env);
  return server;
}

/**
 * Serve the RFC 9728 metadata, or nothing when the path is not it.
 *
 * Returns `undefined` rather than a 404 so the caller can fall through to its own
 * routing, which is the shape the SDK's own helper uses.
 */
export function metadataResponse(request: Request): Response | undefined {
  const url = new URL(request.url);
  const expected = new URL(metadataUrlFor(url.origin)).pathname;

  if (url.pathname !== expected) return undefined;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  // Public by definition: a discovery document exists to be read by clients that
  // have not authenticated yet, which is the whole point of the 401 pointing at it.
  return Response.json(protectedResourceMetadata(new URL(`${url.origin}${MCP_ROUTE}`)), {
    headers: { 'cache-control': 'public, max-age=3600' },
  });
}

/**
 * Answer a request on the MCP endpoint.
 *
 * ⚠️ The bearer gate runs first and its refusal is returned as-is. `requireBearerAuth`
 * returns either an `AuthInfo` or a `Response`, and that Response already carries the
 * `WWW-Authenticate` challenge naming the metadata URL, which is what lets an
 * unauthenticated client discover how to authenticate. Rebuilding that response here
 * would drop the header that makes the endpoint discoverable.
 */
export async function handleMcp(request: Request, env: McpToolEnv): Promise<Response> {
  const url = new URL(request.url);
  const resource = new URL(`${url.origin}${MCP_ROUTE}`);

  const gate = requireBearerAuth({
    verifier: createTokenVerifier(env, resource),
    requiredScopes: [MCP_SCOPE],
    resourceMetadataUrl: metadataUrlFor(url.origin),
  });

  const auth = await gate(request);
  if (auth instanceof Response) return auth;

  // ⚠️ Not `export default createMcpHandler(...)`. Wrangler reads a bare default
  // export that is a function as a `WorkerEntrypoint`, so the handler is built and
  // called inside `fetch` instead.
  const handler = createMcpHandler(() => createServer(env), {
    route: MCP_ROUTE,
    // The deployment's own hostname, whatever it is. The default covers
    // `workers.dev` and localhost; a custom domain would otherwise be refused by
    // the Host check with nothing saying why.
    allowedHostnames: [url.hostname],
    authContext: { props: { clientId: auth.clientId, scopes: auth.scopes } },
  });

  return handler.fetch(request);
}
