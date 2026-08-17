import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runChecks, GOVERNMENT_WARNING_TEXT } from '../server/rules/index.ts';
import type { ApplicationRecord, LabelExtraction, Verdict } from '../server/rules/types.ts';
import {
  parseAlcoholContent,
  parseNetContents,
  normalizeForMatch,
} from '../server/rules/normalize.ts';
import { compareNames, diffWords, editDistance } from '../server/rules/similarity.ts';

/**
 * These tests exercise the entire compliance decision surface with no network,
 * no API key, and no model. That is the payoff of keeping every determination
 * in pure code: the regulator-facing logic is exhaustively testable, and a
 * disputed finding can be reproduced from a stored transcription years later.
 */

const APPLICATION: ApplicationRecord = {
  applicationId: 'TTB-TEST-0001',
  beverageClass: 'distilled_spirits',
  brandName: 'OLD TOM DISTILLERY',
  classType: 'Kentucky Straight Bourbon Whiskey',
  alcoholContentAbv: 45,
  netContentsMl: 750,
  bottlerNameAddress: 'Old Tom Distillery, Bardstown, Kentucky',
  countryOfOrigin: null,
  isImport: false,
};

const CLEAN_LABEL: LabelExtraction = {
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
  warningRelativeSize: 0.32,
  imageLegible: true,
  imageQualityIssues: [],
  transcriptionConfidence: 0.97,
  notes: null,
};

function label(overrides: Partial<LabelExtraction> = {}): LabelExtraction {
  return { ...CLEAN_LABEL, ...overrides };
}

function application(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return { ...APPLICATION, ...overrides };
}

function verdictOf(checks: { id: string; verdict: Verdict }[], id: string): Verdict {
  const check = checks.find((c) => c.id === id);
  assert.ok(check, `expected a check with id "${id}"`);
  return check.verdict;
}

describe('overall rollup', () => {
  it('passes a fully compliant label', () => {
    const { overall, checks } = runChecks(application(), label());
    assert.equal(overall, 'pass');
    assert.equal(verdictOf(checks, 'brand_name'), 'pass');
    assert.equal(verdictOf(checks, 'government_warning'), 'pass');
  });

  it('does not let the manual type-size confirmation drag every label into review', () => {
    // Regression guard for the failure mode that killed the previous vendor
    // pilot: if every label comes back "needs review", the tool saves nobody
    // any time and agents go back to doing it by eye.
    const { overall, checks } = runChecks(application(), label());
    assert.equal(overall, 'pass');
    assert.equal(verdictOf(checks, 'warning_legibility'), 'review');
    assert.ok(checks.find((c) => c.id === 'warning_legibility')?.requiresAgentConfirmation);
  });

  it('stops and asks for a better photo when the image is unreadable', () => {
    const { overall, checks, needsBetterImage } = runChecks(
      application(),
      label({ imageLegible: false, imageQualityIssues: ['too dark to read'] }),
    );
    assert.equal(overall, 'fail');
    assert.equal(needsBetterImage, true);
    // Critically, it must NOT emit confident findings derived from a bad photo.
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.id, 'image_quality');
  });
});

describe('government warning — exact text', () => {
  it('accepts the required statement verbatim', () => {
    const { checks } = runChecks(application(), label());
    assert.equal(verdictOf(checks, 'government_warning'), 'pass');
  });

  it('rejects title case in the prefix', () => {
    // Jenny Park caught exactly this in real casework. It is semantically
    // identical and a language model asked "is this correct?" will often say
    // yes — which is precisely why this decision is not delegated to one.
    const titleCase = GOVERNMENT_WARNING_TEXT.replace(
      'GOVERNMENT WARNING:',
      'Government Warning:',
    );
    const { overall, checks } = runChecks(
      application(),
      label({ governmentWarningText: titleCase, warningPrefixIsAllCaps: false }),
    );
    assert.equal(verdictOf(checks, 'government_warning'), 'fail');
    assert.equal(overall, 'fail');
    const check = checks.find((c) => c.id === 'government_warning');
    assert.match(check!.summary, /capital letters/i);
  });

  it('rejects a single changed word and shows where', () => {
    const reworded = GOVERNMENT_WARNING_TEXT.replace(
      'may cause health problems',
      'can cause health issues',
    );
    const { checks } = runChecks(application(), label({ governmentWarningText: reworded }));
    const check = checks.find((c) => c.id === 'government_warning');
    assert.equal(check?.verdict, 'fail');
    assert.ok(check?.diff && check.diff.length > 0, 'expected a word-level diff');
    assert.ok(check.diff!.some((s) => s.kind === 'removed' && /may/.test(s.text)));
    assert.ok(check.diff!.some((s) => s.kind === 'added' && /can/.test(s.text)));
  });

  it('rejects a missing warning', () => {
    const { checks } = runChecks(application(), label({ governmentWarningText: null }));
    assert.equal(verdictOf(checks, 'government_warning'), 'fail');
  });

  it('raises non-bold type for confirmation rather than rejecting it', () => {
    // Font weight is a judgement about rendering, not something readable from
    // the transcription. On a photo of a curved bottle it is unreliable, so it
    // is surfaced for an agent instead of failing a possibly-compliant label.
    const { checks } = runChecks(application(), label({ warningPrefixAppearsBold: false }));
    const check = checks.find((c) => c.id === 'government_warning');
    assert.equal(check?.verdict, 'review');
    assert.match(check!.summary, /bold/i);
  });

  it('accepts the whole statement set in capital letters', () => {
    // Found by running a real Taylor Cream Sherry back label through the tool.
    // Many real labels print the entire warning in capitals. 16.21 fixes the
    // WORDS; 16.22 requires only "GOVERNMENT WARNING" to be capitalised. A
    // case-sensitive comparison of the whole string rejected all of them.
    const allCaps = GOVERNMENT_WARNING_TEXT.toUpperCase();
    const { overall, checks } = runChecks(
      application(),
      label({ governmentWarningText: allCaps, warningPrefixIsAllCaps: true }),
    );
    assert.equal(verdictOf(checks, 'government_warning'), 'pass');
    assert.equal(overall, 'pass');
  });

  it('still rejects title case in the prefix even when wording is fine', () => {
    // The case-insensitive wording comparison must not weaken the one place
    // capitalisation genuinely matters.
    const titleCased = GOVERNMENT_WARNING_TEXT.replace(
      'GOVERNMENT WARNING:',
      'Government Warning:',
    );
    const { checks } = runChecks(
      application(),
      label({ governmentWarningText: titleCased, warningPrefixIsAllCaps: false }),
    );
    const check = checks.find((c) => c.id === 'government_warning');
    assert.equal(check?.verdict, 'fail');
    assert.match(check!.summary, /capital letters/i);
  });

  it('still catches a reworded statement regardless of casing', () => {
    const rewordedCaps = GOVERNMENT_WARNING_TEXT.toUpperCase().replace(
      'MAY CAUSE HEALTH PROBLEMS',
      'CAN CAUSE HEALTH ISSUES',
    );
    const { checks } = runChecks(
      application(),
      label({ governmentWarningText: rewordedCaps, warningPrefixIsAllCaps: true }),
    );
    assert.equal(verdictOf(checks, 'government_warning'), 'fail');
  });

  it('tolerates typographic noise that does not change the wording', () => {
    // Curly apostrophes, non-breaking spaces, and line-wrap hyphenation are
    // OCR artifacts, not regulatory violations.
    const noisy = GOVERNMENT_WARNING_TEXT.replace(/ /g, ' ').replace(
      'birth defects',
      'birth defects',
    );
    const { checks } = runChecks(application(), label({ governmentWarningText: noisy }));
    assert.equal(verdictOf(checks, 'government_warning'), 'pass');
  });
});

describe('brand name — judgement, not pattern matching', () => {
  it("treats STONE'S THROW and Stone's Throw as the same brand", () => {
    // Dave Morrison's example. Flagging this is the failure mode that makes a
    // compliance tool useless.
    const { checks, overall } = runChecks(
      application({ brandName: "Stone's Throw" }),
      label({ brandName: "STONE'S THROW" }),
    );
    assert.equal(verdictOf(checks, 'brand_name'), 'pass');
    assert.equal(overall, 'pass');
  });

  it('accepts an ampersand written out as "and"', () => {
    const { checks } = runChecks(
      application({ brandName: 'Smith & Sons' }),
      label({ brandName: 'SMITH AND SONS' }),
    );
    assert.equal(verdictOf(checks, 'brand_name'), 'pass');
  });

  it('flags a genuinely different brand', () => {
    const { checks } = runChecks(application(), label({ brandName: 'YOUNG JIM DISTILLERY' }));
    assert.equal(verdictOf(checks, 'brand_name'), 'fail');
  });

  it('asks a human about a near miss rather than deciding', () => {
    const { checks } = runChecks(application(), label({ brandName: 'OLD TOMM DISTILLERY' }));
    assert.equal(verdictOf(checks, 'brand_name'), 'review');
  });

  it('fails when the brand is missing from the label', () => {
    const { checks } = runChecks(application(), label({ brandName: null }));
    assert.equal(verdictOf(checks, 'brand_name'), 'fail');
  });

  it('reports "not compared" rather than a violation when the application is empty', () => {
    // This is the unmatched-batch-file path. An earlier version put the
    // FILENAME in brandName, so an unmatched label was compared against
    // "image-01.jpeg" and always reported a brand violation — a false
    // rejection manufactured entirely by the tool's own placeholder data.
    const { checks, overall } = runChecks(
      application({ brandName: '', classType: '', bottlerNameAddress: null }),
      label({ brandName: 'TAYLOR' }),
    );
    const brand = checks.find((c) => c.id === 'brand_name');

    // Not a violation, and not a judgement call either — a missing input.
    assert.equal(brand?.verdict, 'not_compared');
    assert.equal(brand?.found, 'TAYLOR');
    assert.notEqual(overall, 'fail');
  });

  it('does not let missing application data masquerade as items needing judgement', () => {
    // With no application at all, the old behaviour reported one "needs your
    // judgement" item per field, which buried the single item that genuinely
    // needed an agent's eye.
    const { checks, headline } = runChecks(
      application({
        brandName: '',
        classType: '',
        alcoholContentAbv: null,
        bottlerNameAddress: null,
      }),
      label(),
    );

    const reviews = checks.filter(
      (c) => c.verdict === 'review' && !c.requiresAgentConfirmation,
    );
    assert.equal(reviews.length, 0, `unexpected review items: ${reviews.map((r) => r.title)}`);
    assert.match(headline, /could not be compared/i);
  });
});

describe('bottler name and address', () => {
  it('ignores the statutory lead-in printed above the name', () => {
    // Opus 5 transcribes the lead-in because it is genuinely on the label.
    // Virtually every real spirits label carries one, so treating it as part
    // of the name would produce a false positive on almost every submission.
    const { checks } = runChecks(
      application(),
      label({
        bottlerNameAddress: 'DISTILLED AND BOTTLED BY, Old Tom Distillery, Bardstown, Kentucky',
      }),
    );
    assert.equal(verdictOf(checks, 'bottler_name_address'), 'pass');
  });

  it('still shows the agent what was actually printed', () => {
    const printed = 'BOTTLED BY Old Tom Distillery, Bardstown, KY';
    const { checks } = runChecks(application(), label({ bottlerNameAddress: printed }));
    const check = checks.find((c) => c.id === 'bottler_name_address');
    assert.equal(check?.verdict, 'pass');
    // The comparison ignored the lead-in; the evidence shown must not.
    assert.equal(check?.found, printed);
  });

  it('handles the other statutory lead-in forms', () => {
    for (const leadIn of [
      'PRODUCED AND BOTTLED BY',
      'DISTILLED BY',
      'IMPORTED BY',
      'BLENDED BY:',
      'MANUFACTURED FOR',
    ]) {
      const { checks } = runChecks(
        application(),
        label({ bottlerNameAddress: `${leadIn} Old Tom Distillery, Bardstown, Kentucky` }),
      );
      assert.equal(
        verdictOf(checks, 'bottler_name_address'),
        'pass',
        `lead-in "${leadIn}" was not stripped`,
      );
    }
  });

  it('does not strip a company name that merely starts with a similar word', () => {
    // "Bottled Goods Co." is a name, not a lead-in — there is no "by"/"for".
    const { checks } = runChecks(
      application({ bottlerNameAddress: 'Bottled Goods Company, Louisville, KY' }),
      label({ bottlerNameAddress: 'Bottled Goods Co., Louisville, Kentucky' }),
    );
    assert.equal(verdictOf(checks, 'bottler_name_address'), 'pass');
  });

  it('still catches a genuinely different bottler', () => {
    const { checks } = runChecks(
      application(),
      label({ bottlerNameAddress: 'BOTTLED BY Younger Jim Spirits, Portland, Oregon' }),
    );
    assert.equal(verdictOf(checks, 'bottler_name_address'), 'fail');
  });
});

describe('alcohol content', () => {
  it('passes an exact match', () => {
    assert.equal(verdictOf(runChecks(application(), label()).checks, 'alcohol_content'), 'pass');
  });

  it('passes a difference inside the spirits tolerance', () => {
    const { checks } = runChecks(
      application(),
      label({ alcoholContentText: '45.1% Alc./Vol.', alcoholContentAbv: 45.1, proof: null }),
    );
    assert.equal(verdictOf(checks, 'alcohol_content'), 'pass');
  });

  it('fails a difference outside the tolerance', () => {
    const { checks } = runChecks(
      application(),
      label({ alcoholContentText: '40% Alc./Vol. (80 Proof)', alcoholContentAbv: 40, proof: 80 }),
    );
    assert.equal(verdictOf(checks, 'alcohol_content'), 'fail');
  });

  it('catches a label that contradicts itself on proof', () => {
    const { checks } = runChecks(
      application(),
      label({ alcoholContentText: '45% Alc./Vol. (86 Proof)', alcoholContentAbv: 45, proof: 86 }),
    );
    const check = checks.find((c) => c.id === 'alcohol_content');
    assert.equal(check?.verdict, 'fail');
    assert.match(check!.summary, /contradicts itself/i);
  });

  it('applies the wider tolerance band to wine under 14%', () => {
    const app = application({ beverageClass: 'wine', alcoholContentAbv: 12.5 });
    const { checks } = runChecks(
      app,
      label({ alcoholContentText: '13.5% Alc./Vol.', alcoholContentAbv: 13.5, proof: null }),
    );
    assert.equal(verdictOf(checks, 'alcohol_content'), 'pass');
  });

  it('applies the narrower tolerance band to wine over 14%', () => {
    const app = application({ beverageClass: 'wine', alcoholContentAbv: 15 });
    const { checks } = runChecks(
      app,
      label({ alcoholContentText: '16.5% Alc./Vol.', alcoholContentAbv: 16.5, proof: null }),
    );
    assert.equal(verdictOf(checks, 'alcohol_content'), 'fail');
  });

  it('does not demand alcohol content from a product that is exempt from stating it', () => {
    // The brief lists alcohol content as required "with some exceptions for
    // certain wine/beer". A lawfully absent statement is not a missing one,
    // and the two must not produce the same finding.
    const exempt = application({
      beverageClass: 'wine',
      alcoholContentAbv: null,
      alcoholContentOptional: true,
    });
    const bare = label({ alcoholContentText: null, alcoholContentAbv: null, proof: null });

    const { checks, overall } = runChecks(exempt, bare);
    assert.equal(verdictOf(checks, 'alcohol_content'), 'not_applicable');
    assert.notEqual(overall, 'fail');
  });

  it('still expects alcohol content when the exemption is not claimed', () => {
    // The mirror of the test above: without the flag, the identical label and
    // application must not pass silently. This is what proves the flag is
    // load-bearing rather than decorative.
    const notExempt = application({ beverageClass: 'wine', alcoholContentAbv: 12.5 });
    const bare = label({ alcoholContentText: null, alcoholContentAbv: null, proof: null });

    assert.equal(verdictOf(runChecks(notExempt, bare).checks, 'alcohol_content'), 'fail');
  });
});

describe('net contents and standards of fill', () => {
  it('passes an authorized size that matches the application', () => {
    assert.equal(verdictOf(runChecks(application(), label()).checks, 'net_contents'), 'pass');
  });

  it('accepts 700 mL, which the pre-2025 list would have wrongly rejected', () => {
    const { checks } = runChecks(
      application({ netContentsMl: 700 }),
      label({ netContentsText: '700 mL', netContentsMl: 700 }),
    );
    assert.equal(verdictOf(checks, 'net_contents'), 'pass');
  });

  it('rejects a size that is not an authorized standard of fill', () => {
    const { checks } = runChecks(
      application({ netContentsMl: 800 }),
      label({ netContentsText: '800 mL', netContentsMl: 800 }),
    );
    const check = checks.find((c) => c.id === 'net_contents');
    assert.equal(check?.verdict, 'fail');
    assert.match(check!.detail ?? '', /nearest authorized/i);
  });

  it('rejects a size that disagrees with the application', () => {
    const { checks } = runChecks(
      application({ netContentsMl: 750 }),
      label({ netContentsText: '375 mL', netContentsMl: 375 }),
    );
    assert.equal(verdictOf(checks, 'net_contents'), 'fail');
  });

  it('does not impose standards of fill on malt beverages', () => {
    const app = application({ beverageClass: 'malt_beverage', netContentsMl: 355 });
    const { checks } = runChecks(
      app,
      label({ netContentsText: '12 FL OZ', netContentsMl: 354.88 }),
    );
    assert.equal(verdictOf(checks, 'net_contents'), 'pass');
  });
});

describe('country of origin', () => {
  it('is skipped for domestic products', () => {
    const { checks } = runChecks(application(), label());
    assert.equal(verdictOf(checks, 'country_of_origin'), 'not_applicable');
  });

  it('is required for imports', () => {
    const app = application({ isImport: true, countryOfOrigin: 'Product of Scotland' });
    const { checks } = runChecks(app, label({ countryOfOrigin: null }));
    assert.equal(verdictOf(checks, 'country_of_origin'), 'fail');
  });
});

describe('image quality', () => {
  it('asks an agent to double-check a readable but imperfect photo', () => {
    const { overall, checks } = runChecks(
      application(),
      label({ imageQualityIssues: ['glare across the lower third'] }),
    );
    assert.equal(verdictOf(checks, 'image_quality'), 'review');
    assert.equal(overall, 'review');
  });

  it('flags low transcription confidence even without a named issue', () => {
    const { checks } = runChecks(application(), label({ transcriptionConfidence: 0.4 }));
    assert.equal(verdictOf(checks, 'image_quality'), 'review');
  });
});

describe('text parsing helpers', () => {
  it('reads ABV and proof without confusing the two', () => {
    assert.deepEqual(parseAlcoholContent('45% Alc./Vol. (90 Proof)'), { abv: 45, proof: 90 });
    assert.deepEqual(parseAlcoholContent('ALC. 40% BY VOL.'), { abv: 40, proof: null });
    assert.deepEqual(parseAlcoholContent('13.5% alc/vol'), { abv: 13.5, proof: null });
    assert.deepEqual(parseAlcoholContent('90 PROOF'), { abv: null, proof: 90 });
  });

  it('handles a comma decimal separator', () => {
    assert.equal(parseAlcoholContent('ALC 5,2% VOL').abv, 5.2);
  });

  it('converts net contents to millilitres', () => {
    assert.equal(parseNetContents('750 mL'), 750);
    assert.equal(parseNetContents('1.75 L'), 1750);
    assert.equal(parseNetContents('1 LITER'), 1000);
    assert.ok(Math.abs(parseNetContents('12 FL OZ')! - 354.88) < 0.1);
    assert.equal(parseNetContents('no volume here'), null);
  });

  it('normalizes possessives and articles consistently', () => {
    assert.equal(normalizeForMatch("STONE'S THROW"), normalizeForMatch("Stone's Throw"));
    assert.equal(normalizeForMatch('The Macallan'), 'macallan');
  });

  it('treats a state name and its postal code as the same place', () => {
    // Bottler addresses are written both ways constantly. Without this, every
    // such pair lands just under the match threshold and makes agent work for
    // a difference with no regulatory meaning.
    assert.equal(
      normalizeForMatch('Louisville, Kentucky'),
      normalizeForMatch('Louisville, KY'),
    );
    assert.equal(
      normalizeForMatch('Brooklyn, New York'),
      normalizeForMatch('Brooklyn, NY'),
    );
  });

  it('matches the longer state name first', () => {
    // "west virginia" must not be matched as "virginia" with a stray "west".
    assert.notEqual(
      normalizeForMatch('Charleston, West Virginia'),
      normalizeForMatch('Charleston, Virginia'),
    );
  });

  it('ignores corporate suffixes when comparing bottlers', () => {
    assert.equal(
      normalizeForMatch('Stone\'s Throw Distilling Co.'),
      normalizeForMatch('Stones Throw Distillers Company'),
    );
    assert.equal(
      normalizeForMatch('Old Tom Distillery, Inc.'),
      normalizeForMatch('Old Tom Distillery'),
    );
  });

  it('converges Colorado written either way', () => {
    // "co" is ambiguous between Colorado and Company, so it is dropped from
    // both sides. Dropping is symmetric, so equal inputs stay equal — which is
    // what matching actually needs.
    assert.equal(normalizeForMatch('Denver, Colorado'), normalizeForMatch('Denver, CO'));
  });

  it('still surfaces a genuinely different state as a mismatch', () => {
    // The safety check on dropping "co": a real state disagreement must not
    // silently normalize away.
    assert.notEqual(normalizeForMatch('Denver, CO'), normalizeForMatch('Denver, CA'));
  });
});

describe('similarity primitives', () => {
  it('measures edit distance', () => {
    assert.equal(editDistance('kitten', 'sitting'), 3);
    assert.equal(editDistance('same', 'same'), 0);
  });

  it('respects the early-exit ceiling', () => {
    assert.ok(editDistance('a'.repeat(50), 'b'.repeat(50), 5) > 5);
  });

  it('grades name matches into actionable tiers', () => {
    assert.equal(compareNames('OLD TOM', 'OLD TOM').strength, 'exact');
    assert.equal(compareNames('OLD TOM', 'Old Tom').strength, 'equivalent');
    assert.equal(compareNames('Smith and Sons Distillery', 'Distillery Smith & Sons').strength, 'equivalent');
    assert.equal(compareNames('OLD TOM', 'YOUNG JIM').strength, 'different');
  });

  it('produces a diff that reconstructs both sides', () => {
    const segments = diffWords('the quick brown fox', 'the slow brown fox');
    const expectedSide = segments
      .filter((s) => s.kind !== 'added')
      .map((s) => s.text)
      .join('');
    const actualSide = segments
      .filter((s) => s.kind !== 'removed')
      .map((s) => s.text)
      .join('');
    assert.equal(expectedSide, 'the quick brown fox');
    assert.equal(actualSide, 'the slow brown fox');
  });
});
