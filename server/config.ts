import 'dotenv/config';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Reads a secret from the environment and strips the two artifacts that
 * survive a copy-paste into a hosting platform's secret field:
 *
 *   - surrounding quotes, because `KEY="sk-ant-..."` in a dashboard field is
 *     stored with the quotes as part of the value, unlike in a shell
 *   - leading and trailing whitespace, including the newline that comes along
 *     when a key is copied from a terminal or a wrapped line
 *
 * Both produce a value that is present and non-empty — so every "is the key
 * configured?" check passes — and then fails at the API with a bare
 * `invalid x-api-key`, which points at the key rather than at the paste.
 * Found on the first real deployment.
 */
function secret(name: string): string {
  const raw = process.env[name];
  if (!raw) return '';
  return raw.trim().replace(/^["']|["']$/g, '').trim();
}

export const config = {
  apiKey: secret('ANTHROPIC_API_KEY'),

  /**
   * Claude Opus 5 by default: this is a government compliance determination and
   * accuracy on small, low-contrast warning text is the entire product.
   *
   * Sonnet 5 and Haiku 4.5 are drop-in alternatives via ANTHROPIC_MODEL for
   * high-volume batch runs where per-label cost matters more than the last
   * point of extraction accuracy. See README for measured latency per model.
   */
  model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5',

  /**
   * Low effort is correct here and is not a cost compromise. Reading text off
   * an image is perception, not reasoning — and every actual compliance
   * decision is made by deterministic code in server/rules, not by the model.
   * Higher effort buys deliberation this task has no use for, and spends the
   * latency budget that the previous vendor pilot died for missing.
   */
  effort: process.env.EXTRACTION_EFFORT ?? 'low',

  /**
   * Whether the model reasons before answering: "disabled" or "adaptive".
   *
   * Disabled by default, and measured rather than assumed — see README. This is
   * a perception task with a schema-constrained output and no tools, which is
   * the narrow case where thinking buys little: there is no plan to make and no
   * tool to choose, only text to read off an image. Leaving it on roughly
   * doubled end-to-end latency in benchmarking and pushed every label past the
   * five-second budget, without changing a single extracted field across the
   * sample set.
   *
   * Set EXTRACTION_THINKING=adaptive to compare on your own labels.
   */
  thinking: process.env.EXTRACTION_THINKING === 'adaptive' ? 'adaptive' : 'disabled',

  /**
   * Model tried once if the primary declines a request. Defaults to something
   * other than the primary, since retrying the same model just spends a second
   * call to get the same refusal.
   */
  get fallbackModel(): string {
    const explicit = process.env.ANTHROPIC_FALLBACK_MODEL;
    if (explicit) return explicit;
    return this.model === 'claude-opus-5' ? 'claude-sonnet-5' : 'claude-opus-5';
  },

  batchConcurrency: int('BATCH_CONCURRENCY', 6),

  /**
   * Read the label a second time when the government warning's wording does not
   * match, before reporting it as a violation. Costs one extra API call only on
   * the mismatch path. See the rationale in verify.ts.
   */
  confirmDisputedWarning: process.env.CONFIRM_DISPUTED_WARNING !== 'false',

  /**
   * Longest image edge sent to the API, in pixels. Claude Opus 5 accepts up to
   * 2576px and maps coordinates 1:1 at that size. Lowering this reduces image
   * tokens roughly quadratically; raising it beyond 2576 does nothing but cost
   * upload time, since the API downscales anyway.
   */
  maxImageEdge: int('MAX_IMAGE_EDGE', 2576),

  port: int('PORT', 3001),

  /**
   * Serve stored transcriptions instead of calling the API, so the whole
   * application can be demonstrated without a key.
   *
   * Opt-in only. It is never enabled automatically as a fallback: a failed live
   * call must surface as a failure, not silently become fixture data. Every
   * demo result is badged in the UI and in the API response.
   */
  demoMode: process.env.DEMO_MODE === 'true',

  get hasApiKey(): boolean {
    return this.apiKey.length > 0;
  },

  /** True when the tool can produce results at all — live or demo. */
  get canRun(): boolean {
    return this.hasApiKey || this.demoMode;
  },
};
