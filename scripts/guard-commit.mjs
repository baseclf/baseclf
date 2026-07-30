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
  /(^|\/)secrets\.json$/,
  /\.(pem|p12|key)$/,
  /(^|\/)id_(ed25519|rsa)/,
  /^FOUNDATION\.md$/,
  /^BUILD-PROGRESS\.md$/,
  /^HANDOFF-STATUS\.md$/,
  /^AGENTS\.md$/,
  /^Baas With CLF\.md$/,
  /^baas-cloudflare-mvp-plan\.md$/,
  /^\.claude\//,
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

/** Latin letters carrying Vietnamese diacritics. Rule 04 section A. */
const VIETNAMESE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
/** Files that ship to the public and must therefore be English only. */
const ENGLISH_ONLY = /^(src\/|docs\/|examples\/|README|LICENS|CONTRIBUTING|CHANGELOG|packages\/)/;

const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|css|html|yml|yaml|toml|txt|sh|sql)$/;

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
