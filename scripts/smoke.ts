/**
 * End-to-end smoke test against a running server.
 *
 * Exercises the real HTTP path — multipart upload, image preparation,
 * extraction, the rules engine, and NDJSON streaming — rather than calling the
 * pipeline functions directly. Unit tests cover the logic; this covers the
 * wiring, which is where integration bugs actually live.
 *
 * Works in demo mode (no API key) or against a live key.
 *
 *   npm run dev          # in one terminal
 *   npm run smoke        # in another
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
// Reuse the parser the UI actually ships, rather than a second implementation.
// Bottler addresses contain commas and are therefore quoted; a naive split(',')
// silently shifts every later column and makes every label fail on bottler.
import { parseManifest } from '../web/src/csv.ts';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3001';
const SAMPLES_DIR = path.join(process.cwd(), 'samples', 'generated');

/** What each sample must produce. Mirrors test/fixtures.test.ts. */
const EXPECTED: Record<string, string> = {
  '01-compliant.png': 'pass',
  '02-warning-title-case.png': 'fail',
  '03-abv-mismatch.png': 'fail',
  '04-warning-reworded.png': 'fail',
  '05-brand-case-variant.png': 'pass',
  '06-proof-mismatch.png': 'fail',
  '07-nonstandard-fill.png': 'fail',
  '08-poor-image.jpg': 'review',
};

async function main() {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  console.log(`\n  Server: ${BASE}`);
  console.log(`  Mode:   ${health.demoMode ? 'DEMO (stored transcriptions)' : health.model}\n`);

  const files = (await readdir(SAMPLES_DIR)).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
  if (files.length === 0) throw new Error('No samples. Run `npm run samples` first.');

  const applications = parseManifest(
    await readFile(path.join(SAMPLES_DIR, 'applications.csv'), 'utf8'),
  );

  const body = new FormData();
  for (const name of files) {
    const data = await readFile(path.join(SAMPLES_DIR, name));
    body.append('images', new Blob([new Uint8Array(data)]), name);
  }
  body.append('applications', JSON.stringify(applications));

  const started = Date.now();
  const response = await fetch(`${BASE}/api/batch`, { method: 'POST', body });
  if (!response.ok) throw new Error(`Batch failed: ${response.status} ${await response.text()}`);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const results = new Map<string, string>();
  let failures = 0;
  // Held on an object rather than a bare `let`: the assignment happens inside a
  // closure, which control-flow analysis narrows away to `never`.
  const state: { summary: { elapsedMs: number } | null } = { summary: null };

  const handle = (line: string) => {
    const msg = JSON.parse(line);
    if (msg.type === 'result') {
      results.set(msg.fileName, msg.result.overall);
      const expected = EXPECTED[msg.fileName];
      const ok = expected === undefined || expected === msg.result.overall;
      if (!ok) failures++;
      console.log(
        `  ${ok ? 'ok  ' : 'FAIL'} ${msg.fileName.padEnd(30)} ${String(msg.result.overall).padEnd(7)}` +
          `${expected && !ok ? ` (expected ${expected})` : ''}`,
      );
      console.log(`       ${msg.result.headline}`);
    } else if (msg.type === 'error') {
      failures++;
      console.log(`  FAIL ${msg.fileName.padEnd(30)} ${msg.error}`);
    } else if (msg.type === 'summary') {
      state.summary = msg;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) handle(line);
    }
  }
  if (buffer.trim()) handle(buffer.trim());

  const missing = files.filter((f) => !results.has(f));
  for (const name of missing) {
    failures++;
    console.log(`  FAIL ${name.padEnd(30)} no result returned`);
  }

  console.log(
    `\n  ${files.length} labels in ${((Date.now() - started) / 1000).toFixed(1)}s` +
      (state.summary ? ` (server reported ${state.summary.elapsedMs}ms)` : ''),
  );

  if (failures > 0) {
    console.error(`\n  ${failures} check(s) did not match expectations.\n`);
    process.exit(1);
  }
  console.log('  All samples produced the expected verdict.\n');
}

main().catch((err) => {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
});
