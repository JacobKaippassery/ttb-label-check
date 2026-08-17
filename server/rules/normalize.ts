/**
 * Text normalization for comparing label text against application text.
 *
 * Dave Morrison, 28-year compliance agent, described the problem exactly:
 * a label reading "STONE'S THROW" against an application reading "Stone's Throw"
 * is technically a mismatch and obviously the same product. A tool that flags
 * that as a violation gets switched off within a week.
 *
 * The approach: normalize aggressively for the COMPARISON, but always show the
 * agent the original strings so they can see what was actually printed. We never
 * silently rewrite evidence — we only relax the equality test.
 */

/** Curly quotes, primes, and the rest of the apostrophe zoo → ASCII apostrophe. */
const APOSTROPHES = /[‘’ʼ′`´]/g;
/** Curly double quotes → ASCII double quote. */
const QUOTES = /[“”″]/g;
/** En/em dashes and friends → hyphen. */
const DASHES = /[‐-―−]/g;

/** Common on-label abbreviations mapped to a canonical form. */
const ABBREVIATIONS: ReadonlyArray<[RegExp, string]> = [
  [/\band\b/g, '&'],
  [/\bdist\b/g, 'distillery'],
  [/\bdistilling\b/g, 'distillery'],
  [/\bdistillers\b/g, 'distillery'],
  [/\bbros\b/g, 'brothers'],
  [/\bst\b/g, 'street'],
  [/\bave\b/g, 'avenue'],
  [/\brd\b/g, 'road'],
  [/\bmt\b/g, 'mount'],
  [/\bft\b/g, 'fort'],
];

/**
 * US state names collapsed to their postal code.
 *
 * Bottler addresses are written both ways constantly — "Louisville, Kentucky"
 * on the label and "Louisville, KY" in the application, or the reverse. Without
 * this, every such pair lands just under the match threshold and generates
 * agent work for a difference that carries no regulatory meaning.
 *
 * Full name → code rather than code → full name, because the codes are
 * unambiguous targets while several full names are multi-word.
 */
const US_STATES: ReadonlyArray<[RegExp, string]> = (
  [
    ['alabama', 'al'], ['alaska', 'ak'], ['arizona', 'az'], ['arkansas', 'ar'],
    ['california', 'ca'], ['colorado', 'co'], ['connecticut', 'ct'], ['delaware', 'de'],
    ['district of columbia', 'dc'], ['florida', 'fl'], ['georgia', 'ga'], ['hawaii', 'hi'],
    ['idaho', 'id'], ['illinois', 'il'], ['indiana', 'in'], ['iowa', 'ia'],
    ['kansas', 'ks'], ['kentucky', 'ky'], ['louisiana', 'la'], ['maine', 'me'],
    ['maryland', 'md'], ['massachusetts', 'ma'], ['michigan', 'mi'], ['minnesota', 'mn'],
    ['mississippi', 'ms'], ['missouri', 'mo'], ['montana', 'mt'], ['nebraska', 'ne'],
    ['nevada', 'nv'], ['new hampshire', 'nh'], ['new jersey', 'nj'], ['new mexico', 'nm'],
    ['new york', 'ny'], ['north carolina', 'nc'], ['north dakota', 'nd'], ['ohio', 'oh'],
    ['oklahoma', 'ok'], ['oregon', 'or'], ['pennsylvania', 'pa'], ['rhode island', 'ri'],
    ['south carolina', 'sc'], ['south dakota', 'sd'], ['tennessee', 'tn'], ['texas', 'tx'],
    ['utah', 'ut'], ['vermont', 'vt'], ['virginia', 'va'], ['washington', 'wa'],
    ['west virginia', 'wv'], ['wisconsin', 'wi'], ['wyoming', 'wy'],
  ] as const
)
  // Longest first, so "west virginia" is matched before "virginia".
  .slice()
  .sort((a, b) => b[0].length - a[0].length)
  .map(([name, code]) => [new RegExp(`\\b${name}\\b`, 'g'), code]);

/**
 * Corporate suffixes carry no distinguishing information when comparing a
 * bottler on a label against the same bottler in an application, so they are
 * dropped rather than expanded.
 *
 * "co" is genuinely ambiguous — "Distilling Co." (company) and "Denver, CO"
 * (Colorado) are both common in bottler addresses, and position does not
 * reliably separate them, since company names ending in "Co." are ordinary.
 *
 * It is dropped anyway, because dropping is symmetric and therefore safe for
 * *matching*: both sides lose the token, so equal inputs stay equal. Colorado
 * written either way ("CO" or "Colorado", which normalizes to "co" first) also
 * still converges. The only cost is slightly reduced sensitivity in the rare
 * case where one side says Colorado and the other says a different state —
 * and that case still surfaces as a near-miss for an agent to look at, because
 * the other state's code survives.
 */
const CORPORATE_SUFFIXES = new Set([
  'co',
  'company',
  'corporation',
  'corp',
  'incorporated',
  'inc',
  'limited',
  'ltd',
  'llc',
  'lp',
  'plc',
]);

/**
 * Light normalization: safe for display and for exact-text comparison where the
 * regulation cares about wording but not about typographic accidents introduced
 * by OCR (smart quotes, non-breaking spaces, line-wrap hyphenation).
 */
export function normalizeWhitespaceAndPunctuation(input: string): string {
  return input
    .replace(APOSTROPHES, "'")
    .replace(QUOTES, '"')
    .replace(DASHES, '-')
    .replace(/ /g, ' ')
    // A hyphen at a line break is a typesetting artifact, not part of the word.
    .replace(/-\s*\n\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Aggressive normalization for name matching: case-folded, punctuation
 * stripped, abbreviations expanded, articles dropped.
 */
export function normalizeForMatch(input: string): string {
  let s = normalizeWhitespaceAndPunctuation(input).toLowerCase();

  // Strip possessives before dropping punctuation, so "stone's" and "stones"
  // collapse to the same token rather than "stones" vs "stone s".
  s = s.replace(/'s\b/g, 's').replace(/s'\b/g, 's');

  for (const [pattern, replacement] of ABBREVIATIONS) {
    s = s.replace(pattern, replacement);
  }

  s = s
    .replace(/[.,/#!$%^*;:{}=\-_`~()"']/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();

  // State names collapse to postal codes after punctuation is gone, so that
  // "Louisville, Kentucky" and "Louisville KY" converge.
  for (const [pattern, code] of US_STATES) {
    s = s.replace(pattern, code);
  }

  s = s
    .split(' ')
    .filter((token) => token !== '' && !CORPORATE_SUFFIXES.has(token))
    .join(' ');

  // Leading articles are noise for brand comparison ("The Macallan" = "Macallan").
  s = s.replace(/^(the|a|an)\s+/, '');

  return s.trim();
}

/**
 * Strips the statutory lead-in that precedes a name-and-address statement.
 *
 * Labels print "DISTILLED AND BOTTLED BY / Old Tom Distillery, Bardstown, KY".
 * A faithful transcription includes that lead-in, because it genuinely is on
 * the label — but the application records only the name and address, so
 * comparing the two raw strings fails on essentially every real spirits label.
 *
 * This is handled here rather than by asking the model to omit the phrase. The
 * transcription should stay literal (it is the evidence an agent reviews); it
 * is the *comparison* that needs to know the lead-in is framing rather than
 * part of the name.
 *
 * Covers the forms at 27 CFR 5.66 / 4.35 / 7.66: bottled, distilled, produced,
 * blended, packed, imported, manufactured, vinted, prepared, and the compound
 * forms such as "produced and bottled by".
 */
const BOTTLER_LEAD_IN =
  /^\s*(?:distilled|produced|manufactured|blended|packed|bottled|imported|vinted|prepared|brewed)(?:\s*(?:and|&)\s*(?:bottled|packed|blended|canned))?\s+(?:by|for)\b[\s:,.\-–—]*/i;

export function stripBottlerLeadIn(text: string): string {
  return normalizeWhitespaceAndPunctuation(text).replace(BOTTLER_LEAD_IN, '').trim();
}

/** Tokens for order-insensitive comparison of multi-word names and addresses. */
export function tokenize(input: string): string[] {
  const normalized = normalizeForMatch(input);
  return normalized ? normalized.split(' ') : [];
}

/**
 * Parses an alcohol content string off a label into ABV and proof.
 *
 * Handles the shapes that actually appear in the wild:
 *   "45% Alc./Vol. (90 Proof)"   "ALC. 40% BY VOL."   "13.5% alc/vol"
 *   "90 PROOF"                   "40% ABV"            "ALC 5,2% VOL" (comma decimal)
 */
export function parseAlcoholContent(text: string): { abv: number | null; proof: number | null } {
  const s = normalizeWhitespaceAndPunctuation(text).toLowerCase().replace(/,(\d)/g, '.$1');

  let abv: number | null = null;
  let proof: number | null = null;

  // A percentage anywhere in the string is the ABV. Take the first one:
  // "45% Alc./Vol. (90 Proof)" must not read 90 as the percentage.
  const pct = s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct?.[1]) abv = Number.parseFloat(pct[1]);

  // "alc. 40 by vol" — percentage sign omitted, number bounded by alc…vol.
  if (abv === null) {
    const bare = s.match(/alc[a-z.\s]*?(\d+(?:\.\d+)?)\s*(?:by\s*)?vol/);
    if (bare?.[1]) abv = Number.parseFloat(bare[1]);
  }

  const proofMatch = s.match(/(\d+(?:\.\d+)?)\s*proof/);
  if (proofMatch?.[1]) proof = Number.parseFloat(proofMatch[1]);

  return { abv, proof };
}

/**
 * Parses a net contents string into millilitres.
 * Handles "750 mL", "1.75 L", "1 LITER", "12 FL OZ", "25.4 fl. oz.".
 */
export function parseNetContents(text: string): number | null {
  const s = normalizeWhitespaceAndPunctuation(text).toLowerCase().replace(/,(\d{3})/g, '$1');

  const ml = s.match(/(\d+(?:\.\d+)?)\s*(?:ml|milliliters?|millilitres?)\b/);
  if (ml?.[1]) return Number.parseFloat(ml[1]);

  const litres = s.match(/(\d+(?:\.\d+)?)\s*(?:l|lt|ltr|liters?|litres?)\b/);
  if (litres?.[1]) return Number.parseFloat(litres[1]) * 1000;

  // US fluid ounce = 29.5735295625 mL exactly.
  const flOz = s.match(/(\d+(?:\.\d+)?)\s*(?:fl\.?\s*oz|fluid\s*ounces?)\b/);
  if (flOz?.[1]) return Number.parseFloat(flOz[1]) * 29.5735295625;

  return null;
}
