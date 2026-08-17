import type { DiffSegment } from './types.ts';
import { normalizeForMatch, tokenize } from './normalize.ts';

/** Levenshtein edit distance with an early-exit ceiling. */
export function editDistance(a: string, b: string, ceiling = Infinity): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > ceiling) return ceiling + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > ceiling) return ceiling + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** Normalized similarity in [0, 1]. 1 means identical. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
}

export type MatchStrength = 'exact' | 'equivalent' | 'close' | 'different';

export interface MatchOutcome {
  strength: MatchStrength;
  score: number;
  /** Human-readable reason, e.g. "differs only in capitalization". */
  reason: string;
}

/**
 * Compares a label string against an application string and grades how close
 * they are. The grades map onto agent workload:
 *
 *   exact       → identical as printed. No agent time.
 *   equivalent  → differs only in case/punctuation/abbreviation. No agent time,
 *                 but we say what differed so the record is honest.
 *   close       → probably the same, possibly a typo. Agent should eyeball it.
 *   different   → not the same thing. Agent must act.
 *
 * The "equivalent" tier is the one that keeps this tool usable. Without it
 * every capitalization difference becomes a false positive and agents stop
 * trusting the output.
 */
export function compareNames(labelText: string, applicationText: string): MatchOutcome {
  const rawLabel = labelText.trim();
  const rawApp = applicationText.trim();

  if (rawLabel === rawApp) {
    return { strength: 'exact', score: 1, reason: 'Identical to the application.' };
  }

  const normLabel = normalizeForMatch(rawLabel);
  const normApp = normalizeForMatch(rawApp);

  if (normLabel === normApp) {
    return {
      strength: 'equivalent',
      score: 1,
      reason: describeCosmetic(rawLabel, rawApp),
    };
  }

  // Order-insensitive token comparison catches "Smith & Sons Distillery" vs
  // "Distillery of Smith and Sons" and reordered address lines.
  const labelTokens = new Set(tokenize(rawLabel));
  const appTokens = new Set(tokenize(rawApp));
  if (labelTokens.size > 0 && appTokens.size > 0) {
    const shared = [...labelTokens].filter((t) => appTokens.has(t)).length;
    const union = new Set([...labelTokens, ...appTokens]).size;
    const jaccard = shared / union;
    if (jaccard === 1) {
      return {
        strength: 'equivalent',
        score: 1,
        reason: 'Same words in a different order.',
      };
    }
    if (jaccard >= 0.8) {
      return {
        strength: 'close',
        score: jaccard,
        reason: 'Mostly the same wording, with some words added or missing.',
      };
    }
  }

  const score = similarity(normLabel, normApp);
  if (score >= 0.92) {
    return {
      strength: 'close',
      score,
      reason: 'Very similar to the application — possibly a typo on one side.',
    };
  }
  if (score >= 0.75) {
    return {
      strength: 'close',
      score,
      reason: 'Similar to the application, but the difference is more than a typo.',
    };
  }
  return {
    strength: 'different',
    score,
    reason: 'Does not match the application.',
  };
}

/** Names the specific cosmetic difference so the agent is not left guessing. */
function describeCosmetic(a: string, b: string): string {
  const reasons: string[] = [];
  if (a.toLowerCase() === b.toLowerCase()) {
    return 'Same text, different capitalization — treated as a match.';
  }
  if (a.replace(/\s+/g, '') === b.replace(/\s+/g, '')) {
    reasons.push('spacing');
  }
  if (a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '')) {
    reasons.push('capitalization and punctuation');
  }
  return reasons.length > 0
    ? `Differs only in ${reasons.join(' and ')} — treated as a match.`
    : 'Differs only in formatting or abbreviation — treated as a match.';
}

/**
 * Word-level diff used to show an agent exactly how a submitted government
 * warning departs from the required text. Word-level rather than character
 * level because "impairs" vs "impair" should read as one changed word, not as
 * a scatter of single-character edits.
 */
export function diffWords(expected: string, actual: string): DiffSegment[] {
  const expectedWords = expected.split(/(\s+)/).filter((w) => w !== '');
  const actualWords = actual.split(/(\s+)/).filter((w) => w !== '');

  // Standard LCS table. Warning statements are ~50 words, so O(n*m) is fine.
  const n = expectedWords.length;
  const m = actualWords.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        expectedWords[i] === actualWords[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const segments: DiffSegment[] = [];
  const push = (kind: DiffSegment['kind'], text: string) => {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.text += text;
    else segments.push({ kind, text });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (expectedWords[i] === actualWords[j]) {
      push('same', expectedWords[i]!);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push('removed', expectedWords[i]!);
      i++;
    } else {
      push('added', actualWords[j]!);
      j++;
    }
  }
  while (i < n) push('removed', expectedWords[i++]!);
  while (j < m) push('added', actualWords[j++]!);

  return segments;
}
