import type { VerifyResult } from './types.ts';

/**
 * Minimal RFC 4180 CSV parser — handles quoted fields, embedded commas,
 * embedded newlines, and doubled quotes. Written by hand rather than pulled in
 * as a dependency because the batch manifest format is fixed and tiny, and a
 * federal deployment reviews every third-party package it ships.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const stripped = text.replace(/^﻿/, '');

  for (let i = 0; i < stripped.length; i++) {
    const char = stripped[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (stripped[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && stripped[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

export interface ManifestRow {
  fileName: string;
  applicationId: string;
  beverageClass: string;
  brandName: string;
  classType: string;
  alcoholContentAbv: number | null;
  netContentsMl: number | null;
  bottlerNameAddress: string | null;
  countryOfOrigin: string | null;
  isImport: boolean;
  alcoholContentOptional: boolean;
}

/**
 * Turns an uploaded manifest CSV into application records keyed by image
 * filename. Header names are matched case- and separator-insensitively so that
 * "Brand Name", "brand_name", and "brandName" all work — agents export these
 * from COLA and Excel, and neither is fussy about casing.
 */
export function parseManifest(text: string): ManifestRow[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];

  const key = (s: string) => s.trim().toLowerCase().replace(/[\s_-]/g, '');
  const headers = rows[0]!.map(key);
  const at = (row: string[], name: string): string => {
    const index = headers.indexOf(key(name));
    return index === -1 ? '' : (row[index] ?? '').trim();
  };
  const num = (v: string): number | null =>
    v === '' || !Number.isFinite(Number(v)) ? null : Number(v);

  return rows.slice(1).map((row) => ({
    fileName: at(row, 'fileName'),
    applicationId: at(row, 'applicationId') || 'unspecified',
    beverageClass: at(row, 'beverageClass') || 'distilled_spirits',
    brandName: at(row, 'brandName'),
    classType: at(row, 'classType'),
    alcoholContentAbv: num(at(row, 'alcoholContentAbv')),
    netContentsMl: num(at(row, 'netContentsMl')),
    bottlerNameAddress: at(row, 'bottlerNameAddress') || null,
    countryOfOrigin: at(row, 'countryOfOrigin') || null,
    isImport: /^(true|yes|y|1)$/i.test(at(row, 'isImport')),
    alcoholContentOptional: /^(true|yes|y|1)$/i.test(at(row, 'alcoholContentOptional')),
  }));
}

function csvCell(value: string | number | null | undefined): string {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Exports batch results for the record. One row per label, with a column per
 * check, so the whole run can be filed, emailed, or opened in Excel — Dave
 * Morrison prints his email, and a CSV he can print is worth more than a
 * dashboard he has to keep open.
 */
export function resultsToCsv(entries: Array<{ fileName: string; result: VerifyResult }>): string {
  const checkIds = Array.from(
    new Set(entries.flatMap((e) => e.result.checks.map((c) => c.id))),
  );

  const header = [
    'file_name',
    'panels',
    'application_id',
    'overall',
    'headline',
    ...checkIds.flatMap((id) => [`${id}__verdict`, `${id}__summary`]),
    'label_brand_name',
    'label_class_type',
    'label_alcohol_content',
    'label_net_contents',
    'label_government_warning',
    'reading_confidence',
    'model',
    'elapsed_ms',
  ];

  const lines = [header.join(',')];

  for (const { fileName, result } of entries) {
    const byId = new Map(result.checks.map((c) => [c.id, c]));
    const row = [
      fileName,
      (result.panels ?? []).map((p) => p.fileName).join(' | '),
      result.applicationId,
      result.overall,
      result.headline,
      ...checkIds.flatMap((id) => [byId.get(id)?.verdict ?? '', byId.get(id)?.summary ?? '']),
      result.extraction.brandName,
      result.extraction.classType,
      result.extraction.alcoholContentText,
      result.extraction.netContentsText,
      result.extraction.governmentWarningText,
      result.extraction.transcriptionConfidence.toFixed(2),
      result.model,
      result.timings.totalMs,
    ];
    lines.push(row.map(csvCell).join(','));
  }

  return lines.join('\r\n');
}

/**
 * The full record for one or more determinations, as JSON.
 *
 * The CSV is for filing and for Excel; this is the audit artifact. It keeps the
 * verbatim transcription, every check with its citation, the model used, and
 * the timings — everything needed to reproduce or contest a determination later
 * without re-running a model that may since have changed.
 *
 * Thumbnails are stripped: they are base64 images that would dominate the file
 * and add nothing to an audit.
 */
export function resultsToJson(
  entries: Array<{ fileName: string; result: VerifyResult }>,
): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      tool: 'TTB Label Check (prototype)',
      note: 'Advisory only. Every finding is a suggestion for an agent to confirm or overrule.',
      determinations: entries.map(({ fileName, result }) => {
        const { thumbnailDataUrl: _thumb, panels, ...rest } = result;
        return {
          fileName,
          ...rest,
          panels: (panels ?? []).map((p) => ({ fileName: p.fileName })),
        };
      }),
    },
    null,
    2,
  );
}

function triggerDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadJson(filename: string, json: string): void {
  triggerDownload(filename, new Blob([json], { type: 'application/json' }));
}

export function downloadCsv(filename: string, csv: string): void {
  // The BOM makes Excel open UTF-8 correctly on Windows, which is what the
  // agency runs.
  triggerDownload(filename, new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
}
