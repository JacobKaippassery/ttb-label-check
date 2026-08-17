/**
 * Generates demo label images so the tool can be evaluated without hunting for
 * real artwork, and so every interesting failure mode has a reproducible test
 * case.
 *
 * Each sample targets a specific thing a stakeholder raised:
 *
 *   01 compliant ............. the happy path, from the project brief
 *   02 warning-title-case .... Jenny Park's catch: "Government Warning" in title
 *                              case instead of all capitals. Semantically
 *                              identical, and a rejection.
 *   03 abv-mismatch .......... the routine data-entry mismatch that Sarah says
 *                              consumes half of an agent's day
 *   04 warning-reworded ...... one word changed deep inside the warning, the
 *                              kind of thing that survives a tired human read
 *   05 brand-case-variant .... Dave Morrison's STONE'S THROW vs Stone's Throw.
 *                              This one MUST pass — flagging it is the failure.
 *   06 proof-mismatch ........ label contradicts itself: 45% ABV, 86 proof
 *   07 nonstandard-fill ...... 800 mL, not an authorized standard of fill
 *   08 poor-image ............ correct label, photographed badly: rotated,
 *                              darkened, glared. Jenny asked for this.
 *
 * Run with: npm run samples
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const OUT_DIR = path.join(process.cwd(), 'samples', 'generated');

const W = 1000;
const H = 1400;

const CORRECT_WARNING =
  'GOVERNMENT WARNING: (1) According to the Surgeon General, women should not ' +
  'drink alcoholic beverages during pregnancy because of the risk of birth ' +
  'defects. (2) Consumption of alcoholic beverages impairs your ability to ' +
  'drive a car or operate machinery, and may cause health problems.';

interface LabelSpec {
  file: string;
  brand: string;
  classType: string;
  alcohol: string;
  netContents: string;
  bottler: string[];
  warning: string;
  /** Applied after render, to simulate a bad photograph. */
  degrade?: boolean;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Greedy word wrap, measured in approximate characters per line. */
function wrap(text: string, maxChars: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if (`${line} ${word}`.length <= maxChars) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Bold serif capitals average roughly 0.72em wide, plus 2px letter-spacing.
 * Scale the brand name down until it fits inside the printed border rather than
 * letting a long name run off the edge of the label.
 */
function brandFontSize(brand: string): number {
  const usableWidth = W - 140;
  const fitted = Math.floor((usableWidth - brand.length * 2) / (brand.length * 0.72));
  return Math.max(34, Math.min(76, fitted));
}

function buildSvg(spec: LabelSpec): string {
  const warningLines = wrap(spec.warning, 78);
  const warningStartY = H - 60 - warningLines.length * 26;

  const bottlerLines = spec.bottler
    .map(
      (line, i) =>
        `<text x="${W / 2}" y="${H - 240 + i * 30}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#2a2318">${escapeXml(line)}</text>`,
    )
    .join('\n    ');

  // The warning prefix is emitted as its own bold tspan so that the rendered
  // image genuinely carries the typographic distinction the regulation
  // requires — the model is reading real bold text, not a described one.
  const warningSvg = warningLines
    .map((line, i) => {
      const y = warningStartY + i * 26;
      if (i === 0) {
        const prefixMatch = line.match(/^(GOVERNMENT WARNING:|Government Warning:)/);
        if (prefixMatch) {
          const prefix = prefixMatch[0];
          const rest = line.slice(prefix.length);
          return `<text x="60" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="19" fill="#2a2318"><tspan font-weight="bold">${escapeXml(prefix)}</tspan>${escapeXml(rest)}</text>`;
        }
      }
      return `<text x="60" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="19" fill="#2a2318">${escapeXml(line)}</text>`;
    })
    .join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#f7f1e1"/>
        <stop offset="100%" stop-color="#efe6d0"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#paper)"/>
    <rect x="30" y="30" width="${W - 60}" height="${H - 60}" fill="none" stroke="#8a6f3d" stroke-width="4"/>
    <rect x="46" y="46" width="${W - 92}" height="${H - 92}" fill="none" stroke="#8a6f3d" stroke-width="1"/>

    <text x="${W / 2}" y="220" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="34" letter-spacing="8" fill="#6b5424">ESTABLISHED 1868</text>

    <text x="${W / 2}" y="360" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${brandFontSize(spec.brand)}" font-weight="bold" letter-spacing="2" fill="#2a2318">${escapeXml(spec.brand)}</text>

    <line x1="180" y1="420" x2="${W - 180}" y2="420" stroke="#8a6f3d" stroke-width="3"/>

    <text x="${W / 2}" y="500" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="38" fill="#3d3423">${escapeXml(spec.classType)}</text>

    <text x="${W / 2}" y="700" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="30" fill="#3d3423">DISTILLED AND BOTTLED BY</text>

    <text x="${W / 2}" y="880" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="32" font-weight="bold" fill="#2a2318">${escapeXml(spec.alcohol)}</text>

    <text x="${W / 2}" y="940" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="32" fill="#2a2318">${escapeXml(spec.netContents)}</text>

    ${bottlerLines}

    <line x1="60" y1="${warningStartY - 34}" x2="${W - 60}" y2="${warningStartY - 34}" stroke="#8a6f3d" stroke-width="1"/>
    ${warningSvg}
  </svg>`;
}

/**
 * Simulates a photograph taken in the field: slight rotation, uneven exposure,
 * and a specular highlight across part of the label.
 */
async function degrade(png: Buffer): Promise<Buffer> {
  const glare = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs>
        <radialGradient id="g" cx="0.68" cy="0.34" r="0.42">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.88"/>
          <stop offset="55%" stop-color="#ffffff" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#g)"/>
    </svg>`,
  );

  return sharp(png)
    .composite([{ input: glare, blend: 'over' }])
    .modulate({ brightness: 0.72 })
    .rotate(7, { background: { r: 26, g: 24, b: 22, alpha: 1 } })
    .blur(1.4)
    .jpeg({ quality: 62 })
    .toBuffer();
}

const SPECS: LabelSpec[] = [
  {
    file: '01-compliant.png',
    brand: 'OLD TOM DISTILLERY',
    classType: 'Kentucky Straight Bourbon Whiskey',
    alcohol: '45% Alc./Vol. (90 Proof)',
    netContents: '750 mL',
    bottler: ['Old Tom Distillery', 'Bardstown, Kentucky'],
    warning: CORRECT_WARNING,
  },
  {
    file: '02-warning-title-case.png',
    brand: 'OLD TOM DISTILLERY',
    classType: 'Kentucky Straight Bourbon Whiskey',
    alcohol: '45% Alc./Vol. (90 Proof)',
    netContents: '750 mL',
    bottler: ['Old Tom Distillery', 'Bardstown, Kentucky'],
    warning: CORRECT_WARNING.replace('GOVERNMENT WARNING:', 'Government Warning:'),
  },
  {
    file: '03-abv-mismatch.png',
    brand: 'OLD TOM DISTILLERY',
    classType: 'Kentucky Straight Bourbon Whiskey',
    alcohol: '40% Alc./Vol. (80 Proof)',
    netContents: '750 mL',
    bottler: ['Old Tom Distillery', 'Bardstown, Kentucky'],
    warning: CORRECT_WARNING,
  },
  {
    file: '04-warning-reworded.png',
    brand: 'OLD TOM DISTILLERY',
    classType: 'Kentucky Straight Bourbon Whiskey',
    alcohol: '45% Alc./Vol. (90 Proof)',
    netContents: '750 mL',
    bottler: ['Old Tom Distillery', 'Bardstown, Kentucky'],
    warning: CORRECT_WARNING.replace('may cause health problems', 'can cause health issues'),
  },
  {
    file: '05-brand-case-variant.png',
    brand: "STONE'S THROW",
    classType: 'Straight Rye Whiskey',
    alcohol: '47% Alc./Vol. (94 Proof)',
    netContents: '750 mL',
    bottler: ["Stone's Throw Distilling Co.", 'Louisville, Kentucky'],
    warning: CORRECT_WARNING,
  },
  {
    file: '06-proof-mismatch.png',
    brand: 'OLD TOM DISTILLERY',
    classType: 'Kentucky Straight Bourbon Whiskey',
    alcohol: '45% Alc./Vol. (86 Proof)',
    netContents: '750 mL',
    bottler: ['Old Tom Distillery', 'Bardstown, Kentucky'],
    warning: CORRECT_WARNING,
  },
  {
    file: '07-nonstandard-fill.png',
    brand: 'OLD TOM DISTILLERY',
    classType: 'Kentucky Straight Bourbon Whiskey',
    alcohol: '45% Alc./Vol. (90 Proof)',
    netContents: '800 mL',
    bottler: ['Old Tom Distillery', 'Bardstown, Kentucky'],
    warning: CORRECT_WARNING,
  },
  {
    file: '08-poor-image.jpg',
    brand: 'OLD TOM DISTILLERY',
    classType: 'Kentucky Straight Bourbon Whiskey',
    alcohol: '45% Alc./Vol. (90 Proof)',
    netContents: '750 mL',
    bottler: ['Old Tom Distillery', 'Bardstown, Kentucky'],
    warning: CORRECT_WARNING,
    degrade: true,
  },
];

/** Application records matching the images above, with deliberate mismatches. */
const MANIFEST = [
  ['fileName', 'applicationId', 'beverageClass', 'brandName', 'classType', 'alcoholContentAbv', 'netContentsMl', 'bottlerNameAddress', 'countryOfOrigin', 'isImport'],
  ['01-compliant.png', 'TTB-2026-0148', 'distilled_spirits', 'OLD TOM DISTILLERY', 'Kentucky Straight Bourbon Whiskey', '45', '750', 'Old Tom Distillery, Bardstown, Kentucky', '', 'false'],
  ['02-warning-title-case.png', 'TTB-2026-0149', 'distilled_spirits', 'OLD TOM DISTILLERY', 'Kentucky Straight Bourbon Whiskey', '45', '750', 'Old Tom Distillery, Bardstown, Kentucky', '', 'false'],
  ['03-abv-mismatch.png', 'TTB-2026-0150', 'distilled_spirits', 'OLD TOM DISTILLERY', 'Kentucky Straight Bourbon Whiskey', '45', '750', 'Old Tom Distillery, Bardstown, Kentucky', '', 'false'],
  ['04-warning-reworded.png', 'TTB-2026-0151', 'distilled_spirits', 'OLD TOM DISTILLERY', 'Kentucky Straight Bourbon Whiskey', '45', '750', 'Old Tom Distillery, Bardstown, Kentucky', '', 'false'],
  ['05-brand-case-variant.png', 'TTB-2026-0152', 'distilled_spirits', "Stone's Throw", 'Straight Rye Whiskey', '47', '750', "Stone's Throw Distilling Company, Louisville, KY", '', 'false'],
  ['06-proof-mismatch.png', 'TTB-2026-0153', 'distilled_spirits', 'OLD TOM DISTILLERY', 'Kentucky Straight Bourbon Whiskey', '45', '750', 'Old Tom Distillery, Bardstown, Kentucky', '', 'false'],
  ['07-nonstandard-fill.png', 'TTB-2026-0154', 'distilled_spirits', 'OLD TOM DISTILLERY', 'Kentucky Straight Bourbon Whiskey', '45', '800', 'Old Tom Distillery, Bardstown, Kentucky', '', 'false'],
  ['08-poor-image.jpg', 'TTB-2026-0155', 'distilled_spirits', 'OLD TOM DISTILLERY', 'Kentucky Straight Bourbon Whiskey', '45', '750', 'Old Tom Distillery, Bardstown, Kentucky', '', 'false'],
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  for (const spec of SPECS) {
    const svg = buildSvg(spec);
    const rendered = await sharp(Buffer.from(svg)).png().toBuffer();
    const final = spec.degrade ? await degrade(rendered) : rendered;
    await writeFile(path.join(OUT_DIR, spec.file), final);
    console.log(`  ${spec.file.padEnd(30)} ${(final.length / 1024).toFixed(0)} KB`);
  }

  const csv = MANIFEST.map((row) =>
    row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(','),
  ).join('\r\n');
  await writeFile(path.join(OUT_DIR, 'applications.csv'), `﻿${csv}`, 'utf8');
  console.log(`  applications.csv               ${MANIFEST.length - 1} rows`);

  console.log(`\nWrote ${SPECS.length} sample labels to samples/generated\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
