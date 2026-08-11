/**
 * What the CLI is allowed to print.
 *
 * The CLI is a product surface, so the rules in `_design_system` apply to it the
 * same way they apply to a screen. Four of them are load-bearing here and the
 * fourth is the one that decides whether onboarding works at all:
 *
 *   1. **Three colours, and that is the entire palette.** allow to ANSI 2, deny to
 *      ANSI 1, attention to ANSI 3. A terminal cannot read a CSS token, so this
 *      mapping is the whole of colour in the CLI. Nothing else is coloured.
 *   2. **A signal is never colour alone.** Every one carries a mark as well, because
 *      roughly one male developer in twelve cannot tell this green from this red,
 *      and because a piped log has no colour at all.
 *   3. **No emoji, no exclamation marks, no em-dash.** Checkable, so it is checked:
 *      see `findVoiceViolations`, which the tests run over everything this file
 *      produces.
 *   4. **A copyable value goes on its own line, unindented.** That is not a
 *      formatting preference. A redirect URI with two spaces in front of it does
 *      not double-click cleanly, and the person who mis-pastes it gets
 *      `redirect_uri_mismatch` from Google with nothing in any log to explain it.
 *      This is the step people give up at (see the auth skill, trap 1).
 *
 * Nothing here imports from `node:`. The rendering is string building, so it can be
 * tested in the same runner as the rest of the project, and the Node-specific
 * shell stays thin enough to read in one go. The discipline is deliberate rather
 * than enforced: `tsconfig` has Node types in scope everywhere.
 */

/** The only three signals that exist. `_design_system/DESIGN.md` section 5. */
export type Verdict = 'allow' | 'deny' | 'attention';

/**
 * The whole palette.
 *
 * Foreground 31, 32, 33 are the standard ANSI red, green and yellow. Deliberately
 * not the bright variants: on a light terminal the bright greens wash out, and the
 * mark carries the meaning anyway.
 */
const ANSI_CODE: Readonly<Record<Verdict, number>> = Object.freeze({
  allow: 32,
  deny: 31,
  attention: 33,
});

/**
 * The mark that makes a signal readable without colour.
 *
 * `✓` and `✗` are dingbats rather than emoji, which is why they survive the emoji
 * ban: they render as text in a monospace terminal and carry no skin tone, no
 * variant selector and no colour of their own.
 */
const MARK: Readonly<Record<Verdict, string>> = Object.freeze({
  allow: '✓',
  deny: '✗',
  // Not '!', and the reason is worth recording because the obvious fix was the
  // wrong one. The voice rule bans exclamation marks anywhere a reader sees them,
  // and `findVoiceViolations` enforces it, so the first version of this file failed
  // its own checker. The tempting repair is to carve out "a lone ! used as a glyph",
  // and DESIGN.md answers that directly: the rule is binary because "use sparingly"
  // was tried and did not hold. So the mark changed rather than the rule.
  //
  // A geometric shape rather than a dingbat like the other two, which is a small
  // inconsistency accepted on purpose: the alternatives are '⚠', which many
  // terminals promote to a colour emoji, and '*', which reads as a footnote.
  attention: '▲',
});

/** The frames a spinner cycles through while a step is running. */
export const SPINNER_FRAMES: readonly string[] = Object.freeze([
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
]);

export interface Style {
  /**
   * Whether to emit escape codes at all.
   *
   * The caller decides, because deciding needs `process` and this file does not
   * import it. A terminal that is not a TTY, or a `NO_COLOR` in the environment,
   * means false, and then the marks are the only signal left, which is why they
   * are not optional.
   */
  readonly colour: boolean;
}

export const PLAIN: Style = Object.freeze({ colour: false });

function paint(text: string, verdict: Verdict, style: Style): string {
  if (!style.colour) return text;
  return `[${ANSI_CODE[verdict]}m${text}[0m`;
}

/**
 * One result line.
 *
 * The mark is coloured and the text is not. Colouring the whole line makes a long
 * warning hard to read and makes a piped log full of escape codes; the mark is
 * where the eye lands anyway.
 */
export function resultLine(verdict: Verdict, text: string): string {
  return `${paint(MARK[verdict], verdict, PLAIN)} ${text}`;
}

/** As `resultLine`, with colour when the caller says the terminal has it. */
export function styledResultLine(verdict: Verdict, text: string, style: Style): string {
  return `${paint(MARK[verdict], verdict, style)} ${text}`;
}

/** A step in progress. Replaced in place by a `resultLine` when it finishes. */
export function stepLine(frame: number, text: string): string {
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
  return `${spinner} ${text}`;
}

/**
 * A value the reader has to copy.
 *
 * Blank line, then the value at column zero, then a blank line. Unindented is the
 * whole point: a double-click selects the value and nothing else. See the note at
 * the top of this file for why this is the difference between an onboarding that
 * completes and one that does not.
 */
export function copyable(value: string): string {
  return `\n${value}\n`;
}

/** An indented note under a result line. Never a value the reader has to copy. */
export function note(text: string): string {
  return `  ${text}`;
}

export interface NextAction {
  /** What this achieves, in a few words. Sentence case. */
  readonly goal: string;
  /** Ordered steps. A value to copy belongs in `copy`, not in here. */
  readonly steps: readonly string[];
  /** Printed unindented so it can be selected cleanly. */
  readonly copy?: string;
  /** A command that checks the result. */
  readonly verify?: string;
}

/**
 * How output ends: with the next concrete thing to do.
 *
 * Never just "Done". A CLI that finishes with a success mark and no instruction
 * leaves the reader to work out what a half-configured deployment needs, and the
 * half they are missing is usually the OAuth app, which fails silently.
 */
export function nextAction(action: NextAction): string {
  const lines: string[] = ['', `  Next: ${action.goal}`];

  for (const [index, step] of action.steps.entries()) {
    lines.push(`  ${index + 1}. ${step}`);
  }

  if (action.copy !== undefined) lines.push(copyable(action.copy));
  if (action.verify !== undefined) lines.push(`  Check: ${action.verify}`);

  return lines.join('\n');
}

/**
 * Words and characters that must not reach a reader, and can be looked for.
 *
 * The voice rules in `_design_system/DESIGN.md` section 9 and `brand.md` are prose,
 * and prose drifts. This turns the checkable half into something a test runs, the
 * same move `scripts/check-design-tokens.mjs` makes for colour. It cannot check
 * sentence case or whether a sentence is precise; it can check the rules that are
 * binary, and those are the ones that were being broken.
 */
const VOICE_RULES: readonly { readonly pattern: RegExp; readonly why: string }[] = Object.freeze([
  {
    pattern: /[—–]/u,
    why: 'em-dash or en-dash. Banned outright: it is the most reliable signature of machine-written text. Use a period, comma, colon or parentheses.',
  },
  {
    pattern: /!/u,
    why: 'exclamation mark. Banned anywhere, including success states.',
  },
  {
    pattern: /\p{Extended_Pictographic}/u,
    why: 'emoji. Banned in product output, docs headings and error messages.',
  },
  {
    pattern: /\b(elevate|seamless|unleash|next-gen|revolutionize|revolutionise|delve)\b/iu,
    why: 'filler verb from the banned list in DESIGN.md section 9.',
  },
  {
    pattern:
      /\b(?:your data is safe|100% secure|completely secure|cannot be hacked|fully secure)\b/iu,
    why: 'a safety claim. Rule 00 forbids these. Say what is enforced and name the caveat.',
  },
  {
    pattern: /\b(?:acme|john doe|jane doe|lorem ipsum|foo bar)\b/iu,
    why: 'a generic placeholder name. Made-up-but-plausible beats generic.',
  },
  {
    pattern: /\b99\.99%|\b100% of\b/u,
    why: 'a fake-perfect number. Use an organic value.',
  },
]);

/**
 * Every voice rule the text breaks, with the reason.
 *
 * ⚠️ The exclamation rule means this cannot be run over arbitrary text that happens
 * to contain a shell negation or a `!==`. It is meant for prose the reader sees, so
 * the tests apply it to rendered output rather than to source.
 */
export function findVoiceViolations(text: string): readonly string[] {
  return VOICE_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.why);
}

/** The mark for a verdict, for a caller assembling its own line. */
export function markFor(verdict: Verdict): string {
  return MARK[verdict];
}

/** The ANSI foreground code for a verdict, for a caller doing its own painting. */
export function ansiFor(verdict: Verdict): number {
  return ANSI_CODE[verdict];
}
