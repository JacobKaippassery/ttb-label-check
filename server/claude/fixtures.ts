import { GOVERNMENT_WARNING_TEXT } from '../rules/reference.ts';
import type { LabelExtraction } from '../rules/types.ts';

/**
 * Stored transcriptions for the generated sample labels, used by demo mode.
 *
 * These are what Claude returns for each of the eight samples — captured once
 * and checked in so the whole application runs with no API key. That matters
 * for three reasons:
 *
 *   1. Anyone reviewing this project can clone it and see the full pipeline
 *      work immediately, instead of hitting a "no API key" wall.
 *   2. The rules engine, diff rendering, batch streaming, and CSV export can be
 *      demonstrated and debugged without spending tokens on every iteration.
 *   3. It draws a hard line under what is fixture data and what is a real
 *      determination. Demo results are badged as such everywhere they appear.
 *
 * This is NOT a fallback. If a real API call fails, the tool reports the
 * failure — it never silently substitutes fixture data for a live result.
 */

const BASE: LabelExtraction = {
  brandName: 'OLD TOM DISTILLERY',
  classType: 'Kentucky Straight Bourbon Whiskey',
  alcoholContentText: '45% Alc./Vol. (90 Proof)',
  alcoholContentAbv: 45,
  proof: 90,
  netContentsText: '750 mL',
  netContentsMl: 750,
  bottlerNameAddress: 'Old Tom Distillery, Bardstown, Kentucky',
  countryOfOrigin: null,
  governmentWarningText: GOVERNMENT_WARNING_TEXT,
  warningPrefixIsAllCaps: true,
  warningPrefixAppearsBold: true,
  warningAppearsSeparate: true,
  warningRelativeSize: 0.28,
  imageLegible: true,
  imageQualityIssues: [],
  transcriptionConfidence: 0.97,
  notes: null,
};

export const DEMO_FIXTURES: Readonly<Record<string, LabelExtraction>> = {
  '01-compliant.png': BASE,

  '02-warning-title-case.png': {
    ...BASE,
    governmentWarningText: GOVERNMENT_WARNING_TEXT.replace(
      'GOVERNMENT WARNING:',
      'Government Warning:',
    ),
    warningPrefixIsAllCaps: false,
  },

  '03-abv-mismatch.png': {
    ...BASE,
    alcoholContentText: '40% Alc./Vol. (80 Proof)',
    alcoholContentAbv: 40,
    proof: 80,
  },

  '04-warning-reworded.png': {
    ...BASE,
    governmentWarningText: GOVERNMENT_WARNING_TEXT.replace(
      'may cause health problems',
      'can cause health issues',
    ),
  },

  '05-brand-case-variant.png': {
    ...BASE,
    brandName: "STONE'S THROW",
    classType: 'Straight Rye Whiskey',
    alcoholContentText: '47% Alc./Vol. (94 Proof)',
    alcoholContentAbv: 47,
    proof: 94,
    bottlerNameAddress: "Stone's Throw Distilling Co., Louisville, Kentucky",
  },

  '06-proof-mismatch.png': {
    ...BASE,
    alcoholContentText: '45% Alc./Vol. (86 Proof)',
    alcoholContentAbv: 45,
    proof: 86,
  },

  '07-nonstandard-fill.png': {
    ...BASE,
    netContentsText: '800 mL',
    netContentsMl: 800,
  },

  '08-poor-image.jpg': {
    ...BASE,
    warningRelativeSize: 0.24,
    imageQualityIssues: [
      'glare across the upper right of the label',
      'photographed at an angle',
      'low light',
    ],
    transcriptionConfidence: 0.62,
    notes: 'The warning text was readable but the lower lines are partially obscured by glare.',
  },
};

/**
 * Anything not in the fixture set gets the compliant baseline, so an arbitrary
 * uploaded image still exercises the full UI. The note makes it unmistakable
 * that nothing was actually read off that image.
 */
export function fixtureFor(fileName: string): LabelExtraction {
  const known = DEMO_FIXTURES[fileName];
  if (known) return known;

  return {
    ...BASE,
    notes:
      `Demo mode: no stored transcription exists for "${fileName}", so a placeholder ` +
      'compliant label was substituted. Nothing was read from this image.',
  };
}
