import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { prepareImage } from '../server/image/prepare.ts';
import { mapWithConcurrency } from '../server/pool.ts';
import { config } from '../server/config.ts';

/**
 * Covers the parts of the pipeline that surround the model call. Generates its
 * own fixtures rather than depending on `npm run samples`, so the suite passes
 * on a fresh clone with no API key and no prior setup.
 */

async function makeImage(width: number, height: number, format: 'png' | 'jpeg' = 'png') {
  const canvas = sharp({
    create: { width, height, channels: 3, background: { r: 240, g: 235, b: 220 } },
  });
  return format === 'png' ? canvas.png().toBuffer() : canvas.jpeg().toBuffer();
}

describe('image preparation', () => {
  it('produces base64 JPEG plus a thumbnail', async () => {
    const prepared = await prepareImage(await makeImage(800, 600));

    assert.equal(prepared.mediaType, 'image/jpeg');
    assert.ok(prepared.base64.length > 0);
    assert.match(prepared.thumbnailDataUrl, /^data:image\/jpeg;base64,/);

    // The base64 must actually decode to a JPEG — an encoding slip here would
    // surface as an opaque API error rather than anything diagnosable.
    const decoded = Buffer.from(prepared.base64, 'base64');
    assert.equal((await sharp(decoded).metadata()).format, 'jpeg');
  });

  it('downscales oversized images to the model resolution ceiling', async () => {
    const oversized = config.maxImageEdge * 2;
    const prepared = await prepareImage(await makeImage(oversized, Math.round(oversized / 2)));

    assert.equal(prepared.width, config.maxImageEdge);
    assert.ok(prepared.transformations.some((t) => /scaled down/i.test(t)));
  });

  it('leaves images already within the ceiling at their original size', async () => {
    const prepared = await prepareImage(await makeImage(900, 1200));
    assert.equal(prepared.width, 900);
    assert.equal(prepared.height, 1200);
    assert.equal(
      prepared.transformations.filter((t) => /scaled down/i.test(t)).length,
      0,
    );
  });

  it('keeps thumbnails small enough to sit in a results table', async () => {
    const prepared = await prepareImage(await makeImage(2000, 2000));
    const thumb = Buffer.from(prepared.thumbnailDataUrl.split(',')[1]!, 'base64');
    const meta = await sharp(thumb).metadata();
    assert.ok(meta.width! <= 240 && meta.height! <= 240);
  });

  it('handles JPEG input as well as PNG', async () => {
    const prepared = await prepareImage(await makeImage(600, 800, 'jpeg'));
    assert.equal(prepared.width, 600);
  });
});

describe('bounded concurrency pool', () => {
  it('returns results in input order regardless of completion order', async () => {
    // Reversed delays: the last item finishes first. A CSV export lines up
    // row-for-row with the upload only if ordering is preserved here.
    const items = [40, 30, 20, 10, 0];
    const results = await mapWithConcurrency(items, 5, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return index;
    });

    assert.deepEqual(
      results.map((r) => (r.ok ? r.value : -1)),
      [0, 1, 2, 3, 4],
    );
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    });

    assert.ok(peak <= 3, `peak concurrency was ${peak}, expected at most 3`);
  });

  it('captures a failure without losing the rest of the batch', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('label 2 is unreadable');
      return n * 10;
    });

    assert.equal(results[0]?.ok, true);
    assert.equal(results[1]?.ok, false);
    assert.equal(results[2]?.ok, true);
    assert.match((results[1] as { error: Error }).error.message, /unreadable/);
  });

  it('reports progress once per completed item', async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n, (completed) => seen.push(completed));
    assert.deepEqual(seen, [1, 2, 3, 4]);
  });

  it('handles an empty batch without hanging', async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
  });
});
