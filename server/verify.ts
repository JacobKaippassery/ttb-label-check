import { prepareImage } from './image/prepare.ts';
import { extractLabel, ExtractionError } from './claude/extract.ts';
import { runChecks, rollup } from './rules/index.ts';
import { mergeExtractions, conflicts } from './rules/merge.ts';
import { config } from './config.ts';
import type { ApplicationRecord, CheckResult, VerificationResult } from './rules/types.ts';

/**
 * True when the government warning failed specifically because the WORDING did
 * not match, as opposed to a formatting failure (not capitalised, not bold).
 *
 * Only wording is re-read. Capitalisation and weight are stable visual
 * judgements, and re-reading them would just spend a second call to get the
 * same answer — whereas a single mis-read word is exactly the transient error
 * a second reading catches.
 */
const FIELD_LABELS: Record<string, string> = {
  brandName: 'brand name',
  classType: 'class/type',
  alcoholContentAbv: 'alcohol content',
  netContentsMl: 'net contents',
};

const friendlyField = (field: string) => FIELD_LABELS[field] ?? field;

function listFields(items: Array<{ field: string }>): string {
  const names = items.map((i) => friendlyField(i.field));
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function wordingMismatch(checks: CheckResult[]): boolean {
  const warning = checks.find((c) => c.id === 'government_warning');
  return warning?.verdict === 'fail' && Array.isArray(warning.diff) && warning.diff.length > 0;
}

export interface VerifyOutcome extends VerificationResult {
  thumbnailDataUrl: string;
  imageTransformations: string[];
  usage: { inputTokens: number; outputTokens: number };
  /** True when the transcription came from a stored fixture, not a live call. */
  isDemo: boolean;
  /** Extra readings taken to settle a disputed warning. Usually 0. */
  confirmationReads: number;
  /** Every panel that made up this submission, in upload order. */
  panels: Array<{ fileName: string; thumbnailDataUrl: string }>;
}

/**
 * The full pipeline for one label: prepare the image, transcribe it with
 * Claude, then decide compliance in deterministic code.
 *
 * The split matters. Everything after `extractLabel` is pure, synchronous, and
 * testable without a network — so a disputed determination can be reproduced
 * exactly from the stored transcription, months later, without re-running a
 * model that may have changed.
 */
export interface Panel {
  buffer: Buffer;
  fileName: string;
}

export async function verifyLabel(
  application: ApplicationRecord,
  panels: Panel[],
): Promise<VerifyOutcome> {
  if (panels.length === 0) throw new Error('verifyLabel requires at least one panel');
  const totalStart = performance.now();

  // Panels of one label are read concurrently — a front and a back are
  // independent reads, so doing them in sequence would double the wait for no
  // reason.
  const prepared = await Promise.all(panels.map((p) => prepareImage(p.buffer)));
  const reads = await Promise.all(
    prepared.map((image, index) => extractLabel(image, panels[index]!.fileName)),
  );

  const image = prepared[0]!;
  const fileName = panels[0]!.fileName;
  const extraction = mergeExtractions(reads.map((r) => r.extraction));
  const model = reads[0]!.model;
  const isDemo = reads[0]!.isDemo;
  const extractionMs = Math.max(...reads.map((r) => r.elapsedMs));
  const usage = {
    inputTokens: reads.reduce((sum, r) => sum + r.usage.inputTokens, 0),
    outputTokens: reads.reduce((sum, r) => sum + r.usage.outputTokens, 0),
  };

  const rulesStart = performance.now();
  let { checks, overall, headline, needsBetterImage } = runChecks(application, extraction);
  let rulesMs = performance.now() - rulesStart;
  let confirmations = 0;

  // ---- Do these panels actually belong to the same bottle? ----
  //
  // Grouping is asserted by whoever uploaded the images, and mis-grouping is an
  // easy mistake — a third photo from the next bottle along gets swept into the
  // selection. Merging panels from two products would silently produce a
  // determination about a label that does not exist.
  //
  // The panels themselves give this away: two front labels reading different
  // brands cannot be one bottle. It is reported as review rather than a
  // violation, because the likely fault is the grouping, not the label.
  const disagreements = panels.length > 1 ? conflicts(reads.map((r) => r.extraction)) : [];
  if (disagreements.length > 0) {
    checks = [
      {
        id: 'panel_agreement',
        title: 'Do these images show the same bottle?',
        verdict: 'review',
        summary:
          `These images disagree on ${listFields(disagreements)}, which usually means ` +
          'they are photographs of different products. Check the images and remove any ' +
          'that do not belong before relying on this result.',
        expected: null,
        found: disagreements
          .map((d) => `${friendlyField(d.field)}: ${d.values.join(' vs ')}`)
          .join('; '),
        citation: 'Internal — panels of one label must describe one product',
      },
      ...checks,
    ];
    ({ overall, headline } = rollup(checks));
  }

  // ---- Second reading on a disputed warning ----
  //
  // Transcription is very stable but not perfectly so: in benchmarking, the
  // government warning came back character-identical on 9 of 9 repeat reads,
  // and a single earlier run mis-read one word on a label whose warning was
  // actually correct.
  //
  // That rare case is the most expensive error this tool can make. An agent
  // sent to look at three warnings that turn out to be fine stops looking
  // carefully at the fourth, and the whole tool loses its value.
  //
  // So a wording mismatch is not trusted on one reading. The label is read a
  // second time, and:
  //   - both readings disagree with the required text  → fail, as before
  //   - the readings disagree with each other          → review, not fail
  //
  // Deliberately NOT "prefer whichever reading passes": when two readings
  // disagree, the honest answer is that the tool is unsure, and an unsure
  // answer belongs with a human rather than being resolved in either direction.
  //
  // This costs a second API call only on the mismatch path, so it does not
  // affect latency for labels that are fine — which is nearly all of them.
  if (!isDemo && config.confirmDisputedWarning && wordingMismatch(checks)) {
    // Re-read only the panel that actually carries the warning.
    const warningIndex = Math.max(
      0,
      reads.findIndex((r) => r.extraction.governmentWarningText != null),
    );
    const second = await extractLabel(
      prepared[warningIndex]!,
      panels[warningIndex]!.fileName,
    );
    confirmations = 1;

    const secondStart = performance.now();
    const merged = mergeExtractions(
      reads.map((r, i) => (i === warningIndex ? second.extraction : r.extraction)),
    );
    const secondPass = runChecks(application, merged);
    rulesMs += performance.now() - secondStart;

    if (!wordingMismatch(secondPass.checks)) {
      // The two readings disagree with each other. Neither is trusted.
      checks = checks.map((check) =>
        check.id === 'government_warning'
          ? {
              ...check,
              verdict: 'review' as const,
              summary:
                'The warning could not be read consistently. One reading matched the ' +
                'required text and one did not — compare the label against the required ' +
                'text yourself.',
              detail:
                'Two independent readings of this label disagreed, so neither was ' +
                'treated as authoritative.',
            }
          : check,
      );
      ({ overall, headline } = rollup(checks));
    }
  }

  return {
    applicationId: application.applicationId,
    overall,
    headline,
    checks,
    extraction,
    model,
    needsBetterImage,
    isDemo,
    thumbnailDataUrl: image.thumbnailDataUrl,
    panels: prepared.map((p, i) => ({
      fileName: panels[i]!.fileName,
      thumbnailDataUrl: p.thumbnailDataUrl,
    })),
    imageTransformations: prepared.flatMap((p) => p.transformations),
    usage,
    confirmationReads: confirmations,
    timings: {
      extractionMs: Math.round(extractionMs),
      rulesMs: Math.round(rulesMs * 100) / 100,
      totalMs: Math.round(performance.now() - totalStart),
    },
  };
}

export { ExtractionError };
