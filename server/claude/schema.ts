/**
 * JSON Schema for label extraction.
 *
 * Structured outputs constrain the model to this exact shape, so the server
 * never has to defend against a prose preamble, a markdown code fence, or a
 * renamed field. Note the constraints the API imposes: every object needs
 * `additionalProperties: false`, every property must be listed in `required`,
 * and numeric/string range constraints (minimum, maxLength, ...) are not
 * supported — so ranges are stated in the descriptions and validated in code.
 */

const nullable = (schema: Record<string, unknown>, description: string) => ({
  anyOf: [schema, { type: 'null' }],
  description,
});

export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'brandName',
    'classType',
    'alcoholContentText',
    'alcoholContentAbv',
    'proof',
    'netContentsText',
    'netContentsMl',
    'bottlerNameAddress',
    'countryOfOrigin',
    'governmentWarningText',
    'warningPrefixIsAllCaps',
    'warningPrefixAppearsBold',
    'warningAppearsSeparate',
    'warningRelativeSize',
    'imageLegible',
    'imageQualityIssues',
    'transcriptionConfidence',
    'notes',
  ],
  properties: {
    brandName: nullable(
      { type: 'string' },
      'The brand name exactly as printed, preserving its capitalization. Null if absent.',
    ),
    classType: nullable(
      { type: 'string' },
      'The class/type designation exactly as printed, e.g. "Kentucky Straight Bourbon Whiskey". Null if absent.',
    ),
    alcoholContentText: nullable(
      { type: 'string' },
      'The complete alcohol content statement exactly as printed, e.g. "45% Alc./Vol. (90 Proof)". Null if absent.',
    ),
    alcoholContentAbv: nullable(
      { type: 'number' },
      'Alcohol by volume as a number only, e.g. 45 for "45% Alc./Vol.". Null if not stated.',
    ),
    proof: nullable(
      { type: 'number' },
      'Proof as a number only, e.g. 90. Null if proof is not printed on the label.',
    ),
    netContentsText: nullable(
      { type: 'string' },
      'The net contents statement exactly as printed, e.g. "750 mL". Null if absent.',
    ),
    netContentsMl: nullable(
      { type: 'number' },
      'Net contents converted to millilitres, e.g. 750. Null if not stated.',
    ),
    bottlerNameAddress: nullable(
      { type: 'string' },
      'The bottler/producer name and address block as printed, with line breaks replaced by commas. Null if absent.',
    ),
    countryOfOrigin: nullable(
      { type: 'string' },
      'Country of origin if stated, e.g. "Product of Scotland". Null if absent.',
    ),
    governmentWarningText: nullable(
      { type: 'string' },
      'The government health warning transcribed CHARACTER FOR CHARACTER exactly as printed, preserving capitalization and punctuation precisely. Do not correct it. Null if no warning appears.',
    ),
    warningPrefixIsAllCaps: nullable(
      { type: 'boolean' },
      'True only if the words "GOVERNMENT WARNING" are printed in all capital letters. False if any other capitalization is used, such as "Government Warning".',
    ),
    warningPrefixAppearsBold: nullable(
      { type: 'boolean' },
      'True if "GOVERNMENT WARNING" appears in bold or noticeably heavier type than the warning body text. Null if you genuinely cannot tell.',
    ),
    warningAppearsSeparate: nullable(
      { type: 'boolean' },
      'True if the warning is visually set apart from other label text. Null if you cannot tell.',
    ),
    warningRelativeSize: nullable(
      { type: 'number' },
      'Character height of the warning body text divided by the character height of the largest text on the label. A value between 0 and 1. Null if you cannot estimate it.',
    ),
    imageLegible: {
      type: 'boolean',
      description:
        'False if the image is too blurry, dark, glared, or angled to read the label reliably. Be strict: if you would ask for a better photo, this is false.',
    },
    imageQualityIssues: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Short plain-language descriptions of image problems, e.g. "glare across the lower third", "photographed at a steep angle". Empty array if the image is clean.',
    },
    transcriptionConfidence: {
      type: 'number',
      description:
        'Your confidence that you transcribed the label correctly, from 0 to 1. Lower this when text is small, blurred, or partially obscured.',
    },
    notes: nullable(
      { type: 'string' },
      'Anything an agent should know that does not fit the fields above. Null if nothing.',
    ),
  },
} as const;

/**
 * The extraction prompt.
 *
 * Deliberately scoped to TRANSCRIPTION ONLY. The model is never asked whether
 * the label is compliant, whether the warning is correct, or whether anything
 * matches the application — those are decided by server/rules from this output.
 *
 * That boundary is the core design decision of this tool. A model asked "is
 * this warning correct?" will say yes to a semantically identical but
 * non-compliant statement, because it reads for meaning. TTB needs it read for
 * characters.
 */
export const EXTRACTION_SYSTEM_PROMPT = `You are a transcription tool for alcohol beverage label images submitted to the TTB.

Your only job is to report what is physically printed on the label. You are not evaluating compliance and you are not comparing anything to an application.

Rules:
1. Transcribe text exactly as printed. Preserve capitalization, punctuation, and spacing precisely. Never correct spelling, grammar, capitalization, or wording, even when you are certain it is a mistake — a mistake is exactly what a reviewer needs to see.
2. The government health warning must be transcribed character for character. If the label says "Government Warning" in title case, report it in title case. If a word is missing or altered, report it missing or altered. Do not reproduce the standard warning from memory.
3. If something is not on the label, report null. Never infer, complete, or fill in a plausible value.
4. If the image is too poor to read a field reliably, say so through imageLegible, imageQualityIssues, and transcriptionConfidence rather than guessing.
5. Labels are often photographed at an angle, under glare, or on a curved bottle. Read them anyway when you reasonably can, and note the condition.

Report only what you can see.`;
