/**
 * Inspects a single label against a running server and prints the raw
 * transcription plus every check.
 *
 * Exists for one specific debugging question: when a check fails, was it the
 * label that was wrong, or did the model mis-read it? A false positive on the
 * government warning is the most damaging error this tool can make — an agent
 * who is sent to look at three non-problems stops looking at the fourth.
 *
 *   npm run inspect -- samples/generated/06-proof-mismatch.png
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseManifest } from '../web/src/csv.ts';
import { GOVERNMENT_WARNING_TEXT } from '../server/rules/reference.ts';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3001';

async function main() {
  const target = process.argv[2];
  if (!target) throw new Error('Usage: npm run inspect -- <path-to-image>');

  const fileName = path.basename(target);
  const data = await readFile(target);

  const manifestPath = path.join(path.dirname(target), 'applications.csv');
  const rows = await readFile(manifestPath, 'utf8').then(parseManifest).catch(() => []);
  const application = rows.find((r) => r.fileName === fileName);
  if (!application) throw new Error(`No application row for ${fileName} in ${manifestPath}`);

  const body = new FormData();
  body.append('image', new Blob([new Uint8Array(data)]), fileName);
  body.append('application', JSON.stringify(application));

  const response = await fetch(`${BASE}/api/verify`, { method: 'POST', body });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);

  console.log(`\n  ${fileName} — ${result.overall.toUpperCase()} (${result.model})`);
  console.log(`  ${result.headline}\n`);

  console.log('  ── Transcribed from the label ─────────────────────');
  for (const [key, value] of Object.entries(result.extraction)) {
    if (key === 'governmentWarningText') continue;
    console.log(`  ${key.padEnd(26)} ${JSON.stringify(value)}`);
  }

  const warning: string | null = result.extraction.governmentWarningText;
  console.log('\n  ── Government warning ─────────────────────────────');
  console.log(`  required : ${GOVERNMENT_WARNING_TEXT}`);
  console.log(`  on label : ${warning ?? '(none found)'}`);
  console.log(`  identical: ${warning === GOVERNMENT_WARNING_TEXT}`);
  if (warning && warning !== GOVERNMENT_WARNING_TEXT) {
    for (let i = 0; i < Math.max(warning.length, GOVERNMENT_WARNING_TEXT.length); i++) {
      if (warning[i] !== GOVERNMENT_WARNING_TEXT[i]) {
        console.log(`  first difference at character ${i}:`);
        console.log(`    required: ...${GOVERNMENT_WARNING_TEXT.slice(Math.max(0, i - 40), i + 40)}...`);
        console.log(`    on label: ...${warning.slice(Math.max(0, i - 40), i + 40)}...`);
        break;
      }
    }
  }

  console.log('\n  ── Checks ────────────────────────────────────────');
  for (const check of result.checks) {
    console.log(`  ${String(check.verdict).padEnd(15)} ${check.title}`);
    console.log(`  ${''.padEnd(15)} ${check.summary}`);
  }
  console.log('');
}

main().catch((err) => {
  console.error(`\n  ${err.message}\n`);
  process.exitCode = 1;
});
