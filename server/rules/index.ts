import {
  checkAlcoholContent,
  checkBottler,
  checkBrandName,
  checkClassType,
  checkCountryOfOrigin,
  checkGovernmentWarning,
  checkImageQuality,
  checkNetContents,
  checkWarningLegibility,
} from './checks.ts';
import type {
  ApplicationRecord,
  CheckResult,
  LabelExtraction,
  Verdict,
} from './types.ts';

export * from './types.ts';
export { GOVERNMENT_WARNING_TEXT } from './reference.ts';

/**
 * Runs every compliance check against an extracted label and its application.
 *
 * Pure and synchronous: no I/O, no model calls, no clock, no randomness. That
 * is the whole point of the architecture — the model reads the picture, this
 * function makes the decisions, and this function can be exhaustively unit
 * tested without an API key or a network.
 */
export function runChecks(
  app: ApplicationRecord,
  label: LabelExtraction,
): { checks: CheckResult[]; overall: Verdict; headline: string; needsBetterImage: boolean } {
  const imageQuality = checkImageQuality(label);

  // If the image is unreadable, everything downstream is guesswork. Say so and
  // stop, rather than emitting confident findings derived from a bad photo.
  if (imageQuality.verdict === 'fail') {
    return {
      checks: [imageQuality],
      overall: 'fail',
      headline: 'Cannot verify — the image is not clear enough. Request a better photograph.',
      needsBetterImage: true,
    };
  }

  const checks: CheckResult[] = [
    imageQuality,
    checkBrandName(app, label),
    checkClassType(app, label),
    checkAlcoholContent(app, label),
    checkNetContents(app, label),
    checkBottler(app, label),
    checkCountryOfOrigin(app, label),
    checkGovernmentWarning(app, label),
    checkWarningLegibility(label),
  ];

  return { checks, needsBetterImage: false, ...rollup(checks) };
}

/**
 * Derives the overall verdict and headline from a set of checks.
 *
 * Exported separately so that a caller which adjusts a single check after the
 * fact — for example, downgrading a disputed warning to "review" after a second
 * reading — can recompute the summary without re-running every check.
 */
export function rollup(checks: CheckResult[]): { overall: Verdict; headline: string } {
  const blocking = checks.filter((c) => !c.requiresAgentConfirmation);
  const failures = blocking.filter((c) => c.verdict === 'fail');
  const reviews = blocking.filter((c) => c.verdict === 'review');
  const confirmations = checks.filter((c) => c.requiresAgentConfirmation);
  // Reported once at the end rather than as one review item per field.
  const notCompared = checks.filter((c) => c.verdict === 'not_compared');

  let overall: Verdict;
  let headline: string;

  if (failures.length > 0) {
    overall = 'fail';
    headline =
      failures.length === 1
        ? `Do not approve — 1 problem found: ${failures[0]!.title.toLowerCase()}.`
        : `Do not approve — ${failures.length} problems found: ${listTitles(failures)}.`;
  } else if (reviews.length > 0) {
    // "review" means nothing failed. Say that first and plainly — a reader who
    // sees "needs your judgement" without it assumes something is wrong, and
    // then reads a list of advisories as a list of violations.
    overall = 'review';
    headline =
      reviews.length === 1
        ? `No violations found. 1 item needs your eye: ${reviews[0]!.title.toLowerCase()}.`
        : `No violations found. ${reviews.length} items need your eye: ${listTitles(reviews)}.`;
  } else if (notCompared.length > 0 && notCompared.length === blocking.length - passCount(blocking)) {
    // Nothing failed, nothing needs judgement, and the only thing standing
    // between here and a determination is the missing application record.
    overall = 'review';
    headline = 'No problems found on the label itself.';
  } else {
    overall = 'pass';
    headline = 'Everything checked out against the application.';
  }

  if (notCompared.length > 0) {
    headline +=
      notCompared.length === 1
        ? ` 1 item could not be compared — no application record for ${notCompared[0]!.title.toLowerCase()}.`
        : ` ${notCompared.length} items could not be compared — there is no application record to check them against.`;
  }

  if (confirmations.length > 0) {
    const suffix =
      confirmations.length === 1
        ? ' One item still needs confirming by eye.'
        : ` ${confirmations.length} items still need confirming by eye.`;
    headline += suffix;
  }

  return { overall, headline };
}

function passCount(checks: CheckResult[]): number {
  return checks.filter((c) => c.verdict === 'pass' || c.verdict === 'not_applicable').length;
}

function listTitles(checks: CheckResult[]): string {
  const titles = checks.map((c) => c.title.toLowerCase());
  if (titles.length <= 2) return titles.join(' and ');
  return `${titles.slice(0, -1).join(', ')}, and ${titles[titles.length - 1]}`;
}
