#!/usr/bin/env node
/**
 * BaseCLF design token guard.
 *
 * DESIGN.md claims WCAG 2.2 AA and claims that tokens.json is the single source
 * of truth. Both claims are checkable, so they are checked here rather than
 * trusted. A prose rule nobody runs is a rule that drifts.
 *
 * Two invariants:
 *
 *   1. STRUCTURE. Every semantic token resolves to a step in a raw ramp. A
 *      one-off hex in the semantic layer means that value cannot be reached by
 *      editing the ramp, so "edit tokens and regenerate" silently stops being
 *      true for it.
 *
 *   2. CONTRAST. Every foreground/background pair the interface actually renders
 *      meets its WCAG threshold, in both themes.
 *
 * Rules: _design_system/DESIGN.md sections 5 and 10.
 *
 *   node scripts/check-design-tokens.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokens = JSON.parse(readFileSync(join(ROOT, '_design_system/tokens.json'), 'utf8'));

const failures = [];
const fail = (msg) => failures.push(msg);

/* ------------------------------------------------------------- colour ----- */

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function relativeLuminance(hex) {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => toLinear(parseInt(n.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------ resolving --- */

const REFERENCE = /^\{color\.([a-z]+)\.(\w+)\}$/;
const HEX = /^#[0-9A-Fa-f]{6}$/;

/** Resolves a semantic token name to a hex value for one theme. */
function resolve(name, theme) {
  const raw = tokens.semantic[theme][name];
  if (raw === undefined) throw new Error(`unknown semantic token "${name}" in ${theme}`);
  const ref = REFERENCE.exec(raw);
  if (!ref) return raw;
  const [, ramp, step] = ref;
  const value = tokens.color[ramp]?.[step];
  if (!value) throw new Error(`"${name}" points at missing ramp step ${ramp}.${step}`);
  return value;
}

/* ------------------------------------------ invariant 1: every token refs -- */

for (const theme of ['light', 'dark']) {
  for (const [name, value] of Object.entries(tokens.semantic[theme])) {
    if (name.startsWith('$')) continue;
    if (REFERENCE.test(value)) continue;
    if (HEX.test(value)) {
      fail(
        `structure: semantic.${theme}.${name} is the literal ${value}. ` +
          `It must reference a ramp step, otherwise editing the ramp cannot reach it.`,
      );
    } else {
      fail(`structure: semantic.${theme}.${name} is neither a reference nor a hex value.`);
    }
  }
}

/* --------------------------------------------- invariant 2: contrast ------ */

/**
 * Pairs the interface actually renders. Thresholds follow WCAG 2.2:
 * 4.5 for text, 3 for the boundary that identifies a control.
 *
 * Row separators are deliberately absent. A divider is decoration between two
 * regions of the same surface, not information required to identify a control,
 * so 1.4.11 does not apply to it. Input borders are here because for an input
 * the border IS the control boundary.
 */
const PAIRS = [
  // Body and supporting text, on every surface it can land on.
  ['text-primary', 'canvas', 4.5],
  ['text-primary', 'surface', 4.5],
  ['text-primary', 'surface-sunken', 4.5],
  ['text-secondary', 'canvas', 4.5],
  ['text-secondary', 'surface', 4.5],
  ['text-secondary', 'surface-sunken', 4.5],
  ['text-tertiary', 'canvas', 4.5],
  ['text-tertiary', 'surface', 4.5],
  ['text-tertiary', 'surface-sunken', 4.5],

  // The verdict badge. This is the product's core semantic element, and it
  // renders text on its own tint, never on the page surface.
  ['allow-text', 'allow-tint', 4.5],
  ['deny-text', 'deny-tint', 4.5],
  ['attention-text', 'attention-tint', 4.5],

  // Signals used as text directly on the page, for example an inline warning.
  ['allow-text', 'surface', 4.5],
  ['deny-text', 'surface', 4.5],
  ['attention-text', 'surface', 4.5],

  // Primary button: inverse label on ink.
  ['text-inverse', 'text-primary', 4.5],

  // The focus ring must be visible against everything it can sit on.
  ['focus-ring', 'canvas', 3],
  ['focus-ring', 'surface', 3],
  ['focus-ring', 'surface-sunken', 3],
];

for (const theme of ['light', 'dark']) {
  for (const [fg, bg, need] of PAIRS) {
    const got = contrast(resolve(fg, theme), resolve(bg, theme));
    if (got < need) {
      fail(
        `contrast: ${theme} ${fg} on ${bg} is ${got.toFixed(2)}:1, needs ${need}:1 ` +
          `(${resolve(fg, theme)} on ${resolve(bg, theme)})`,
      );
    }
  }
}

/* ------------------------------------------------------------- reporting -- */

if (failures.length === 0) {
  console.log('design tokens: structure and contrast both clean.');
  process.exit(0);
}

console.error(`design tokens: ${failures.length} problem${failures.length === 1 ? '' : 's'}.\n`);
for (const f of failures) console.error(`  ${f}`);
console.error('\nRules: _design_system/DESIGN.md sections 5 and 10.');
process.exit(1);
