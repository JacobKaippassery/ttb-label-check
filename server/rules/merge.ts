import type { LabelExtraction } from './types.ts';
import { similarity } from './similarity.ts';

/**
 * Combines the transcriptions of several panels of ONE label into a single
 * extraction, so the compliance checks run once against the whole submission.
 *
 * A real bottle carries its brand and class/type on the front and its net
 * contents, name and address, and government warning on the back. Checking each
 * photograph as though it were a complete label reports the front as missing a
 * government warning and missing net contents — both present, on the other
 * panel. That is a false rejection of a compliant product, produced entirely by
 * the tool's framing of the problem.
 *
 * Merge rules, and why:
 *
 *   - Scalar fields: the first panel that has one wins. A field is either
 *     printed on a panel or it is not; two panels rarely disagree, and when
 *     they do, the disagreement is itself the finding — see `conflicts`.
 *   - Warning fields move as a unit. `warningPrefixIsAllCaps` describes a
 *     specific warning on a specific panel, so taking it from a different panel
 *     than the warning text would attribute one panel's typography to another's
 *     words.
 *   - Image quality is pessimistic: legible only if every panel is legible,
 *     confidence is the lowest across panels, and issues accumulate. A
 *     submission is only as readable as its worst panel.
 */
export function mergeExtractions(panels: LabelExtraction[]): LabelExtraction {
  if (panels.length === 0) throw new Error('mergeExtractions requires at least one panel');
  if (panels.length === 1) return panels[0]!;

  const firstWith = <K extends keyof LabelExtraction>(key: K): LabelExtraction[K] => {
    for (const panel of panels) {
      const value = panel[key];
      if (value !== null && value !== undefined) return value;
    }
    return panels[0]![key];
  };

  // The panel carrying the warning also carries every judgement about it.
  const warningPanel = panels.find((p) => p.governmentWarningText != null) ?? panels[0]!;

  const notes = panels
    .map((p) => p.notes)
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '');

  const conflictNotes = conflicts(panels).map(
    (c) => `Panels disagree on ${c.field}: ${c.values.join(' / ')}.`,
  );

  const allNotes = [...notes, ...conflictNotes];

  return {
    brandName: firstWith('brandName'),
    classType: firstWith('classType'),
    alcoholContentText: firstWith('alcoholContentText'),
    alcoholContentAbv: firstWith('alcoholContentAbv'),
    proof: firstWith('proof'),
    netContentsText: firstWith('netContentsText'),
    netContentsMl: firstWith('netContentsMl'),
    bottlerNameAddress: firstWith('bottlerNameAddress'),
    countryOfOrigin: firstWith('countryOfOrigin'),

    governmentWarningText: warningPanel.governmentWarningText,
    warningPrefixIsAllCaps: warningPanel.warningPrefixIsAllCaps,
    warningPrefixAppearsBold: warningPanel.warningPrefixAppearsBold,
    warningAppearsSeparate: warningPanel.warningAppearsSeparate,
    warningRelativeSize: warningPanel.warningRelativeSize,

    imageLegible: panels.every((p) => p.imageLegible),
    imageQualityIssues: mergeQualityIssues(panels),
    transcriptionConfidence: Math.min(...panels.map((p) => p.transcriptionConfidence)),
    notes: allNotes.length > 0 ? allNotes.join(' ') : null,
  };
}

/**
 * An observation that only one panel was visible.
 *
 * Read against a single photograph this is a fair complaint. Read against a
 * submission that includes the other panel it is stale — the reader could not
 * see the back because it was a photo of the front, and the back was supplied
 * separately. Carrying it through told agents to go find something they had
 * already provided.
 */
const PANEL_COMPLETENESS_COMPLAINT =
  /\b(only|just)\b.{0,20}\b(front|back|one|single)\b.{0,20}\b(label|panel|side|visible)\b|\b(back|front|other|reverse)\b.{0,20}\b(label|panel|side)\b.{0,20}\bnot\b.{0,15}\b(visible|shown|included|photograph)/i;

/**
 * Combines the panels' image-quality observations into one readable list.
 *
 * Two panels of the same bottle produce overlapping complaints — "curved bottle
 * surface distorts edge text" and "curved bottle surface distorts text" are the
 * same finding written twice. Near-duplicates are collapsed so the agent reads
 * a short list of distinct problems rather than a wall of restatements.
 */
function mergeQualityIssues(panels: LabelExtraction[]): string[] {
  const multiPanel = panels.length > 1;
  const kept: string[] = [];

  for (const issue of panels.flatMap((p) => p.imageQualityIssues)) {
    const text = issue.trim();
    if (text === '') continue;
    if (multiPanel && PANEL_COMPLETENESS_COMPLAINT.test(text)) continue;

    const isDuplicate = kept.some((existing) => similarity(canonical(existing), canonical(text)) >= 0.8);
    if (!isDuplicate) kept.push(text);
  }

  return kept;
}

const canonical = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Fields where two panels both printed a value and the values differ.
 *
 * This is a genuine finding rather than a merge detail: a bottle whose front
 * says 18% and whose back says 17% has an internally inconsistent label, and an
 * agent needs to see that rather than have one value silently win.
 */
export function conflicts(
  panels: LabelExtraction[],
): Array<{ field: string; values: string[] }> {
  const comparable = [
    'brandName',
    'classType',
    'alcoholContentAbv',
    'netContentsMl',
  ] as const;

  const found: Array<{ field: string; values: string[] }> = [];

  for (const field of comparable) {
    const values = panels
      .map((p) => p[field])
      .filter((v): v is NonNullable<typeof v> => v !== null && v !== undefined)
      .map((v) => String(v));

    const distinct = [...new Set(values.map((v) => v.trim().toLowerCase()))];
    if (distinct.length > 1) {
      found.push({ field, values: [...new Set(values)] });
    }
  }

  return found;
}
