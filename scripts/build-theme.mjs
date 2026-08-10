#!/usr/bin/env node
/**
 * Generates _design_system/theme.css from _design_system/tokens.json.
 *
 * theme.css claimed to be generated for two versions before anything generated
 * it, which is how eleven dark values drifted out of the ramp and how one token
 * ended up named `border` in the source and `--border-default` in the output.
 *
 * Run `node scripts/build-theme.mjs` after editing tokens.json.
 * `node scripts/check-design-tokens.mjs` fails if the two are out of sync, so
 * forgetting to run this is caught rather than discovered later.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = join(ROOT, '_design_system/tokens.json');
const OUT = join(ROOT, '_design_system/theme.css');

const t = JSON.parse(readFileSync(TOKENS, 'utf8'));

const REFERENCE = /^\{color\.([a-z]+)\.(\w+)\}$/;
const isMeta = (k) => k.startsWith('$');

/** Semantic values are references; emit them as var() so the ramp stays the source. */
function emitSemantic(theme, indent) {
  const pad = ' '.repeat(indent);
  const groups = [
    ['canvas', 'surface', 'surface-raised', 'surface-sunken', 'surface-hover', 'surface-active'],
    ['border-subtle', 'border-default', 'border-strong', 'border-control'],
    ['ink-primary', 'ink-secondary', 'ink-tertiary', 'ink-disabled', 'ink-inverse'],
    ['focus-ring'],
    [
      'allow-text',
      'allow-tint',
      'allow-border',
      'deny-text',
      'deny-tint',
      'deny-border',
      'attention-text',
      'attention-tint',
      'attention-border',
    ],
  ];
  const out = [];
  for (const group of groups) {
    for (const name of group) {
      const raw = t.semantic[theme][name];
      const m = REFERENCE.exec(raw);
      if (!m) throw new Error(`semantic.${theme}.${name} is not a reference: ${raw}`);
      out.push(`${pad}--${name}: var(--${m[1]}-${m[2]});`);
    }
    out.push('');
  }
  const e = t.elevation[theme];
  out.push(`${pad}--shadow-popover: ${e['shadow-popover']};`);
  out.push(`${pad}--shadow-dialog: ${e['shadow-dialog']};`);
  out.push(`${pad}--scrim: ${e.scrim};`);
  return out.join('\n');
}

function emitRamp() {
  const out = [];
  for (const [ramp, steps] of Object.entries(t.color)) {
    const label = ramp === 'neutral' ? 'neutral, cool and technical' : `signal: ${ramp}`;
    out.push(`  /* ${label} */`);
    for (const [step, hex] of Object.entries(steps)) {
      if (isMeta(step)) continue;
      out.push(`  --${ramp}-${step}: ${hex};`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

function emitScale() {
  const out = [];
  out.push(`  --font-sans: ${t.font.family.sans};`);
  out.push(`  --font-mono: ${t.font.family.mono};`);
  out.push('');
  for (const [k, v] of Object.entries(t.font.weight)) out.push(`  --weight-${k}: ${v};`);
  out.push('');
  for (const [k, v] of Object.entries(t.font.size)) {
    if (isMeta(k)) continue;
    let line = `  --text-${k}: ${v.size}; --leading-${k}: ${v.line};`;
    if (v.tracking) line += ` --tracking-${k}: ${v.tracking};`;
    out.push(line);
  }
  out.push('');
  out.push(`  --measure-prose: ${t.font.measure.prose};`);
  out.push('');
  for (const [k, v] of Object.entries(t.space)) {
    if (isMeta(k)) continue;
    out.push(`  --space-${k}: ${v};`);
  }
  out.push('');
  for (const [k, v] of Object.entries(t.radius)) {
    if (isMeta(k)) continue;
    out.push(`  --radius-${k}: ${v};`);
  }
  out.push('');
  for (const [k, v] of Object.entries(t.border.width)) out.push(`  --border-${k}: ${v};`);
  out.push('');
  out.push(`  --icon-stroke: ${t.icon['stroke-width']};`);
  for (const [k, v] of Object.entries(t.icon.sizes)) out.push(`  --icon-${k}: ${v};`);
  out.push('');
  for (const [k, v] of Object.entries(t.motion.duration)) {
    const note = k === 'reveal' ? '   /* LANDING ONLY */' : '';
    out.push(`  --duration-${k}: ${v};${note}`);
  }
  for (const [k, v] of Object.entries(t.motion.easing)) {
    if (k === 'linear') continue;
    const note = k === 'reveal' ? '   /* LANDING ONLY */' : '';
    out.push(`  --ease-${k}: ${v};${note}`);
  }
  out.push('');
  for (const [k, v] of Object.entries(t.breakpoint)) out.push(`  --bp-${k}: ${v};`);
  out.push('');
  for (const [k, v] of Object.entries(t.z)) out.push(`  --z-${k}: ${v};`);
  return out.join('\n');
}

function emitDensity() {
  const out = [];
  for (const [name, d] of Object.entries(t.density)) {
    if (isMeta(name)) continue;
    const selector =
      name === 'comfortable'
        ? ":root,\n:root[data-density='comfortable']"
        : `:root[data-density='${name}']`;
    const gap = name === 'compact' ? ['4', '3'] : ['8', '4'];
    out.push(`${selector} {
  --body-size: var(--text-${d['base-size']});
  --body-leading: var(--leading-${d['base-size']});
  --row-height: ${d['row-height']};
  --control-height: ${name === 'compact' ? '28px' : '36px'};
  --section-gap: var(--space-${gap[0]});
  --field-gap: var(--space-${gap[1]});
}`);
  }
  return out.join('\n\n');
}

/**
 * Hand-written CSS that consumes the tokens above. It lives here rather than in
 * theme.css so that theme.css has exactly one author and can be regenerated
 * without losing anything.
 */
const PATTERNS = `/* ==================================================================== base = */
*, *::before, *::after { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--canvas);
  color: var(--ink-primary);
  font-family: var(--font-sans);
  font-size: var(--body-size);
  line-height: var(--body-leading);
  font-weight: var(--weight-regular);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-variant-numeric: tabular-nums;
}

h1, h2, h3, h4 {
  margin: 0;
  font-weight: var(--weight-semibold);
  color: var(--ink-primary);
  text-wrap: balance;
}
h1 { font-size: var(--text-h1); line-height: var(--leading-h1); letter-spacing: var(--tracking-h1); }
h2 { font-size: var(--text-h2); line-height: var(--leading-h2); letter-spacing: var(--tracking-h2); }
h3 { font-size: var(--text-h3); line-height: var(--leading-h3); letter-spacing: var(--tracking-h3); }

p { margin: 0; text-wrap: pretty; }

code, kbd, samp, pre {
  font-family: var(--font-mono);
  font-size: 0.9375em;                  /* Plex Mono runs large, step it down */
  font-variant-ligatures: none;
}

/* Links are ink + underline. No coloured links: colour is reserved for signals. */
a {
  color: inherit;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
  text-decoration-color: var(--border-strong);
}
a:hover { text-decoration-color: currentColor; }

hr {
  border: 0;
  border-top: var(--border-hairline) solid var(--border-subtle);
  margin: var(--space-6) 0;
}

/* Focus ring uses the attention signal. Focus means "look here". Never remove. */
:focus-visible {
  outline: var(--border-emphasis) solid var(--focus-ring);
  outline-offset: 2px;
  border-radius: inherit;
}
:focus:not(:focus-visible) { outline: none; }

::selection { background: var(--surface-active); color: var(--ink-primary); }

/* =============================================================== patterns = */

/* Panel, the whole recipe. Border, not shadow. */
.panel {
  background: var(--surface);
  border: var(--border-hairline) solid var(--border-default);
  border-radius: var(--radius-sm);
}

/* Form controls carry border-control, the one border held to 3:1. For an input
   the border is the boundary that identifies the control, which WCAG 1.4.11
   covers. Row separators are not, so they stay hairline. */
.input, input:not([type='checkbox']):not([type='radio']), select, textarea {
  height: var(--control-height);
  padding: 0 var(--space-3);
  border: var(--border-hairline) solid var(--border-control);
  border-radius: var(--radius-xs);
  background: var(--surface);
  color: var(--ink-primary);
  font-family: inherit;
  font-size: var(--body-size);
}
.input::placeholder, input::placeholder, textarea::placeholder { color: var(--ink-tertiary); }
.input:disabled, input:disabled, select:disabled, textarea:disabled {
  color: var(--ink-disabled);
  cursor: not-allowed;
}

/* Error styling hangs off aria-invalid, so a field cannot look wrong to a
   sighted user while looking fine to a screen reader. There is no error class. */
[aria-invalid='true'] { border-color: var(--deny-border); }

/* Verdict badges. Colour is NEVER the only signal, always a word or icon too. */
.verdict {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  height: 18px;
  font-size: var(--text-micro);
  line-height: 1;
  font-weight: var(--weight-medium);
  border-radius: var(--radius-xs);
  border: var(--border-hairline) solid transparent;
}
.verdict--allow     { color: var(--allow-text);     background: var(--allow-tint);     border-color: var(--allow-border); }
.verdict--deny      { color: var(--deny-text);      background: var(--deny-tint);      border-color: var(--deny-border); }
.verdict--attention { color: var(--attention-text); background: var(--attention-tint); border-color: var(--attention-border); }

/* Data table. No zebra. Subtle row rules. Sticky header. */
.table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.table th {
  position: sticky; top: 0; z-index: var(--z-sticky);
  background: var(--surface);
  text-align: left;
  font-size: var(--text-micro);
  font-weight: var(--weight-medium);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ink-tertiary);
  height: var(--row-height);
  padding: 0 var(--space-3);
  border-bottom: var(--border-hairline) solid var(--border-default);
}
.table td {
  height: var(--row-height);
  padding: 0 var(--space-3);
  border-bottom: var(--border-hairline) solid var(--border-subtle);
  border-radius: var(--radius-none);
}
.table tbody tr:hover { background: var(--surface-hover); }   /* no transform, no shadow */
.table tbody tr[aria-selected='true'] {
  background: var(--surface-active);
  box-shadow: inset 2px 0 0 0 var(--ink-primary);
}
.table .cell--id,
.table .cell--num { font-family: var(--font-mono); }
.table .cell--num { text-align: right; }
.table .cell--null { color: var(--ink-tertiary); font-style: italic; }

/* Generated SQL, the product's signature surface.
   Placeholders carry the attention colour; bound values sit in a separate list. */
.sql {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.375rem;
  color: var(--ink-primary);
  background: var(--surface-sunken);
  border: var(--border-hairline) solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  overflow-x: auto;
  white-space: pre;
}
.sql .kw    { color: var(--ink-secondary); font-weight: var(--weight-medium); }
.sql .param { color: var(--attention-text); font-weight: var(--weight-medium); }

.prose { max-width: var(--measure-prose); }
.prose > * + * { margin-top: var(--space-4); }

/* =============================================== landing-only: scroll reveal =
   Allowed on the landing page. BANNED in Studio and in docs body content.
   Drive .is-visible with IntersectionObserver, never a scroll listener.
   For a stagger, set --reveal-index inline: style="--reveal-index: 2".
   Cap the stagger at 6 items. A longer cascade is a tell. */
[data-surface='landing'] .reveal {
  --reveal-index: 0;
  opacity: 0;
  transform: translateY(12px);
  transition: opacity var(--duration-reveal) var(--ease-reveal),
              transform var(--duration-reveal) var(--ease-reveal);
  transition-delay: calc(var(--reveal-index) * 80ms);
}
[data-surface='landing'] .reveal.is-visible { opacity: 1; transform: none; }

/* Tactile press, landing only. Studio buttons do not move. */
[data-surface='landing'] .btn:active { transform: scale(0.98); }

/* ========================================================= reduced motion = */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  [data-surface='landing'] .reveal { opacity: 1; transform: none; }
  [data-surface='landing'] .btn:active { transform: none; }
}
`;

const css = `/* ============================================================================
   BaseCLF, theme.css   (v${t.$version})

   GENERATED by scripts/build-theme.mjs from tokens.json. Do not edit by hand;
   edit the tokens and run the script. check-design-tokens.mjs fails if this
   file and tokens.json disagree.

   Usage:
     <html data-theme="light|dark" data-density="compact|comfortable">
   Omit data-theme to follow the OS. Studio sets data-density="compact".

   COLOUR RULE: there is no brand accent. The only saturated colours in the
   product are the three signals, allow, deny, attention. The focus ring uses
   attention, because focus means "look here".

   NAMING: --ink-* is colour, --text-* is size. They were one namespace before
   v0.3.0, which made color: var(--text-sm) meaningless rather than wrong.
   ========================================================================= */

/* Self-host in production. CDN shown for reference only.
   @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap'); */

:root {
  /* -------------------------------------------------------------- scale -- */
${emitScale()}

  /* ------------------------------------------------ raw ramps: the source -- */
${emitRamp()}
}

/* ============================================================ light mode == */
:root,
:root[data-theme='light'] {
  color-scheme: light;

${emitSemantic('light', 2)}
}

/* ============================================================= dark mode ==
   Declared twice on purpose: once for the OS preference, once for the explicit
   toggle, which must beat the media query in both directions. Both blocks are
   emitted from the same source below, so they cannot drift apart. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;

${emitSemantic('dark', 4)}
  }
}

:root[data-theme='dark'] {
  color-scheme: dark;

${emitSemantic('dark', 2)}
}

/* ================================================================ density = */
${emitDensity()}

${PATTERNS}`;

writeFileSync(OUT, css, 'utf8');
console.log(`theme.css written from tokens.json v${t.$version} (${css.split('\n').length} lines).`);
