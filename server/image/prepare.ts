import sharp from 'sharp';
import { config } from '../config.ts';

export interface PreparedImage {
  /** Base64 JPEG, ready for an image content block. */
  base64: string;
  mediaType: 'image/jpeg';
  width: number;
  height: number;
  /** Small base64 data URL for the results table in the UI. */
  thumbnailDataUrl: string;
  /** What preprocessing actually did, surfaced to the agent for transparency. */
  transformations: string[];
}

/**
 * Prepares a submitted photograph for the vision API.
 *
 * Jenny Park asked for tolerance of imperfect images — labels shot at an angle,
 * under glare, in poor light. Most of that tolerance comes from the model
 * itself, but three cheap deterministic steps measurably help before it ever
 * gets there:
 *
 *   1. EXIF auto-rotation. Phone photos routinely carry an orientation flag
 *      that image pipelines drop, producing a sideways label. This is the
 *      single highest-value fix and it is free.
 *   2. Downscale to the model's native resolution ceiling. Above 2576px the
 *      API downscales anyway, so sending more is pure upload latency.
 *   3. Re-encode as JPEG. Uploads of 12 MP PNGs dominate wall-clock time on a
 *      300-label batch.
 *
 * Deliberately NOT done: contrast normalization, sharpening, deskewing. Each
 * can destroy the low-contrast fine print that this tool exists to read, and
 * the model handles those conditions better than a fixed filter does.
 */
export async function prepareImage(input: Buffer): Promise<PreparedImage> {
  const transformations: string[] = [];

  const pipeline = sharp(input, { failOn: 'none' });
  const metadata = await pipeline.metadata();

  if (metadata.orientation && metadata.orientation !== 1) {
    transformations.push('Rotated using the orientation recorded by the camera');
  }

  // .rotate() with no argument applies the EXIF orientation, then strips it.
  let work = pipeline.rotate();

  const longestEdge = Math.max(metadata.width ?? 0, metadata.height ?? 0);
  if (longestEdge > config.maxImageEdge) {
    work = work.resize({
      width: config.maxImageEdge,
      height: config.maxImageEdge,
      fit: 'inside',
      withoutEnlargement: true,
    });
    transformations.push(
      `Scaled down from ${longestEdge}px to ${config.maxImageEdge}px on the longest edge`,
    );
  }

  const { data, info } = await work
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  const thumbnail = await sharp(data)
    .resize({ width: 240, height: 240, fit: 'inside' })
    .jpeg({ quality: 70 })
    .toBuffer();

  return {
    base64: data.toString('base64'),
    mediaType: 'image/jpeg',
    width: info.width,
    height: info.height,
    thumbnailDataUrl: `data:image/jpeg;base64,${thumbnail.toString('base64')}`,
    transformations,
  };
}
