import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mergeExtractions, conflicts } from '../server/rules/merge.ts';
import { runChecks, GOVERNMENT_WARNING_TEXT } from '../server/rules/index.ts';
import type { ApplicationRecord, LabelExtraction } from '../server/rules/types.ts';

/**
 * Multi-panel merging, modelled on a real Taylor Cream Sherry bottle: brand and
 * class/type on the front, net contents / bottler / government warning on the
 * back. Checking either photograph alone reports a compliant product as
 * missing mandatory elements.
 */

const EMPTY: LabelExtraction = {
  brandName: null,
  classType: null,
  alcoholContentText: null,
  alcoholContentAbv: null,
  proof: null,
  netContentsText: null,
  netContentsMl: null,
  bottlerNameAddress: null,
  countryOfOrigin: null,
  governmentWarningText: null,
  warningPrefixIsAllCaps: null,
  warningPrefixAppearsBold: null,
  warningAppearsSeparate: null,
  warningRelativeSize: null,
  imageLegible: true,
  imageQualityIssues: [],
  transcriptionConfidence: 0.95,
  notes: null,
};

const FRONT: LabelExtraction = {
  ...EMPTY,
  brandName: 'TAYLOR',
  classType: 'CREAM SHERRY',
  alcoholContentText: 'ALCOHOL 18% BY VOLUME',
  alcoholContentAbv: 18,
  imageQualityIssues: ['curved bottle surface distorts edge text'],
  transcriptionConfidence: 0.9,
};

const BACK: LabelExtraction = {
  ...EMPTY,
  brandName: 'TAYLOR',
  classType: 'CREAM SHERRY',
  netContentsText: '1.5L',
  netContentsMl: 1500,
  bottlerNameAddress: 'PRODUCED AND BOTTLED BY THE TAYLOR WINE COMPANY, CANANDAIGUA, N.Y.',
  governmentWarningText: GOVERNMENT_WARNING_TEXT.toUpperCase(),
  warningPrefixIsAllCaps: true,
  warningPrefixAppearsBold: true,
  warningAppearsSeparate: true,
  warningRelativeSize: 0.12,
  imageQualityIssues: ['label wrinkled'],
  transcriptionConfidence: 0.85,
};

const WINE_APPLICATION: ApplicationRecord = {
  applicationId: 'TTB-TEST-WINE',
  beverageClass: 'wine',
  brandName: 'Taylor',
  classType: 'Cream Sherry',
  alcoholContentAbv: 18,
  netContentsMl: 1500,
  bottlerNameAddress: 'The Taylor Wine Company, Canandaigua, NY',
  countryOfOrigin: null,
  isImport: false,
};

describe('merging label panels', () => {
  it('returns the single panel unchanged when there is only one', () => {
    assert.deepEqual(mergeExtractions([FRONT]), FRONT);
  });

  it('fills each field from whichever panel carries it', () => {
    const merged = mergeExtractions([FRONT, BACK]);
    assert.equal(merged.brandName, 'TAYLOR');
    assert.equal(merged.alcoholContentAbv, 18);
    assert.equal(merged.netContentsMl, 1500);
    assert.match(merged.bottlerNameAddress ?? '', /TAYLOR WINE COMPANY/);
    assert.ok(merged.governmentWarningText);
  });

  it('takes the warning and its typography from the same panel', () => {
    // The front reports nothing about warning typography. Attributing the
    // front's nulls to the back's warning text would lose the caps finding.
    const merged = mergeExtractions([FRONT, BACK]);
    assert.equal(merged.warningPrefixIsAllCaps, true);
    assert.equal(merged.warningRelativeSize, 0.12);
  });

  it('is pessimistic about image quality across panels', () => {
    const merged = mergeExtractions([FRONT, BACK]);
    assert.equal(merged.transcriptionConfidence, 0.85);
    assert.deepEqual(merged.imageQualityIssues, [
      'curved bottle surface distorts edge text',
      'label wrinkled',
    ]);

    const withBadPanel = mergeExtractions([FRONT, { ...BACK, imageLegible: false }]);
    assert.equal(withBadPanel.imageLegible, false);
  });

  it('retires the "only one panel visible" complaint once both panels are supplied', () => {
    // The front reader could not see the back because it was a photo of the
    // front. Carrying that through told agents to go and find something they
    // had already provided.
    const merged = mergeExtractions([
      { ...FRONT, imageQualityIssues: ['only front label visible', 'dim lighting'] },
      { ...BACK, imageQualityIssues: ['label wrinkled'] },
    ]);
    assert.deepEqual(merged.imageQualityIssues, ['dim lighting', 'label wrinkled']);
  });

  it('keeps the complaint when only one panel was actually supplied', () => {
    const single = mergeExtractions([
      { ...FRONT, imageQualityIssues: ['only front label visible'] },
    ]);
    assert.deepEqual(single.imageQualityIssues, ['only front label visible']);
  });

  it('collapses near-duplicate observations from different panels', () => {
    const merged = mergeExtractions([
      { ...FRONT, imageQualityIssues: ['curved bottle surface distorts edge text'] },
      { ...BACK, imageQualityIssues: ['curved bottle surface distorts text', 'slight angle'] },
    ]);
    assert.deepEqual(merged.imageQualityIssues, [
      'curved bottle surface distorts edge text',
      'slight angle',
    ]);
  });
});

describe('typography judgements are weighted by image quality', () => {
  // A COMPLETE label — both panels merged — so the verdict reflects the
  // typography question rather than a mandatory element that lives on the
  // panel the fixture happens to omit.
  const COMPLETE = mergeExtractions([FRONT, BACK]);

  const CLEAN: LabelExtraction = {
    ...COMPLETE,
    imageQualityIssues: [],
    transcriptionConfidence: 0.97,
  };

  it('lets a not-bold reading drive the verdict when the image is clean', () => {
    const { checks, overall } = runChecks(WINE_APPLICATION, {
      ...CLEAN,
      warningPrefixAppearsBold: false,
    });
    const check = checks.find((c) => c.id === 'government_warning');
    assert.equal(check?.verdict, 'review');
    assert.notEqual(check?.requiresAgentConfirmation, true);
    assert.equal(overall, 'review');
  });

  it('does not let a not-bold reading drive the verdict on a poor photograph', () => {
    // A curved, dim, wrinkled bottle cannot support a judgement about stroke
    // weight. Letting it drive the verdict makes the tool cry wolf on every
    // field photograph.
    const { checks } = runChecks(WINE_APPLICATION, {
      ...COMPLETE,
      imageQualityIssues: ['curved bottle surface distorts text', 'label wrinkled'],
      transcriptionConfidence: 0.8,
      warningPrefixAppearsBold: false,
    });
    const check = checks.find((c) => c.id === 'government_warning');
    assert.equal(check?.verdict, 'review');
    assert.equal(check?.requiresAgentConfirmation, true);
    assert.match(check!.summary, /not clear enough/i);
  });

  it('never downgrades an actual wording or capitalization violation', () => {
    // The image-quality allowance must not leak into the checks that are read
    // from the transcription rather than from the pixels.
    const { checks } = runChecks(WINE_APPLICATION, {
      ...COMPLETE,
      imageQualityIssues: ['curved bottle surface distorts text'],
      transcriptionConfidence: 0.6,
      warningPrefixIsAllCaps: false,
      governmentWarningText: GOVERNMENT_WARNING_TEXT.replace(
        'GOVERNMENT WARNING:',
        'Government Warning:',
      ),
    });
    const check = checks.find((c) => c.id === 'government_warning');
    assert.equal(check?.verdict, 'fail');
    assert.notEqual(check?.requiresAgentConfirmation, true);
  });

  it('clears the mandatory elements that are only complete across both panels', () => {
    // The whole point. Alone, the front is reported as missing a government
    // warning and net contents that are printed on the back.
    const frontAlone = runChecks(WINE_APPLICATION, FRONT);
    assert.equal(frontAlone.overall, 'fail');
    assert.equal(
      frontAlone.checks.find((c) => c.id === 'government_warning')?.verdict,
      'fail',
    );
    assert.equal(frontAlone.checks.find((c) => c.id === 'net_contents')?.verdict, 'fail');

    const merged = runChecks(WINE_APPLICATION, mergeExtractions([FRONT, BACK]));

    // Nothing is a violation any more...
    assert.notEqual(merged.overall, 'fail', merged.headline);
    for (const check of merged.checks) {
      assert.notEqual(check.verdict, 'fail', `${check.title} should not fail: ${check.summary}`);
    }
    // ...and specifically, the two that the front alone got wrong now pass.
    assert.equal(merged.checks.find((c) => c.id === 'government_warning')?.verdict, 'pass');
    assert.equal(merged.checks.find((c) => c.id === 'net_contents')?.verdict, 'pass');

    // It still lands on "review" overall, because both photographs are
    // imperfect — which is the honest answer for a curved, wrinkled bottle.
    assert.equal(merged.overall, 'review');
    assert.equal(merged.checks.find((c) => c.id === 'image_quality')?.verdict, 'review');
  });

  it('surfaces a disagreement between panels instead of silently picking one', () => {
    const inconsistent = { ...BACK, alcoholContentAbv: 17, alcoholContentText: '17% ALC' };
    const merged = mergeExtractions([FRONT, inconsistent]);
    assert.match(merged.notes ?? '', /disagree/i);
    assert.match(merged.notes ?? '', /alcoholContentAbv/);
  });

  it('reports no conflict when panels simply repeat the same value', () => {
    assert.deepEqual(conflicts([FRONT, BACK]), []);
  });
});

describe('warning formatting: decided vs deferred', () => {
  const base = mergeExtractions([FRONT, BACK]);

  it('rejects wrong capitalization, which is readable from the text', () => {
    const { checks } = runChecks(WINE_APPLICATION, {
      ...base,
      governmentWarningText: GOVERNMENT_WARNING_TEXT.replace(
        'GOVERNMENT WARNING:',
        'Government Warning:',
      ),
      warningPrefixIsAllCaps: false,
    });
    assert.equal(checks.find((c) => c.id === 'government_warning')?.verdict, 'fail');
  });

  it('defers on bold, which is a judgement about rendering', () => {
    // Found on a real curved, wrinkled, angled bottle photo. Rejecting a
    // compliant label because font weight is hard to see in a photograph is
    // exactly the false positive that makes agents stop trusting the tool.
    const { checks, overall } = runChecks(WINE_APPLICATION, {
      ...base,
      warningPrefixAppearsBold: false,
    });
    const check = checks.find((c) => c.id === 'government_warning');
    assert.equal(check?.verdict, 'review');
    assert.notEqual(check?.verdict, 'fail');
    assert.match(check!.summary, /bold/i);
    assert.equal(overall, 'review');
  });

  it('defers on separation for the same reason', () => {
    const { checks } = runChecks(WINE_APPLICATION, {
      ...base,
      warningAppearsSeparate: false,
    });
    assert.equal(checks.find((c) => c.id === 'government_warning')?.verdict, 'review');
  });

  it('still fails wrong wording even when the typography is fine', () => {
    const { checks } = runChecks(WINE_APPLICATION, {
      ...base,
      governmentWarningText: base.governmentWarningText!.replace(
        'MAY CAUSE HEALTH PROBLEMS',
        'CAN CAUSE HEALTH ISSUES',
      ),
    });
    assert.equal(checks.find((c) => c.id === 'government_warning')?.verdict, 'fail');
  });
});
