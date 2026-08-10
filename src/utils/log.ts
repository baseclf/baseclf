/**
 * The only file in the project that writes to the console.
 *
 * Rule 00 invariant I9 says to log the SQL and how many values it binds, never
 * the values themselves: they are user data and logs are the easiest place in
 * any system to leak it from. Stating that as a convention would leave it to be
 * remembered. Stating it as a type does not.
 *
 * Every event below is a closed shape with no field that could hold a parameter
 * value, a token, a password or a row. There is no `unknown`, no index
 * signature, and no variadic tail, so `logEvent` cannot be handed one. Adding a
 * field that could is a visible change to this file, which is the point.
 *
 * biome.json allows `console.log` here and nowhere else.
 */

export interface QueryEvent {
  readonly event: 'query';
  /** The compiled statement. It holds placeholders, never values. */
  readonly sql: string;
  readonly paramCount: number;
  /** Rows D1 scanned. What the bill is calculated from. */
  readonly rowsRead?: number;
}

export interface PolicyRefusalEvent {
  readonly event: 'policy_refusal';
  readonly code: string;
  readonly table: string;
  readonly operation: string;
  readonly role: string;
}

export interface ErrorEvent {
  readonly event: 'error';
  readonly code: string;
  /** Server-side diagnostic text. Never sent to a client. */
  readonly detail: string;
}

/**
 * Something happened on the identity path.
 *
 * `reason` is a closed set of literals rather than a string, so this event
 * cannot become somewhere a token, a claim or a key ends up. That is the same
 * argument as the rest of this file, applied to the one area where a careless
 * log line does the most damage.
 */
export interface AuthEvent {
  readonly event: 'jwks_refresh';
  readonly reason: 'no_matching_key';
}

export type LogEvent = QueryEvent | PolicyRefusalEvent | ErrorEvent | AuthEvent;

export function logEvent(event: LogEvent): void {
  console.log(JSON.stringify(event));
}

export function logError(event: ErrorEvent): void {
  console.error(JSON.stringify(event));
}
