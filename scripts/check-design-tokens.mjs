#!/usr/bin/env node
/**
 * BaseCLF design token guard.
 *
 * DESIGN.md claims WCAG 2.2 AA, claims tokens.json is the single source of
 * truth, and claims theme.css is generated from it. All three are checkable, so
 * they are checked here rather than trusted. A prose rule nobody runs is a rule
 * that drifts, and all three had drifted before this file existed.
 *
 * Four invariants:
 *
 *   1. STRUCTURE  Every semantic token resolves to a step in a raw ramp. A
 *                 one-off hex cannot be reached by editing the ramp, so "edit
 *                 tokens and regenerate" quietly stops being true for it.
 *   2. CURVE      Every neutral hex is exactly the OKLCH value tokens.json
 *                 documents for it, so the design record cannot become fiction.
 *   3. CONTRAST   Every foreground/background pair the interface renders meets
 *                 its WCAG threshold, in both themes.
 *   4. FRESHNESS  theme.css is byte-identical to what build-theme.mjs produces.
 *
 * Rules: _design_system/DESIGN.md sections 5 and 10.
 *
 *   node scripts/check-design-tokens.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokens = JSON.parse(readFileSync(join(ROOT, '_design_system/tokens.json'), 'utf8'));

const failures = [];
const fail = (msg) => failures.push(msg);

/* ------------------------------------------------------------- colour ----- */

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

function relativeLuminance(hex) {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => toLinear(parseInt(n.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** OKLCH to sRGB hex. Used to prove the documented curve produces the shipped hex. */
function oklchToHex(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
  return `#${rgb
    .map((c) =>
      Math.round(clamp01(c) * 255)
        .toString(16)
        .padStart(2, '0')
        .toUpperCase(),
    )
    .join('')}`;
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
  const value = tokens.color[ref[1]]?.[ref[2]];
  if (!value) throw new Error(`"${name}" points at missing ramp step ${ref[1]}.${ref[2]}`);
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
          'It must reference a ramp step, otherwise editing the ramp cannot reach it.',
      );
    } else {
      fail(`structure: semantic.${theme}.${name} is neither a reference nor a hex value.`);
    }
  }
}

/* ---------------------------------------- invariant 2: the curve is honest -- */

const HUE = tokens.color.neutral.$hue;
const curve = tokens.color.neutral.$curve;

for (const [step, hex] of Object.entries(tokens.color.neutral)) {
  if (step.startsWith('$')) continue;
  const point = curve[step];
  if (!point) {
    fail(`curve: neutral.${step} = ${hex} has no entry in $curve, so its design is unrecorded.`);
    continue;
  }
  const expected = oklchToHex(point[0], point[1], HUE);
  if (expected !== hex.toUpperCase()) {
    fail(
      `curve: neutral.${step} is ${hex} but oklch(${point[0]} ${point[1]} ${HUE}) is ${expected}. ` +
        'The documented curve and the shipped value disagree.',
    );
  }
}
for (const step of Object.keys(curve)) {
  if (step.startsWith('$')) continue;
  if (!(step in tokens.color.neutral)) {
    fail(`curve: $curve documents step ${step}, but the ramp has no such step.`);
  }
}

/* --------------------------------------------- invariant 3: contrast ------ */

/** Every surface a reader can meet. Ink must clear AA on all of them. */
const SURFACES = [
  'canvas',
  'surface',
  'surface-raised',
  'surface-sunken',
  'surface-hover',
  'surface-active',
];

/**
 * Thresholds follow WCAG 2.2: 4.5 for text, 3 for the boundary that identifies
 * a control. Row separators are deliberately absent. A divider sits between two
 * regions of the same surface and is not information required to identify a
 * control, so 1.4.11 does not apply to it. border-control is here because for
 * an input the border IS the control boundary.
 */
const PAIRS = [];
for (const ink of ['ink-primary', 'ink-secondary', 'ink-tertiary']) {
  for (const surface of SURFACES) PAIRS.push([ink, surface, 4.5]);
}
for (const surface of ['surface', 'surface-sunken']) {
  PAIRS.push(['border-control', surface, 3]);
}
for (const signal of ['allow', 'deny', 'attention']) {
  PAIRS.push([`${signal}-text`, `${signal}-tint`, 4.5]);
  PAIRS.push([`${signal}-text`, 'surface', 4.5]);
}
for (const surface of SURFACES) PAIRS.push(['focus-ring', surface, 3]);
PAIRS.push(['ink-inverse', 'ink-primary', 4.5]);

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

/* ------------------------------------------- invariant 4: theme.css fresh -- */

const themePath = join(ROOT, '_design_system/theme.css');
const onDisk = readFileSync(themePath, 'utf8');
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts/build-theme.mjs')], { stdio: 'pipe' });
  const rebuilt = readFileSync(themePath, 'utf8');
  if (rebuilt !== onDisk) {
    fail(
      'freshness: theme.css did not match tokens.json. It has been regenerated, ' +
        'so review the diff and stage it. Never hand-edit theme.css.',
    );
  }
} catch (err) {
  fail(`freshness: could not run build-theme.mjs. ${err.message}`);
}

/* ------------------------------------------------------------- reporting -- */

if (failures.length === 0) {
  console.log(
    `design tokens: clean. ${Object.keys(tokens.color.neutral.$curve).length - 1} ramp steps, ` +
      `${PAIRS.length * 2} contrast pairs, theme.css in sync.`,
  );
  process.exit(0);
}

console.error(`design tokens: ${failures.length} problem${failures.length === 1 ? '' : 's'}.\n`);
for (const f of failures) console.error(`  ${f}`);
console.error('\nRules: _design_system/DESIGN.md sections 5 and 10.');
process.exit(1);
