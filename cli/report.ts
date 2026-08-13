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
  const lines: string[] = [
    styledResultLine(check.verdict, `${check.name}: ${check.detail}`, style),
  ];

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

  // ⚠️ Counted on causes rather than on lines. A check marked `followsFrom` is
  // printed and still keeps the report from being ok, but it is a way to satisfy
  // another check rather than a job of its own, and counting it told a reader with
  // one thing to do that they had three.
  const causes = report.checks.filter((check) => check.followsFrom === undefined);
  const blocking = causes.filter((check) => check.verdict === 'deny').length;
  const worth = causes.filter((check) => check.verdict === 'attention').length;

  const counted =
    blocking > 0
      ? `${blocking} ${blocking === 1 ? 'problem stops' : 'problems stop'} this deployment working`
      : `${worth} ${worth === 1 ? 'thing is' : 'things are'} not finished`;

  // ⚠️ The count and the sentence after it have to agree, and they did not. The
  // count learned to say "1 thing is" while the guidance stayed written for the
  // plural, so a reader with one job was told to "fix them" and that "the first
  // one explains the rest" of a set with no rest in it.
  //
  // The sentence also has a second job worth keeping. The count is of causes,
  // while the report prints the checks that follow from them as well, so a reader
  // can see four marked lines and be told one. With a single cause, saying that
  // the others follow from it is the entire explanation of that gap. With nothing
  // following, there is nothing to explain and the line stops at the count.
  const count = blocking > 0 ? blocking : worth;
  const following = report.checks.filter(
    (check) => check.followsFrom !== undefined && check.verdict !== 'allow',
  ).length;

  const guidance =
    count > 1
      ? ' Fix them in the order above: the first one usually explains the rest.'
      : following > 0
        ? ' The other marked lines follow from it.'
        : '';

  return ['', `  ${counted}.${guidance}`, '', '  Check: baseclf doctor <url>'];
}

export function renderReport(report: DoctorReport, style: Style): string {
  return [
    ...report.checks.flatMap((check) => renderCheck(check, style)),
    ...renderSummary(report),
  ].join('\n');
}
