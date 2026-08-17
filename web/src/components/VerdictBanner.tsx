import type { Verdict } from '../types.ts';
import { VERDICT_MARKS } from '../types.ts';

/**
 * `review` deliberately leads with the reassurance rather than the request.
 *
 * A verdict of "review" means no check failed — the label has no violations,
 * and some things need a human look. Titling that "Needs your judgement" made
 * readers scan the findings below as though they were problems, and conclude
 * the tool was rejecting a compliant label.
 */
const TITLES: Record<Verdict, string> = {
  pass: 'No problems found',
  review: 'No violations — a few things to confirm',
  fail: 'Do not approve yet',
  not_applicable: 'Not applicable',
  not_compared: 'Nothing to compare against',
};

/**
 * The one thing an agent must be able to read from across the room.
 *
 * The verdict is carried by three independent signals — a word, a symbol, and a
 * colour — so it survives a colour-blind reader, a greyscale printout, and a
 * washed-out monitor. Never let colour be the only carrier.
 */
export function VerdictBanner({ verdict, headline }: { verdict: Verdict; headline: string }) {
  const kind = verdict === 'not_applicable' ? 'review' : verdict;
  return (
    <div className={`verdict ${kind}`} role="status" aria-live="polite">
      <span className="mark" aria-hidden="true">
        {VERDICT_MARKS[verdict]}
      </span>
      <div>
        <h2>{TITLES[verdict]}</h2>
        <p>{headline}</p>
      </div>
    </div>
  );
}
