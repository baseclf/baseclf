/**
 * A doctor report as the reader sees it.
 *
 * Separate from both the checks and the primitives so that what gets printed can be
 * tested as a string. The voice rules are checkable and the tests check them, which
 * only works if there is a function that returns the whole output rather than a
 * command that writes it to a stream.
 *
 * The order is the order the problems have to be fixed in, which is the order the
 * checks arrive in. Nothing is sorted by severity: a missing secret has to be fixed
 * before a redirect URI matters, and sorting by how alarming each line looks would
 * put them the other way round.
 */

import type { Check, DoctorReport } from './doctor.js';
import { copyable, type Style, styledResultLine } from './output.js';

function renderCheck(check: Check, style: Style): readonly string[] {
  const lines: string[] = [styledResultLine(check.verdict, `${check.name}: ${check.detail}`, style)];

  if (check.action !== undefined) lines.push(`  ${check.action}`);
  // At column zero, so a double-click selects it and nothing else. The one thing in
  // this output that has to survive a copy exactly.
  if (check.copy !== undefined) lines.push(copyable(check.copy));

  return lines;
}

/**
 * The closing line.
 *
 * Never just a count. A reader who has just been told three things are wrong needs
 * to know which command tells them whether they fixed it, and a report that ends
 * with a number makes them scroll back up to work out what to do first.
 */
function renderSummary(report: DoctorReport): readonly string[] {
  if (report.ok) {
    return [
      '',
      '  Nothing to fix. This deployment answers, has its tables and keys, and reports no',
      '  configuration problems.',
      '',
      '  BaseCLF enforces policies on requests that go through this Worker. It does not',
      '  enforce anything on `wrangler d1 execute`, which writes straight to the database.',
    ];
  }

  const blocking = report.checks.filter((check) => check.verdict === 'deny').length;
  const worth = report.checks.filter((check) => check.verdict === 'attention').length;

  const counted =
    blocking > 0
      ? `${blocking} ${blocking === 1 ? 'problem stops' : 'problems stop'} this deployment working`
      : `${worth} ${worth === 1 ? 'thing is' : 'things are'} not finished`;

  return [
    '',
    `  ${counted}. Fix them in the order above: the first one usually explains the rest.`,
    '',
    '  Check: baseclf doctor <url>',
  ];
}

export function renderReport(report: DoctorReport, style: Style): string {
  return [
    ...report.checks.flatMap((check) => renderCheck(check, style)),
    ...renderSummary(report),
  ].join('\n');
}
