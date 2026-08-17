#!/usr/bin/env node
/**
 * BaseCLF commit guard.
 *
 * .gitignore does not stop `git add -f`, and it does not stop a secret pasted
 * into a source file. This does. It is wired as a pre-commit hook and fails
 * the commit rather than warning.
 *
 * Rules: .claude/rules/05-open-source-boundary.md
 *
 *   node scripts/guard-commit.mjs          check staged files
 *   node scripts/guard-commit.mjs --all    check every tracked file
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const ALL = process.argv.includes('--all');

/* --------------------------------------------------------------- paths --- */
/** Files that must never reach the public repository. Rule 05 sections B, D. */
const PRIVATE_PATHS = [
  /^\.dev\.vars(?!\.example)/,
  /^\.env(?!\.example)/,
  // Wrangler config holding real resource ids. The committed wrangler.jsonc
  // keeps placeholders; a real deployment gets its own file and --config.
  /^wrangler\.local\./,
  /(^|\/)secrets\.json$/,
  /\.(pem|p12|key)$/,
  /(^|\/)id_(ed25519|rsa)/,
  /^FOUNDATION\.md$/,
  /^BUILD-PROGRESS\.md$/,
  /^HANDOFF-STATUS\.md$/,
  /^AGENTS\.md$/,
  /^Baas With CLF\.md$/,
  /^baas-cloudflare-mvp-plan\.md$/,
  // Three names for one thing. Agent tooling mirrors the same material under its own
  // directory: `.agents/skills/` was byte for byte identical to `.claude/skills/`.
  // ⚠️ A fourth tool means a fourth name here, and nothing catches that but reading
  // `git status` before staging: `--all` sees tracked files, so untracked copies are
  // exactly what it cannot see.
  /^\.claude\//,
  /^\.agents\//,
  /^\.codex\//,
  /^probe\//,
  /^_design_system\/(?!README\.md|tokens\.json|theme\.css)/,
  /^\.codegraph\//,
  /^codegraph\.json$/,
  /\.tgz$/,
  /^mcpv2\//,
];

/* ------------------------------------------------------------- secrets --- */
const SECRET_PATTERNS = [
  { name: 'Cloudflare API token', re: /\bcf(k|ut|at)_[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', re: /\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'OpenAI/Anthropic key', re: /\bsk-[A-Za-z0-9-]{20,}/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'Google OAuth secret', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: 'JWT with payload', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  {
    name: 'Real resource id assigned to a binding',
    // Fires only when a UUID or 32-hex is assigned to one of these keys, so
    // ordinary hashes and git SHAs do not trip it.
    re: /["']?(database_id|account_id|namespace_id|accountId|databaseId)["']?\s*[:=]\s*["'](?!(0{8}-|<|\$\{|your-|example|placeholder|test-))[0-9a-fA-F]{8}-?[0-9a-fA-F-]{20,}["']/,
  },
];

/**
 * 🔴 Any Cloudflare-shaped id at all, wherever it appears.
 *
 * The rule above only fires when the value is assigned to one of five key names, and
 * on 2026-08-12 a real account id went into a test fixture as `const ACCOUNT_ID =`
 * and sailed straight through: the alternatives are matched case-sensitively and that
 * is not one of them. It was caught by reading the file, which is not a mechanism.
 *
 * So this looks at the value instead of at what it is called. Measured before writing
 * it: the whole repository contained exactly three bare 32-hex strings, two of them
 * fixtures written that same hour and one a content hash wrangler generates. There is
 * no ordinary use of this shape here to protect.
 *
 * ## Why the carve-out is eight zeros
 *
 * A fixture has to look like the real thing or the test proves nothing, so there has
 * to be some way to write one. Rather than a comment a reader can add to anything,
 * the escape is structural: a fake id starts with eight zeros. It is unmistakable to
 * a reader, it needs no list to maintain, and the chance of a real Cloudflare id
 * beginning that way is about one in four billion. It also matches the placeholder
 * already used in `wrangler.jsonc`.
 */
const FAKE_ID_PREFIX = /^0{8}/;
const CLOUDFLARE_ID =
  /\b[0-9a-f]{32}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

/** Latin letters carrying Vietnamese diacritics. Rule 04 section A. */
const VIETNAMESE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
/** Files that ship to the public and must therefore be English only. */
const ENGLISH_ONLY = /^(src\/|docs\/|examples\/|README|LICENS|CONTRIBUTING|CHANGELOG|packages\/)/;

/**
 * Em-dash and en-dash. The design system calls this ban binary and it applies to
 * every string a user can read, so it belongs here rather than in anyone's memory.
 * Restructure with a period, a comma, a colon, or parentheses.
 */
const LONG_DASH = /[—–]/;
/** Machine-written files nobody edits by hand, so their punctuation is not ours. */
const GENERATED = /^(worker-configuration\.d\.ts|.*\.min\.(js|css)|dist\/|.*\.lock)/;

const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|css|html|yml|yaml|toml|txt|sh|sql)$/;

/**
 * A NUL byte in a source file, which makes the file invisible to the tools used to
 * read this repository.
 *
 * 🔴 Found in `src/auth/index.ts` on 2026-08-18, where a fingerprint separator was
 * written as a raw NUL rather than as an escape. Two things followed from one byte,
 * and the second is worse than the first:
 *
 *   1. `grep` and ripgrep classify the whole file as binary and answer "binary file
 *      matches" instead of the lines. An audit that greps for a symbol there is told
 *      nothing is found, which reads as absence. That happened: a search for
 *      `definePayload` in a file containing it twice came back empty.
 *   2. Editors and file readers render it as a **space**, so the line read as
 *      `join(' ')`. A space separator would be wrong, because a secret or a URL can
 *      contain one and two different inputs would then share a fingerprint. Nobody
 *      reading the source could tell which of the two it was.
 *
 * ⚠️ Deliberately narrow. Escape is left alone: `cli/output.ts` writes ANSI colour
 * codes and an escape does not make a file invisible to anything. This is the only
 * control character that does, and after the fix above the repository contains none,
 * measured across all 214 tracked text files rather than assumed.
 *
 * ⚠️ A plain string rather than a regular expression, and not for style. The linter
 * refuses a control character inside a regex, which is the right rule to have and the
 * wrong one to silence here, because matching one is the entire job. `includes` needs
 * no exception and says the same thing.
 */
const NUL_BYTE = '\u0000';

/* ---------------------------------------------------------------- run --- */
function stagedFiles() {
  const cmd = ALL ? 'git ls-files' : 'git diff --cached --name-only --diff-filter=ACMR';
  try {
    return execSync(cmd, { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const files = stagedFiles();
if (files.length === 0) {
  console.log('guard: nothing to check.');
  process.exit(0);
}

const failures = [];

for (const file of files) {
  const blocked = PRIVATE_PATHS.find((re) => re.test(file));
  if (blocked) {
    failures.push({
      file,
      kind: 'PRIVATE PATH',
      detail: 'This file must never enter the public repository. See rule 05 sections B and D.',
    });
    continue;
  }

  if (!TEXT_EXT.test(file) || !existsSync(file)) continue;
  if (statSync(file).size > 2_000_000) continue;

  let body;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = body.split('\n');

  const nul = lines.findIndex((l) => l.includes(NUL_BYTE));
  if (nul !== -1) {
    failures.push({
      file,
      kind: 'NUL BYTE',
      detail:
        `line ${nul + 1}. Every tool reading this repository goes blind on the file: ` +
        'grep answers "binary file matches" instead of the lines, and an editor draws ' +
        'it as a space. Write it as an escape instead.',
    });
  }

  for (const { name, re } of SECRET_PATTERNS) {
    const idx = lines.findIndex((l) => re.test(l));
    if (idx !== -1) {
      failures.push({
        file,
        kind: `SECRET: ${name}`,
        detail: `line ${idx + 1}. Rotate it immediately if it is real, then remove it.`,
      });
    }
  }

  // Generated files are excluded because nobody types what is in them, and the one
  // here carries a content hash of exactly this shape. Excluding them is safe for the
  // opposite reason to usual: a tool writes them from the repository, not from an
  // account.
  if (!GENERATED.test(file)) {
    for (const [index, line] of lines.entries()) {
      const found = (line.match(CLOUDFLARE_ID) ?? []).filter((id) => !FAKE_ID_PREFIX.test(id));
      if (found.length === 0) continue;

      failures.push({
        file,
        kind: 'SECRET: Cloudflare resource id',
        detail:
          `line ${index + 1}. Account, database and namespace ids never enter this ` +
          'repository. If it is a fixture, start it with eight zeros so it cannot be ' +
          'mistaken for a real one.',
      });
      break;
    }
  }

  if (ENGLISH_ONLY.test(file)) {
    const idx = lines.findIndex((l) => VIETNAMESE.test(l));
    if (idx !== -1) {
      failures.push({
        file,
        kind: 'NON-ENGLISH TEXT',
        detail: `line ${idx + 1}. Public surfaces are English only. See rule 04 section A.`,
      });
    }
  }

  if (ENGLISH_ONLY.test(file) && !GENERATED.test(file)) {
    const idx = lines.findIndex((l) => LONG_DASH.test(l));
    if (idx !== -1) {
      failures.push({
        file,
        kind: 'LONG DASH',
        detail:
          `line ${idx + 1}. Em-dash and en-dash are banned in anything a user reads. ` +
          'Use a period, a comma, a colon, or parentheses. See _design_system/DESIGN.md section 9.',
      });
    }
  }
}

if (failures.length === 0) {
  console.log(`guard: ${files.length} file(s) checked, clean.`);
  process.exit(0);
}

console.error('\n  COMMIT BLOCKED by scripts/guard-commit.mjs\n');
for (const f of failures) {
  console.error(`  [${f.kind}]`);
  console.error(`    ${f.file}`);
  console.error(`    ${f.detail}\n`);
}
console.error(
  '  Do NOT bypass with --no-verify. A guard failure means something is genuinely wrong.',
);
console.error('  Rules: .claude/rules/05-open-source-boundary.md\n');
process.exit(1);
