import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';
import { EXTRACTION_SCHEMA, EXTRACTION_SYSTEM_PROMPT } from './schema.ts';
import { fixtureFor } from './fixtures.ts';
import { parseAlcoholContent, parseNetContents } from '../rules/normalize.ts';
import type { LabelExtraction } from '../rules/types.ts';
import type { PreparedImage } from '../image/prepare.ts';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.apiKey });
  return client;
}

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly code: 'no_api_key' | 'refused' | 'truncated' | 'invalid_json' | 'api_error',
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export interface ExtractionOutcome {
  extraction: LabelExtraction;
  model: string;
  elapsedMs: number;
  usage: { inputTokens: number; outputTokens: number };
  /** True when this came from a stored fixture rather than a live API call. */
  isDemo: boolean;
}

/**
 * Sends one prepared label image to Claude and returns a structured
 * transcription. Makes exactly one API call in the normal case.
 *
 * No streaming: the response is a small fixed-shape JSON object, so streaming
 * would add complexity without improving the number that matters here, which is
 * time to a complete result.
 */
export async function extractLabel(
  image: PreparedImage,
  fileName = '',
): Promise<ExtractionOutcome> {
  if (config.demoMode) return demoExtraction(fileName);

  if (!config.hasApiKey) {
    throw new ExtractionError(
      'No ANTHROPIC_API_KEY is set. Copy .env.example to .env and add your key, ' +
        'or set DEMO_MODE=true to run against the stored sample transcriptions.',
      'no_api_key',
    );
  }

  const started = performance.now();
  let response = await callModel(config.model, image);

  // Safety classifiers can decline a request outright, which arrives as a
  // successful HTTP 200 with stop_reason "refusal" and no usable content.
  // Retry once on a different model rather than failing the label — but only
  // if it genuinely is a different model. Retrying the same one just burns a
  // second call to get the same answer.
  if (response.stop_reason === 'refusal') {
    if (config.fallbackModel === config.model) {
      throw new ExtractionError(
        `The request was declined by content safeguards on ${config.model}, and no ` +
          'distinct fallback model is configured. Review this label manually, or set ' +
          'ANTHROPIC_FALLBACK_MODEL to a different model.',
        'refused',
      );
    }
    response = await callModel(config.fallbackModel, image);
    if (response.stop_reason === 'refusal') {
      throw new ExtractionError(
        'The request was declined by content safeguards on both models. Review this label manually.',
        'refused',
      );
    }
  }

  if (response.stop_reason === 'max_tokens') {
    throw new ExtractionError(
      'The response was cut off before the transcription was complete. Retry, or raise max_tokens.',
      'truncated',
    );
  }

  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') {
    throw new ExtractionError('The model returned no text content.', 'invalid_json');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text.text);
  } catch {
    throw new ExtractionError('The model returned text that was not valid JSON.', 'invalid_json');
  }

  return {
    extraction: coerceExtraction(raw),
    model: response.model,
    elapsedMs: performance.now() - started,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    isDemo: false,
  };
}

/**
 * Returns a stored transcription. The small delay is deliberate: it keeps the
 * batch progress bar and streaming results observable, so the demo exercises
 * the same UI behaviour a live run does rather than completing instantly.
 */
async function demoExtraction(fileName: string): Promise<ExtractionOutcome> {
  const started = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 350 + Math.random() * 500));

  return {
    extraction: fixtureFor(fileName),
    model: 'demo (stored transcription)',
    elapsedMs: performance.now() - started,
    usage: { inputTokens: 0, outputTokens: 0 },
    isDemo: true,
  };
}

/**
 * Models that accept `output_config.effort` and the adaptive/disabled shapes of
 * `thinking`.
 *
 * Older models reject these outright — Haiku 4.5 returns a 400 reading "This
 * model does not support the effort parameter". Since the model is
 * operator-configurable via ANTHROPIC_MODEL, the request has to adapt rather
 * than assume. Anything unrecognized is treated conservatively: both parameters
 * are omitted, which every model accepts.
 *
 * This list is the one place to update when adding support for a new model.
 */
const SUPPORTS_EFFORT_AND_THINKING = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
];

function supportsEffortAndThinking(model: string): boolean {
  return SUPPORTS_EFFORT_AND_THINKING.some((prefix) => model.startsWith(prefix));
}

async function callModel(model: string, image: PreparedImage) {
  const modern = supportsEffortAndThinking(model);

  try {
    return await getClient().messages.create({
      model,
      max_tokens: 8192,
      system: EXTRACTION_SYSTEM_PROMPT,
      // Thinking is on by default on current models when omitted, so it is
      // sent explicitly rather than left to the default.
      ...(modern
        ? {
            thinking:
              config.thinking === 'adaptive'
                ? ({ type: 'adaptive' } as const)
                : ({ type: 'disabled' } as const),
          }
        : {}),
      output_config: {
        ...(modern
          ? { effort: config.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
          : {}),
        format: { type: 'json_schema', schema: EXTRACTION_SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
            },
            {
              type: 'text',
              text: 'Transcribe every mandatory element from this alcohol beverage label.',
            },
          ],
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      throw new ExtractionError(`Claude API error (${err.status}): ${err.message}`, 'api_error');
    }
    throw err;
  }
}

const asString = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;
const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const asBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/**
 * Normalizes the model's output into a LabelExtraction.
 *
 * The one non-obvious rule: numeric fields are re-derived from the verbatim
 * transcription using this codebase's own parsers, and the model's numeric
 * fields are only a fallback. The transcription is the evidence an agent will
 * look at, so every downstream number must be traceable to it. If the model
 * transcribed "45% Alc./Vol." the ABV must be 45 even if it separately reported
 * 40 in the numeric field.
 */
function coerceExtraction(raw: unknown): LabelExtraction {
  const o = (raw ?? {}) as Record<string, unknown>;

  const alcoholText = asString(o.alcoholContentText);
  const parsedAlcohol = alcoholText
    ? parseAlcoholContent(alcoholText)
    : { abv: null, proof: null };

  const netText = asString(o.netContentsText);
  const parsedNet = netText ? parseNetContents(netText) : null;

  const issues = Array.isArray(o.imageQualityIssues)
    ? o.imageQualityIssues.filter((i): i is string => typeof i === 'string')
    : [];

  const confidence = asNumber(o.transcriptionConfidence);

  return {
    brandName: asString(o.brandName),
    classType: asString(o.classType),
    alcoholContentText: alcoholText,
    alcoholContentAbv: parsedAlcohol.abv ?? asNumber(o.alcoholContentAbv),
    proof: parsedAlcohol.proof ?? asNumber(o.proof),
    netContentsText: netText,
    netContentsMl: parsedNet ?? asNumber(o.netContentsMl),
    bottlerNameAddress: asString(o.bottlerNameAddress),
    countryOfOrigin: asString(o.countryOfOrigin),
    governmentWarningText: asString(o.governmentWarningText),
    warningPrefixIsAllCaps: asBool(o.warningPrefixIsAllCaps),
    warningPrefixAppearsBold: asBool(o.warningPrefixAppearsBold),
    warningAppearsSeparate: asBool(o.warningAppearsSeparate),
    warningRelativeSize: asNumber(o.warningRelativeSize),
    imageLegible: o.imageLegible !== false,
    imageQualityIssues: issues,
    transcriptionConfidence: confidence == null ? 0.5 : Math.min(1, Math.max(0, confidence)),
    notes: asString(o.notes),
  };
}
