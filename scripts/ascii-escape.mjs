/**
 * Rewrite non-ASCII characters in a file as JavaScript unicode escapes.
 *
 * Everything that ships has to be ASCII on disk (rules/04 section A, enforced
 * by scripts/guard-commit.mjs). A test that measures how SQLite folds case
 * necessarily talks about letters outside ASCII, so it names them by codepoint
 * instead of carrying them literally.
 *
 * Run: node scripts/ascii-escape.mjs <file> [...]
 */

import { readFileSync, writeFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/ascii-escape.mjs <file> [...]');
  process.exit(1);
}

const ASCII_CEILING = 0x7f;

/** Written as a loop rather than a regular expression: a character class over
 * the ASCII range has to name control characters, which the linter refuses and
 * is right to. */
function escapeNonAscii(text) {
  let out = '';
  let escaped = 0;

  for (const character of text) {
    const code = character.codePointAt(0);
    if (code <= ASCII_CEILING) {
      out += character;
      continue;
    }
    escaped += 1;
    out +=
      code > 0xffff
        ? `\\u{${code.toString(16).toUpperCase()}}`
        : `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }

  return { out, escaped };
}

for (const file of files) {
  const before = readFileSync(file, 'utf8');
  const { out, escaped } = escapeNonAscii(before);

  if (escaped === 0) {
    console.log(`${file}: already ASCII`);
    continue;
  }

  writeFileSync(file, out, 'utf8');
  console.log(`${file}: escaped ${escaped} character(s)`);
}
