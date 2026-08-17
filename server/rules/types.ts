import type { BeverageClass } from './reference.ts';

export type { BeverageClass };

/**
 * What the applicant submitted in the COLA application. This is the source of
 * truth we compare the label against — it is never inferred from the image.
 */
export interface ApplicationRecord {
  applicationId: string;
  beverageClass: BeverageClass;
  brandName: string;
  classType: string;
  /** Alcohol by volume as a number, e.g. 45 for "45% Alc./Vol.". */
  alcoholContentAbv?: number | null;
  /** Net contents in millilitres, e.g. 750. */
  netContentsMl?: number | null;
  bottlerNameAddress?: string | null;
  /** Set when the product is imported; triggers the country-of-origin check. */
  countryOfOrigin?: string | null;
  isImport?: boolean;
  /** Escape hatch for products lawfully omitting alcohol content. */
  alcoholContentOptional?: boolean;
}

/**
 * What the model transcribed off the label. Every field is "what is printed",
 * never "what it means" — interpretation is the rules engine's job.
 */
export interface LabelExtraction {
  brandName: string | null;
  classType: string | null;
  alcoholContentText: string | null;
  alcoholContentAbv: number | null;
  proof: number | null;
  netContentsText: string | null;
  netContentsMl: number | null;
  bottlerNameAddress: string | null;
  countryOfOrigin: string | null;

  /** The warning transcribed EXACTLY as printed, or null if absent. */
  governmentWarningText: string | null;
  /** Typography observations, used for the caps/bold requirements. */
  warningPrefixIsAllCaps: boolean | null;
  warningPrefixAppearsBold: boolean | null;
  warningAppearsSeparate: boolean | null;
  /** Warning character height relative to the largest text on the label (0–1). */
  warningRelativeSize: number | null;

  imageLegible: boolean;
  imageQualityIssues: string[];
  /** Model's own confidence that it read the label correctly, 0–1. */
  transcriptionConfidence: number;
  notes: string | null;
}

/**
 * `not_compared` is distinct from `review` on purpose.
 *
 * "Needs your judgement" asks an agent to weigh something. "There was no
 * application record to compare against" asks nothing of them — it reports a
 * missing input. Collapsing the two produced results where four of five review
 * items were really one fact stated four times, which buries the item that
 * genuinely needed a human eye.
 *
 * `not_compared` is excluded from the overall verdict and summarised once.
 */
export type Verdict = 'pass' | 'review' | 'fail' | 'not_applicable' | 'not_compared';

export interface CheckResult {
  /** Stable machine key, e.g. "government_warning". */
  id: string;
  /** Plain-language label shown to the agent. */
  title: string;
  verdict: Verdict;
  /** One sentence, written for a human, explaining the verdict. */
  summary: string;
  /** What the application said. */
  expected: string | null;
  /** What the label said. */
  found: string | null;
  /** CFR citation backing this check. */
  citation: string;
  /** Optional character-level diff for exact-match checks. */
  diff?: DiffSegment[];
  /** Extra context an agent may want, e.g. tolerance applied. */
  detail?: string;
  /**
   * True when this check can never be decided from an image alone and always
   * needs a human eye (currently only warning type size, which is specified in
   * millimetres of physical print).
   *
   * These are excluded from the overall verdict rollup. If they were included,
   * every label would come back "needs review" and the tool would be no faster
   * than the manual process it replaces — which is precisely how the previous
   * scanning-vendor pilot failed.
   */
  requiresAgentConfirmation?: boolean;
}

export interface DiffSegment {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

export interface VerificationResult {
  applicationId: string;
  overall: Verdict;
  /** Short sentence summarising the whole determination. */
  headline: string;
  checks: CheckResult[];
  extraction: LabelExtraction;
  timings: { extractionMs: number; rulesMs: number; totalMs: number };
  model: string;
  /** True when the image was too poor to support any determination. */
  needsBetterImage: boolean;
}
