import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEMO_FIXTURES, fixtureFor } from '../server/claude/fixtures.ts';
import { runChecks } from '../server/rules/index.ts';
import { parseManifest } from '../web/src/csv.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApplicationRecord, BeverageClass } from '../server/rules/types.ts';

/**
 * Verifies that each demo fixture actually produces the failure it is supposed
 * to demonstrate.
 *
 * Without this, a demo could quietly drift into showing the wrong thing — a
 * sample advertised as "catches title-case warnings" that silently passes is
 * worse than no sample at all, because it teaches a reviewer the wrong lesson
 * about what the tool does.
 */

const MANIFEST_PATH = path.join(process.cwd(), 'samples', 'generated', 'applications.csv');

async function loadApplications(): Promise<Map<string, ApplicationRecord> | null> {
  try {
    const csv = await readFile(MANIFEST_PATH, 'utf8');
    const rows = parseManifest(csv);
    return new Map(
      rows.map((row) => [
        row.fileName,
        {
          applicationId: row.applicationId,
          beverageClass: row.beverageClass as BeverageClass,
          brandName: row.brandName,
          classType: row.classType,
          alcoholContentAbv: row.alcoholContentAbv,
          netContentsMl: row.netContentsMl,
          bottlerNameAddress: row.bottlerNameAddress,
          countryOfOrigin: row.countryOfOrigin,
          isImport: row.isImport,
        },
      ]),
    );
  } catch {
    // Samples are generated, not committed. Skip rather than fail on a fresh clone.
    return null;
  }
}

/** What each sample is supposed to demonstrate. */
const EXPECTATIONS: Record<string, { overall: string; failing?: string }> = {
  '01-compliant.png': { overall: 'pass' },
  '02-warning-title-case.png': { overall: 'fail', failing: 'government_warning' },
  '03-abv-mismatch.png': { overall: 'fail', failing: 'alcohol_content' },
  '04-warning-reworded.png': { overall: 'fail', failing: 'government_warning' },
  '05-brand-case-variant.png': { overall: 'pass' },
  '06-proof-mismatch.png': { overall: 'fail', failing: 'alcohol_content' },
  '07-nonstandard-fill.png': { overall: 'fail', failing: 'net_contents' },
  '08-poor-image.jpg': { overall: 'review' },
};

describe('demo fixtures', () => {
  it('covers every generated sample label', () => {
    for (const name of Object.keys(EXPECTATIONS)) {
      assert.ok(DEMO_FIXTURES[name], `missing fixture for ${name}`);
    }
  });

  it('substitutes a clearly-labelled placeholder for unknown files', () => {
    const fixture = fixtureFor('some-random-upload.png');
    assert.match(fixture.notes ?? '', /demo mode/i);
    assert.match(fixture.notes ?? '', /nothing was read/i);
  });

  it('each sample demonstrates the failure it advertises', async (t) => {
    const applications = await loadApplications();
    if (!applications) {
      t.skip('samples not generated — run `npm run samples` first');
      return;
    }

    for (const [fileName, expected] of Object.entries(EXPECTATIONS)) {
      const application = applications.get(fileName);
      assert.ok(application, `no application row for ${fileName}`);

      const { overall, checks } = runChecks(application, fixtureFor(fileName));

      assert.equal(
        overall,
        expected.overall,
        `${fileName}: expected overall "${expected.overall}", got "${overall}"`,
      );

      if (expected.failing) {
        const check = checks.find((c) => c.id === expected.failing);
        assert.equal(
          check?.verdict,
          'fail',
          `${fileName}: expected "${expected.failing}" to fail`,
        );
      }
    }
  });

  it("does not flag Dave's capitalization case", async (t) => {
    const applications = await loadApplications();
    if (!applications) {
      t.skip('samples not generated — run `npm run samples` first');
      return;
    }

    const application = applications.get('05-brand-case-variant.png')!;
    const { checks } = runChecks(application, fixtureFor('05-brand-case-variant.png'));
    const brand = checks.find((c) => c.id === 'brand_name');

    assert.equal(brand?.verdict, 'pass');
    assert.equal(brand?.found, "STONE'S THROW");
    assert.equal(brand?.expected, "Stone's Throw");
  });
});
