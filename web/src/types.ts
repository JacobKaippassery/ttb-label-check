export type Verdict = 'pass' | 'review' | 'fail' | 'not_applicable' | 'not_compared';
export type BeverageClass = 'distilled_spirits' | 'wine' | 'malt_beverage';

export interface DiffSegment {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

export interface CheckResult {
  id: string;
  title: string;
  verdict: Verdict;
  summary: string;
  expected: string | null;
  found: string | null;
  citation: string;
  diff?: DiffSegment[];
  detail?: string;
  requiresAgentConfirmation?: boolean;
}

export interface LabelExtraction {
  brandName: string | null;
  classType: string | null;
  alcoholContentText: string | null;
  netContentsText: string | null;
  bottlerNameAddress: string | null;
  countryOfOrigin: string | null;
  governmentWarningText: string | null;
  imageLegible: boolean;
  imageQualityIssues: string[];
  transcriptionConfidence: number;
  notes: string | null;
}

export interface VerifyResult {
  applicationId: string;
  overall: Verdict;
  headline: string;
  checks: CheckResult[];
  extraction: LabelExtraction;
  model: string;
  needsBetterImage: boolean;
  isDemo: boolean;
  panels?: Array<{ fileName: string; thumbnailDataUrl: string }>;
  confirmationReads?: number;
  thumbnailDataUrl: string;
  imageTransformations: string[];
  usage: { inputTokens: number; outputTokens: number };
  timings: { extractionMs: number; rulesMs: number; totalMs: number };
}

export interface ApplicationForm {
  applicationId: string;
  beverageClass: BeverageClass;
  brandName: string;
  classType: string;
  alcoholContentAbv: string;
  netContentsMl: string;
  bottlerNameAddress: string;
  countryOfOrigin: string;
  isImport: boolean;
  /**
   * TTB grants an exception from stating alcohol content for some wine and
   * malt beverage products, depending on state law. The rules engine has
   * always understood this flag (`alcoholContentOptional` on
   * ApplicationRecord) — this field was the missing link that actually let a
   * user set it from the form, found in a pre-deployment requirements audit
   * against the brief's "with some exceptions for certain wine/beer" line.
   */
  alcoholContentOptional: boolean;
}

/** The example from the project brief, so the tool is usable on first load. */
export const SAMPLE_APPLICATION: ApplicationForm = {
  applicationId: 'TTB-2026-0148',
  beverageClass: 'distilled_spirits',
  brandName: 'OLD TOM DISTILLERY',
  classType: 'Kentucky Straight Bourbon Whiskey',
  alcoholContentAbv: '45',
  netContentsMl: '750',
  bottlerNameAddress: 'Old Tom Distillery, Bardstown, Kentucky',
  countryOfOrigin: '',
  isImport: false,
  alcoholContentOptional: false,
};

export function toApplicationPayload(form: ApplicationForm) {
  return {
    applicationId: form.applicationId,
    beverageClass: form.beverageClass,
    brandName: form.brandName,
    classType: form.classType,
    alcoholContentAbv: form.alcoholContentAbv === '' ? null : Number(form.alcoholContentAbv),
    netContentsMl: form.netContentsMl === '' ? null : Number(form.netContentsMl),
    bottlerNameAddress: form.bottlerNameAddress || null,
    countryOfOrigin: form.countryOfOrigin || null,
    isImport: form.isImport,
    alcoholContentOptional: form.alcoholContentOptional,
  };
}

export const VERDICT_WORDS: Record<Verdict, string> = {
  pass: 'Passed',
  review: 'Needs review',
  fail: 'Problem found',
  not_applicable: 'Not applicable',
  not_compared: 'Not compared',
};

/** Shapes, not just colours — so the verdict survives colour-blindness and print. */
export const VERDICT_MARKS: Record<Verdict, string> = {
  pass: '✓',
  review: '!',
  fail: '✕',
  not_applicable: '–',
  not_compared: '?',
};
