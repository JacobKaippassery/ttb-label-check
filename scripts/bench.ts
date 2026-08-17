/**
 * Latency benchmark.
 *
 * Sarah Chen described exactly how the previous vendor pilot died:
 *
 *   "The system would take 30, 40 seconds sometimes to process a single label.
 *    Our agents just went back to doing it by eye ... If we can't get results
 *    back in about 5 seconds, nobody's going to use it."
 *
 * So latency is a functional requirement, not a nice-to-have, and it needs a
 * number rather than a vibe. This script measures the real end-to-end path —
 * image preparation, the API round trip, and the rules engine — against the
 * generated sample labels, and reports the distribution.
 *
 *   npm run bench                                   # settings from .env, 3 runs
 *   npm run bench -- --model claude-haiku-4-5 --runs 5
 *   npm run bench -- --image-edge 1200 --thinking adaptive
 *   npm run bench -- --concurrency 8                # batch throughput too
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ApplicationRecord } from '../server/rules/types.ts';

const SAMPLES_DIR = path.join(process.cwd(), 'samples', 'generated');

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

// Command-line overrides are applied to the environment BEFORE config is
// imported, since config reads process.env once at module load. Hence the
// dynamic imports below — a static import would be hoisted above these lines
// and would silently ignore every flag.
for (const [flag, envVar] of [
  ['model', 'ANTHROPIC_MODEL'],
  ['effort', 'EXTRACTION_EFFORT'],
  ['thinking', 'EXTRACTION_THINKING'],
  ['image-edge', 'MAX_IMAGE_EDGE'],
] as const) {
  const value = arg(flag);
  if (value) process.env[envVar] = value;
}
// Benchmarking against stored fixtures would measure nothing.
process.env.DEMO_MODE = 'false';

const { config } = await import('../server/config.ts');
const { prepareImage } = await import('../server/image/prepare.ts');
const { extractLabel } = await import('../server/claude/extract.ts');
const { runChecks } = await import('../server/rules/index.ts');
const { mapWithConcurrency } = await import('../server/pool.ts');

const RUNS = Number.parseInt(arg('runs') ?? '3', 10);
const CONCURRENCY = Number.parseInt(arg('concurrency') ?? String(config.batchConcurrency), 10);

const APPLICATION: ApplicationRecord = {
  applicationId: 'BENCH',
  beverageClass: 'distilled_spirits',
  brandName: 'OLD TOM DISTILLERY',
  classType: 'Kentucky Straight Bourbon Whiskey',
  alcoholContentAbv: 45,
  netContentsMl: 750,
  bottlerNameAddress: 'Old Tom Distillery, Bardstown, Kentucky',
  countryOfOrigin: null,
  isImport: false,
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index]!;
}

async function main() {
  if (!config.hasApiKey) {
    console.error('\n  No ANTHROPIC_API_KEY set. Copy .env.example to .env and add your key.\n');
    process.exit(1);
  }

  const files = (await readdir(SAMPLES_DIR)).filter((f) => /\.(png|jpe?g)$/i.test(f));
  if (files.length === 0) {
    console.error('\n  No sample images found. Run `npm run samples` first.\n');
    process.exit(1);
  }

  const buffers = await Promise.all(
    files.map(async (f) => ({ name: f, data: await readFile(path.join(SAMPLES_DIR, f)) })),
  );

  console.log(`\n  Model:   ${config.model} (effort: ${config.effort})`);
  console.log(`  Labels:  ${files.length} samples x ${RUNS} runs`);
  console.log(`  Image:   downscaled to ${config.maxImageEdge}px longest edge\n`);

  // ---- Sequential: what one agent experiences on one label ----
  const latencies: number[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let run = 0; run < RUNS; run++) {
    for (const { name, data } of buffers) {
      const start = performance.now();
      const image = await prepareImage(data);
      const { extraction, usage } = await extractLabel(image);
      runChecks(APPLICATION, extraction);
      const elapsed = performance.now() - start;

      latencies.push(elapsed);
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;

      const flag = elapsed <= 5000 ? 'ok  ' : 'SLOW';
      console.log(
        `  ${flag} ${name.padEnd(28)} ${(elapsed / 1000).toFixed(2)}s  ` +
          `(${usage.inputTokens} in / ${usage.outputTokens} out)`,
      );
    }
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const within5s = latencies.filter((l) => l <= 5000).length;

  console.log('\n  ── Single label (what an agent waits for) ─────────────────');
  console.log(`  mean   ${(mean / 1000).toFixed(2)}s`);
  console.log(`  p50    ${(percentile(sorted, 50) / 1000).toFixed(2)}s`);
  console.log(`  p95    ${(percentile(sorted, 95) / 1000).toFixed(2)}s`);
  console.log(`  max    ${(sorted[sorted.length - 1]! / 1000).toFixed(2)}s`);
  console.log(
    `  within 5s: ${within5s}/${latencies.length} (${((within5s / latencies.length) * 100).toFixed(0)}%)`,
  );

  // ---- Batch: what matters for a 300-label importer submission ----
  console.log(`\n  ── Batch throughput at concurrency ${CONCURRENCY} ─────────────────`);
  const batchStart = performance.now();
  await mapWithConcurrency(buffers, CONCURRENCY, async ({ data }) => {
    const image = await prepareImage(data);
    const { extraction } = await extractLabel(image);
    return runChecks(APPLICATION, extraction);
  });
  const batchElapsed = performance.now() - batchStart;
  const perLabel = batchElapsed / buffers.length;

  console.log(`  ${buffers.length} labels in ${(batchElapsed / 1000).toFixed(1)}s`);
  console.log(`  ${(perLabel / 1000).toFixed(2)}s per label wall-clock`);
  console.log(
    `  projected for 300 labels: ${((perLabel * 300) / 1000 / 60).toFixed(1)} minutes\n`,
  );

  // Pricing is per million tokens; see the model's current published rate.
  const totalCalls = latencies.length;
  console.log(
    `  Tokens: ${Math.round(inputTokens / totalCalls)} in / ` +
      `${Math.round(outputTokens / totalCalls)} out per label (average)\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
