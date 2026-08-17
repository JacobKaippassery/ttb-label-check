/**
 * Regulatory reference data — the ONLY place in this codebase where a number or
 * string traceable to the CFR is allowed to live.
 *
 * Every constant carries its citation. When a regulation changes, this file is
 * the entire blast radius: no check hard-codes a threshold, a container size, or
 * a required phrase.
 *
 * VERIFICATION STATUS (read before relying on this in production):
 *   - GOVERNMENT_WARNING_TEXT ....... verified verbatim against 27 CFR 16.21
 *   - DISTILLED_SPIRITS_FILLS ....... verified against 27 CFR 5.203 (post-2025 rule)
 *   - WINE_FILLS .................... verified against 27 CFR 4.72 (post-2025 rule)
 *   - ABV_TOLERANCES ................ NEEDS SME SIGN-OFF (see note on each entry)
 *
 * The ABV tolerances below are the values a compliance SME must confirm before
 * this prototype is used for real determinations. They are deliberately surfaced
 * as data, not buried in logic, so that confirmation is a one-line diff.
 */

export type BeverageClass = 'distilled_spirits' | 'wine' | 'malt_beverage';

/**
 * 27 CFR 16.21 — the mandatory health warning statement.
 *
 * This string is compared CHARACTER FOR CHARACTER against what appears on the
 * label. Do not "tidy" the punctuation, do not convert the straight apostrophe,
 * do not re-wrap. The two-space/one-space choice after each period matters:
 * TTB treats the statement as a fixed quotation, and the single space used here
 * matches the text as published.
 */
export const GOVERNMENT_WARNING_TEXT =
  'GOVERNMENT WARNING: (1) According to the Surgeon General, women should not ' +
  'drink alcoholic beverages during pregnancy because of the risk of birth ' +
  'defects. (2) Consumption of alcoholic beverages impairs your ability to ' +
  'drive a car or operate machinery, and may cause health problems.';

/**
 * 27 CFR 16.21 — "GOVERNMENT WARNING" must appear in capital letters and bold
 * type. This is the single most commonly gamed requirement, per TTB agent
 * interviews: applicants submit it in title case, in a lighter weight, or at a
 * reduced size hoping it reads as compliant at a glance.
 */
export const WARNING_PREFIX = 'GOVERNMENT WARNING:';

/**
 * 27 CFR 16.22 — minimum type size for the health warning, by container volume.
 * Expressed in millimetres of character height. `maxMl: null` means "and above".
 *
 * Also from 16.22: the statement must appear on a contrasting background,
 * separate and apart from all other information.
 */
export const WARNING_TYPE_SIZE_MM: ReadonlyArray<{
  maxMl: number | null;
  minMm: number;
  label: string;
}> = [
  { maxMl: 237, minMm: 1, label: '8 fl oz (237 mL) or less' },
  { maxMl: 3000, minMm: 2, label: 'over 8 fl oz up to 3 litres' },
  { maxMl: null, minMm: 3, label: 'over 3 litres' },
];

/**
 * 27 CFR 5.203 — authorized standards of fill for distilled spirits, in
 * millilitres. TTB substantially expanded this list effective 2025; the older
 * short list (1.75 L / 1 L / 750 / 375 / 200 / 100 / 50) is no longer complete
 * and rejecting a 700 mL or 500 mL bottle against it would be a false positive.
 */
export const DISTILLED_SPIRITS_FILLS_ML: readonly number[] = [
  3750, 3000, 2000, 1800, 1750, 1500, 1000, 945, 900, 750, 720, 710, 700, 570,
  500, 475, 375, 355, 350, 331, 250, 200, 187, 100, 50,
];

/** 27 CFR 4.72 — authorized standards of fill for wine, in millilitres. */
export const WINE_FILLS_ML: readonly number[] = [
  18000, 15000, 12000, 9000, 6000, 5000, 4500, 3000, 1800, 1500, 1000, 750, 720,
  700, 620, 568, 500, 473, 375, 355, 350, 300, 250, 200, 187, 100, 50,
];

/**
 * Malt beverages have no federal standards of fill (27 CFR 7 imposes none), so
 * a net-contents value is checked for presence and for agreement with the
 * application, but never rejected for being a non-standard size.
 */
export const MALT_BEVERAGE_HAS_STANDARDS_OF_FILL = false;

/**
 * Container sizes commonly used for malt beverages, in millilitres.
 *
 * NOT a regulatory list — 27 CFR 7 imposes no standards of fill on malt
 * beverages, and none of these is required or forbidden. They exist only to
 * populate a picker so an agent is choosing from a list rather than typing a
 * number, and any other value remains enterable.
 */
export const COMMON_MALT_BEVERAGE_SIZES_ML: readonly number[] = [
  5000, 3000, 2000, 1892, 1500, 1000, 946, 750, 650, 568, 500, 473, 440, 375,
  355, 350, 330, 250, 222, 200, 187,
];

export function authorizedFillsFor(cls: BeverageClass): readonly number[] | null {
  switch (cls) {
    case 'distilled_spirits':
      return DISTILLED_SPIRITS_FILLS_ML;
    case 'wine':
      return WINE_FILLS_ML;
    case 'malt_beverage':
      return null;
  }
}

/**
 * Permitted difference between the alcohol content stated on the label and the
 * value in the application, in percentage points of alcohol by volume.
 *
 * !! NEEDS SME SIGN-OFF !!
 * These reflect the labeling tolerances at 27 CFR 5.65 (spirits), 4.36 (wine),
 * and 7.71 (malt beverages). Wine's tolerance is split by strength. A compliance
 * SME should confirm each value and whether the agency applies the tolerance to
 * label-vs-application agreement (as modelled here) or only to label-vs-actual
 * laboratory analysis — these are different questions and this prototype
 * deliberately answers only the first.
 */
export const ABV_TOLERANCES: Readonly<
  Record<BeverageClass, ReadonlyArray<{ upToAbv: number | null; tolerance: number }>>
> = {
  distilled_spirits: [{ upToAbv: null, tolerance: 0.15 }],
  wine: [
    { upToAbv: 14, tolerance: 1.5 },
    { upToAbv: null, tolerance: 1.0 },
  ],
  malt_beverage: [{ upToAbv: null, tolerance: 0.3 }],
};

export function abvToleranceFor(cls: BeverageClass, statedAbv: number): number {
  const bands = ABV_TOLERANCES[cls];
  for (const band of bands) {
    if (band.upToAbv === null || statedAbv <= band.upToAbv) return band.tolerance;
  }
  // Unreachable given every table ends in an open band, but typed defensively.
  return bands[bands.length - 1]?.tolerance ?? 0;
}

/**
 * 27 CFR 5.65(a) — for distilled spirits, proof must be exactly twice the
 * alcohol-by-volume percentage when both are shown.
 */
export const PROOF_IS_TWICE_ABV = true;

/**
 * Which mandatory elements apply to which beverage class.
 *
 * `alcohol_content` is conditional in the real regulations (some malt beverages
 * and wines under 14% may omit it depending on state law and product type). The
 * prototype models it as "required unless the application says otherwise",
 * which is why `alcoholContentOptional` exists on the application record.
 */
export const MANDATORY_ELEMENTS: Readonly<Record<BeverageClass, readonly string[]>> = {
  distilled_spirits: [
    'brand_name',
    'class_type',
    'alcohol_content',
    'net_contents',
    'bottler_name_address',
    'government_warning',
  ],
  wine: [
    'brand_name',
    'class_type',
    'alcohol_content',
    'net_contents',
    'bottler_name_address',
    'government_warning',
  ],
  malt_beverage: [
    'brand_name',
    'class_type',
    'net_contents',
    'bottler_name_address',
    'government_warning',
  ],
};

/** Citations rendered in the UI next to each finding, so an agent can verify. */
export const CITATIONS: Readonly<Record<string, string>> = {
  brand_name: '27 CFR 5.63 / 4.32 / 7.62 — brand name',
  class_type: '27 CFR 5.63 / 4.32 / 7.62 — class and type designation',
  alcohol_content: '27 CFR 5.65 / 4.36 / 7.71 — alcohol content',
  net_contents: '27 CFR 5.203 / 4.72 — standards of fill',
  bottler_name_address: '27 CFR 5.66 / 4.35 / 7.66 — name and address',
  country_of_origin: '19 CFR 134 — country of origin marking (imports)',
  government_warning: '27 CFR 16.21–16.22 — health warning statement',
  image_quality: 'Internal — image must be legible to support a determination',
};
