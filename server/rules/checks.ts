import {
  GOVERNMENT_WARNING_TEXT,
  WARNING_PREFIX,
  CITATIONS,
  abvToleranceFor,
  authorizedFillsFor,
  PROOF_IS_TWICE_ABV,
  MANDATORY_ELEMENTS,
} from './reference.ts';
import { normalizeWhitespaceAndPunctuation, stripBottlerLeadIn } from './normalize.ts';
import { compareNames, diffWords } from './similarity.ts';
import type { ApplicationRecord, CheckResult, LabelExtraction } from './types.ts';

/** Formats millilitres for display, preferring litres above 1 L. */
function formatMl(ml: number): string {
  return ml >= 1000 ? `${(ml / 1000).toFixed(2).replace(/\.?0+$/, '')} L` : `${Math.round(ml)} mL`;
}

function isRequired(app: ApplicationRecord, element: string): boolean {
  return MANDATORY_ELEMENTS[app.beverageClass].includes(element);
}

/**
 * Generic "does the label text agree with the application text" check, used for
 * brand name, class/type, and bottler name/address.
 *
 * The `equivalent` tier is what stops this tool from drowning agents in
 * capitalization false positives.
 */
function textAgreementCheck(opts: {
  id: string;
  title: string;
  required: boolean;
  labelValue: string | null;
  applicationValue: string | null | undefined;
  /** Addresses tolerate more variation than brand names do. */
  lenient?: boolean;
}): CheckResult {
  const { id, title, required, labelValue, applicationValue, lenient = false } = opts;
  const citation = CITATIONS[id] ?? '';

  if (!applicationValue) {
    return {
      id,
      title,
      verdict: required ? 'not_compared' : 'not_applicable',
      summary: required
        ? 'No application record to compare against. What the label says is shown below.'
        : 'Not required for this product type.',
      expected: null,
      found: labelValue,
      citation,
    };
  }

  if (!labelValue) {
    return {
      id,
      title,
      verdict: required ? 'fail' : 'review',
      summary: required
        ? 'Required on the label, but not found.'
        : 'Listed in the application but not found on the label.',
      expected: applicationValue,
      found: null,
      citation,
    };
  }

  const match = compareNames(labelValue, applicationValue);

  if (match.strength === 'exact' || match.strength === 'equivalent') {
    return {
      id,
      title,
      verdict: 'pass',
      summary: match.reason,
      expected: applicationValue,
      found: labelValue,
      citation,
    };
  }

  if (match.strength === 'close') {
    return {
      id,
      title,
      // An address that differs slightly is routine; a brand name that differs
      // slightly is a trademark question an agent must actually look at.
      verdict: lenient && match.score >= 0.9 ? 'pass' : 'review',
      summary: match.reason,
      expected: applicationValue,
      found: labelValue,
      citation,
      detail: `Similarity ${(match.score * 100).toFixed(0)}%.`,
    };
  }

  return {
    id,
    title,
    verdict: 'fail',
    summary: match.reason,
    expected: applicationValue,
    found: labelValue,
    citation,
    detail: `Similarity ${(match.score * 100).toFixed(0)}%.`,
  };
}

export function checkBrandName(app: ApplicationRecord, label: LabelExtraction): CheckResult {
  return textAgreementCheck({
    id: 'brand_name',
    title: 'Brand name',
    required: isRequired(app, 'brand_name'),
    labelValue: label.brandName,
    applicationValue: app.brandName,
  });
}

export function checkClassType(app: ApplicationRecord, label: LabelExtraction): CheckResult {
  return textAgreementCheck({
    id: 'class_type',
    title: 'Class / type designation',
    required: isRequired(app, 'class_type'),
    labelValue: label.classType,
    applicationValue: app.classType,
  });
}

export function checkBottler(app: ApplicationRecord, label: LabelExtraction): CheckResult {
  const result = textAgreementCheck({
    id: 'bottler_name_address',
    title: 'Bottler name and address',
    required: isRequired(app, 'bottler_name_address'),
    // The label's statutory lead-in ("DISTILLED AND BOTTLED BY") is framing,
    // not part of the name and address, and the application never records it.
    labelValue: label.bottlerNameAddress ? stripBottlerLeadIn(label.bottlerNameAddress) : null,
    applicationValue: app.bottlerNameAddress ? stripBottlerLeadIn(app.bottlerNameAddress) : null,
    lenient: true,
  });

  // Show the agent what is actually printed, including the lead-in, even though
  // the comparison ignored it. Evidence shown should be evidence as transcribed.
  return { ...result, found: label.bottlerNameAddress ?? result.found };
}

export function checkCountryOfOrigin(
  app: ApplicationRecord,
  label: LabelExtraction,
): CheckResult {
  if (!app.isImport) {
    return {
      id: 'country_of_origin',
      title: 'Country of origin',
      verdict: 'not_applicable',
      summary: 'Not an imported product, so no country of origin is required.',
      expected: null,
      found: label.countryOfOrigin,
      citation: CITATIONS.country_of_origin ?? '',
    };
  }
  return textAgreementCheck({
    id: 'country_of_origin',
    title: 'Country of origin',
    required: true,
    labelValue: label.countryOfOrigin,
    applicationValue: app.countryOfOrigin,
  });
}

/**
 * Alcohol content. Two distinct questions, answered separately:
 *   1. Does the ABV on the label agree with the application, within tolerance?
 *   2. If proof is also shown, is it exactly twice the ABV?
 */
export function checkAlcoholContent(
  app: ApplicationRecord,
  label: LabelExtraction,
): CheckResult {
  const id = 'alcohol_content';
  const title = 'Alcohol content';
  const citation = CITATIONS[id] ?? '';
  const required = isRequired(app, id) && !app.alcoholContentOptional;

  const expected = app.alcoholContentAbv;
  const found = label.alcoholContentAbv;
  const expectedText = expected != null ? `${expected}% Alc./Vol.` : null;

  if (expected == null) {
    return {
      id,
      title,
      verdict: required ? 'not_compared' : 'not_applicable',
      summary: required
        ? 'No alcohol content in the application to compare against. What the label says is shown below.'
        : 'Alcohol content is not required for this product.',
      expected: null,
      found: label.alcoholContentText,
      citation,
    };
  }

  if (found == null) {
    return {
      id,
      title,
      verdict: required ? 'fail' : 'review',
      summary: required
        ? 'Required on the label, but no alcohol content was found.'
        : 'Not found on the label.',
      expected: expectedText,
      found: label.alcoholContentText,
      citation,
    };
  }

  const tolerance = abvToleranceFor(app.beverageClass, expected);
  const delta = Math.abs(found - expected);

  // Proof, when shown, must be exactly twice ABV. A label reading
  // "45% Alc./Vol. (86 Proof)" is internally inconsistent regardless of
  // whether the ABV matches the application.
  if (PROOF_IS_TWICE_ABV && label.proof != null) {
    const impliedAbv = label.proof / 2;
    if (Math.abs(impliedAbv - found) > 0.05) {
      return {
        id,
        title,
        verdict: 'fail',
        summary: `The label contradicts itself: ${found}% alcohol by volume should be ${(found * 2).toFixed(0)} proof, but the label says ${label.proof} proof.`,
        expected: expectedText,
        found: label.alcoholContentText,
        citation,
        detail: 'Proof must be exactly twice the alcohol by volume percentage.',
      };
    }
  }

  if (delta === 0) {
    return {
      id,
      title,
      verdict: 'pass',
      summary: 'Matches the application exactly.',
      expected: expectedText,
      found: label.alcoholContentText ?? `${found}%`,
      citation,
    };
  }

  if (delta <= tolerance) {
    return {
      id,
      title,
      verdict: 'pass',
      summary: `Within the permitted tolerance (differs by ${delta.toFixed(2)} percentage points).`,
      expected: expectedText,
      found: label.alcoholContentText ?? `${found}%`,
      citation,
      detail: `Tolerance applied: ±${tolerance} percentage points.`,
    };
  }

  return {
    id,
    title,
    verdict: 'fail',
    summary: `The label says ${found}% but the application says ${expected}% — a difference of ${delta.toFixed(2)} percentage points.`,
    expected: expectedText,
    found: label.alcoholContentText ?? `${found}%`,
    citation,
    detail: `Exceeds the permitted tolerance of ±${tolerance} percentage points.`,
  };
}

/**
 * Net contents. Two questions again: does it agree with the application, and is
 * the size an authorized standard of fill for this beverage class?
 */
export function checkNetContents(app: ApplicationRecord, label: LabelExtraction): CheckResult {
  const id = 'net_contents';
  const title = 'Net contents';
  const citation = CITATIONS[id] ?? '';
  const required = isRequired(app, id);

  const expected = app.netContentsMl;
  const found = label.netContentsMl;

  if (found == null) {
    return {
      id,
      title,
      verdict: required ? 'fail' : 'review',
      summary: 'Required on the label, but no net contents statement was found.',
      expected: expected != null ? formatMl(expected) : null,
      found: label.netContentsText,
      citation,
    };
  }

  // Volume equality with a small tolerance for unit-conversion rounding
  // (a label in fluid ounces will never land exactly on a metric value).
  if (expected != null && Math.abs(found - expected) > Math.max(1, expected * 0.005)) {
    return {
      id,
      title,
      verdict: 'fail',
      summary: `The label says ${formatMl(found)} but the application says ${formatMl(expected)}.`,
      expected: formatMl(expected),
      found: label.netContentsText ?? formatMl(found),
      citation,
    };
  }

  const authorized = authorizedFillsFor(app.beverageClass);
  if (authorized) {
    const isStandard = authorized.some((size) => Math.abs(size - found) <= Math.max(1, size * 0.005));
    if (!isStandard) {
      return {
        id,
        title,
        verdict: 'fail',
        summary: `${formatMl(found)} is not an authorized container size for this product type.`,
        expected: expected != null ? formatMl(expected) : null,
        found: label.netContentsText ?? formatMl(found),
        citation,
        detail: `Nearest authorized sizes: ${nearestFills(authorized, found).map(formatMl).join(', ')}.`,
      };
    }
  }

  return {
    id,
    title,
    verdict: 'pass',
    summary:
      authorized == null
        ? 'Matches the application. This product type has no federal standards of fill.'
        : 'Matches the application and is an authorized container size.',
    expected: expected != null ? formatMl(expected) : null,
    found: label.netContentsText ?? formatMl(found),
    citation,
  };
}

function nearestFills(fills: readonly number[], target: number, count = 2): number[] {
  return [...fills].sort((a, b) => Math.abs(a - target) - Math.abs(b - target)).slice(0, count);
}

/**
 * The government health warning.
 *
 * This is the check that has to be pedantic, and it is deliberately NOT
 * delegated to the model. The model transcribes; this function decides. The
 * required text is a fixed quotation from 27 CFR 16.21, so the correct
 * implementation is string equality plus a diff — not a judgement call.
 *
 * Junior agent Jenny Park caught a submission that used "Government Warning"
 * in title case instead of all capitals. That is a rejection, and a language
 * model asked "is this warning correct?" will frequently say yes, because
 * semantically it is identical. Only the deterministic path catches it reliably.
 */
export function checkGovernmentWarning(
  _app: ApplicationRecord,
  label: LabelExtraction,
): CheckResult {
  const id = 'government_warning';
  const title = 'Government health warning';
  const citation = CITATIONS[id] ?? '';

  if (!label.governmentWarningText) {
    return {
      id,
      title,
      verdict: 'fail',
      summary: 'No government health warning was found on the label. This is mandatory on every alcohol beverage label.',
      expected: GOVERNMENT_WARNING_TEXT,
      found: null,
      citation,
    };
  }

  const actual = normalizeWhitespaceAndPunctuation(label.governmentWarningText);
  const expected = normalizeWhitespaceAndPunctuation(GOVERNMENT_WARNING_TEXT);

  // Findings are split by how reliably they can be established from a
  // photograph, and that split decides whether they reject a label outright.
  //
  //   TEXTUAL properties — the wording, and whether the prefix is capitalised —
  //   are read off the transcription itself. A photo either shows
  //   "GOVERNMENT WARNING:" or it shows "Government Warning:". These are
  //   decided here, and they fail the label.
  //
  //   VISUAL properties — font weight, and whether the block is set apart —
  //   are judgements about rendering, and a photograph of a curved glass
  //   bottle under uneven light is a poor instrument for them. These are
  //   raised for an agent to confirm, and they do not reject a label.
  //
  // Found on a real Taylor Cream Sherry back label: correct wording, correct
  // capitalisation, and the model reported the prefix as not bold on a curved,
  // wrinkled, angled photo. Rejecting on that would have been wrong, and the
  // kind of wrong that teaches agents to ignore the tool.
  const violations: string[] = [];
  const toConfirm: string[] = [];

  // Capitalization is compared against the transcription before case folding,
  // because case is exactly what is at issue here.
  const prefixOnLabel = actual.slice(0, WARNING_PREFIX.length);
  const prefixIsAllCaps =
    label.warningPrefixIsAllCaps ?? (prefixOnLabel === WARNING_PREFIX);
  if (!prefixIsAllCaps) {
    violations.push('"GOVERNMENT WARNING:" is not in all capital letters');
  }

  if (label.warningPrefixAppearsBold === false) {
    toConfirm.push('"GOVERNMENT WARNING:" may not be in bold type');
  }

  if (label.warningAppearsSeparate === false) {
    toConfirm.push('the warning may not be set apart from the other label text');
  }

  // Wording is compared case-INSENSITIVELY; capitalisation is enforced
  // separately, and only where the regulation actually demands it.
  //
  // 27 CFR 16.21 fixes the WORDS of the statement. 16.22 requires the words
  // "GOVERNMENT WARNING" to appear in capital letters and bold. It does not
  // require the remainder to be mixed case — and a great many real labels set
  // the entire statement in capitals, which is fully compliant.
  //
  // Comparing the whole string case-sensitively rejected every one of those.
  // Found by running a real Taylor Cream Sherry back label through the tool.
  const wordingMatches = actual.toLowerCase() === expected.toLowerCase();
  if (!wordingMatches) {
    violations.push('the wording does not match the required statement');
  }

  if (violations.length > 0) {
    return {
      id,
      title,
      verdict: 'fail',
      summary: `The warning is not acceptable: ${joinList(violations)}.`,
      expected: GOVERNMENT_WARNING_TEXT,
      found: label.governmentWarningText,
      citation,
      ...(wordingMatches ? {} : { diff: diffWords(expected, actual) }),
      detail: wordingMatches
        ? 'The wording is correct; the capitalization is not.'
        : 'Struck-through text is required but missing. Highlighted text appears on the label but should not.',
    };
  }

  if (toConfirm.length > 0) {
    // How much weight the typography reading deserves depends on whether the
    // photograph could support it.
    //
    // On a clean, flat, well-lit scan, "this is not bold" is a real signal and
    // belongs in the verdict. On a curved, dim, wrinkled bottle it is a guess,
    // and letting a guess drive the verdict means the tool cries wolf on every
    // field photograph — which is how agents learn to ignore it.
    //
    // The tool already knows which situation it is in: it flagged the glare and
    // the curvature itself. This just uses that.
    const reliable = imageSupportsTypographyJudgement(label);

    return {
      id,
      title,
      verdict: 'review',
      summary: reliable
        ? `The wording and capitalization are correct, but ${joinList(toConfirm)}. Check the label yourself.`
        : `The wording and capitalization are correct. ${capitalize(joinList(toConfirm))}, but the photograph is not clear enough to tell — confirm against the physical label.`,
      expected: GOVERNMENT_WARNING_TEXT,
      found: label.governmentWarningText,
      citation,
      detail: reliable
        ? 'Font weight and layout are judgements about rendering, so this is raised for you ' +
          'to confirm rather than treated as a violation.'
        : 'This image was flagged as imperfect, so the reading is not reliable enough to ' +
          'count either way.',
      // An unreliable reading is reported but does not drive the verdict, for
      // the same reason warning type size does not.
      ...(reliable ? {} : { requiresAgentConfirmation: true }),
    };
  }

  return {
    id,
    title,
    verdict: 'pass',
    summary: 'The warning matches the required text and is correctly formatted.',
    expected: GOVERNMENT_WARNING_TEXT,
    found: label.governmentWarningText,
    citation,
  };
}

/**
 * Warning legibility (27 CFR 16.22).
 *
 * HONEST LIMITATION: the regulation specifies a minimum character height in
 * millimetres, which depends on the physical size of the container. That cannot
 * be measured from a photograph without a known scale reference. This check
 * therefore never returns "pass" as a determination — it returns a proportional
 * observation and defers to the agent. Pretending to measure millimetres from
 * an image would be the single most dangerous thing this tool could do.
 */
export function checkWarningLegibility(label: LabelExtraction): CheckResult {
  const id = 'warning_legibility';
  const title = 'Warning type size';
  const citation = CITATIONS.government_warning ?? '';
  const detail =
    'Type size is specified in millimetres and depends on container volume. ' +
    'It cannot be measured from an image without a physical reference, so this ' +
    'is always confirmed by an agent.';

  if (label.governmentWarningText == null) {
    return {
      id,
      title,
      verdict: 'not_applicable',
      summary: 'No warning statement to measure.',
      expected: null,
      found: null,
      citation,
      detail,
    };
  }

  const relative = label.warningRelativeSize;
  const found =
    relative != null
      ? `About ${(relative * 100).toFixed(0)}% the height of the largest text on the label`
      : null;

  if (relative != null && relative < 0.25) {
    return {
      id,
      title,
      verdict: 'review',
      summary:
        'The warning looks small relative to the rest of the label. Measure the type size against the container before approving.',
      expected: null,
      found,
      citation,
      detail,
      requiresAgentConfirmation: true,
    };
  }

  return {
    id,
    title,
    verdict: 'review',
    summary: 'Confirm the printed type size meets the minimum for this container.',
    expected: null,
    found,
    citation,
    detail,
    requiresAgentConfirmation: true,
  };
}

/**
 * Image quality gate.
 *
 * Jenny Park: "if an agent can't read the label they just reject it and ask for
 * a better image." The tool must do the same thing rather than guessing — a
 * confident answer from an illegible photo is worse than no answer.
 */
export function checkImageQuality(label: LabelExtraction): CheckResult {
  const id = 'image_quality';
  const title = 'Image quality';
  const citation = CITATIONS[id] ?? '';

  if (!label.imageLegible) {
    return {
      id,
      title,
      verdict: 'fail',
      summary: 'The image is not clear enough to verify this label. Request a better photograph.',
      expected: null,
      found: label.imageQualityIssues.join('; ') || 'Not legible',
      citation,
    };
  }

  if (label.imageQualityIssues.length > 0 || label.transcriptionConfidence < 0.7) {
    return {
      id,
      title,
      verdict: 'review',
      summary: 'The image is readable but imperfect. Check the findings against the image yourself.',
      expected: null,
      found:
        label.imageQualityIssues.join('; ') ||
        `Low reading confidence (${Math.round(label.transcriptionConfidence * 100)}%)`,
      citation,
    };
  }

  return {
    id,
    title,
    verdict: 'pass',
    summary: 'The image is clear and fully readable.',
    expected: null,
    found: null,
    citation,
  };
}

/**
 * Whether the image is good enough for a judgement about font weight or layout
 * to mean anything.
 *
 * Deliberately strict. Any noted defect — glare, curvature, angle, poor light —
 * disqualifies the reading, because all of them distort exactly the stroke
 * weight and spacing being assessed.
 */
function imageSupportsTypographyJudgement(label: LabelExtraction): boolean {
  return (
    label.imageLegible &&
    label.imageQualityIssues.length === 0 &&
    label.transcriptionConfidence >= 0.85
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function joinList(items: string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}
