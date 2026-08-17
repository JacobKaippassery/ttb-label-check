import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { config } from './config.ts';
import { verifyLabel, ExtractionError } from './verify.ts';
import { mapWithConcurrency } from './pool.ts';
import { GOVERNMENT_WARNING_TEXT } from './rules/index.ts';
import type { ApplicationRecord } from './rules/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 500 },
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    apiKeyConfigured: config.hasApiKey,
    demoMode: config.demoMode,
    canRun: config.canRun,
    model: config.demoMode ? 'demo (stored transcriptions)' : config.model,
    effort: config.effort,
    batchConcurrency: config.batchConcurrency,
    requiredWarningText: GOVERNMENT_WARNING_TEXT,
  });
});

/**
 * Verify a single label, which may be made up of several panels.
 *
 * A bottle's front and back are two photographs of ONE label, and the mandatory
 * elements are spread across them. They are merged before the checks run, so a
 * front panel is never reported as missing a warning that is printed on the
 * back.
 */
app.post('/api/verify', upload.array('image', 10), async (req, res) => {
  try {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: 'No image was uploaded.' });
      return;
    }
    const application = parseApplication(req.body?.application);
    const result = await verifyLabel(
      application,
      files.map((f) => ({ buffer: f.buffer, fileName: f.originalname })),
    );
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * Verify a batch of labels.
 *
 * Responds as newline-delimited JSON streamed as each label finishes, so a
 * 300-label run shows results filling in from the first few seconds rather than
 * blocking on the slowest item. Each line is one complete result; the final
 * line is a summary object.
 */
app.post('/api/batch', upload.array('images', 500), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    res.status(400).json({ error: 'No images were uploaded.' });
    return;
  }

  let applications: Record<string, ApplicationRecord>;
  try {
    applications = parseApplicationMap(req.body?.applications);
  } catch (err) {
    sendError(res, err);
    return;
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const startedAt = performance.now();
  const write = (obj: unknown) => res.write(`${JSON.stringify(obj)}\n`);

  // Group panels that belong to the same submission. Rows in the manifest that
  // share an applicationId describe one label photographed from several angles,
  // so their images are merged and checked once rather than each being judged
  // as if it were a complete label.
  //
  // `groupAll` is the escape hatch for the common case of checking a single
  // bottle: every uploaded image is one label's panels. Grouping should not
  // require getting a CSV exactly right.
  const groupAll = req.body?.groupAll === 'true';
  const groups = groupAll
    ? [
        {
          label: files.map((f) => f.originalname).join(' + '),
          application:
            applications[files[0]!.originalname] ??
            fallbackApplication(files[0]!.originalname, 0),
          files,
        },
      ]
    : groupIntoSubmissions(files, applications);

  const outcomes = await mapWithConcurrency(
    groups,
    config.batchConcurrency,
    async (group) => {
      const result = await verifyLabel(
        group.application,
        group.files.map((f) => ({ buffer: f.buffer, fileName: f.originalname })),
      );
      write({ type: 'result', fileName: group.label, result });
      return result;
    },
  );

  outcomes.forEach((outcome, index) => {
    if (!outcome.ok) {
      write({
        type: 'error',
        fileName: groups[index]?.label ?? `item-${index}`,
        error: outcome.error.message,
      });
    }
  });

  const succeeded = outcomes.filter((o) => o.ok);
  write({
    type: 'summary',
    total: groups.length,
    panels: files.length,
    succeeded: succeeded.length,
    failed: outcomes.length - succeeded.length,
    elapsedMs: Math.round(performance.now() - startedAt),
    concurrency: config.batchConcurrency,
  });
  res.end();
});

function parseApplication(raw: unknown): ApplicationRecord {
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'The application record is missing from the request.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'The application record was not valid JSON.');
  }
  return validateApplication(parsed);
}

function parseApplicationMap(raw: unknown): Record<string, ApplicationRecord> {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'The application records were not valid JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new HttpError(400, 'Expected an array of application records.');
  }
  const map: Record<string, ApplicationRecord> = {};
  for (const entry of parsed) {
    const record = entry as { fileName?: unknown };
    if (typeof record.fileName !== 'string') {
      throw new HttpError(400, 'Every application record needs a fileName to match it to an image.');
    }
    map[record.fileName] = validateApplication(entry);
  }
  return map;
}

const BEVERAGE_CLASSES = new Set(['distilled_spirits', 'wine', 'malt_beverage']);

function validateApplication(value: unknown): ApplicationRecord {
  const o = (value ?? {}) as Record<string, unknown>;
  if (typeof o.brandName !== 'string' || o.brandName.trim() === '') {
    throw new HttpError(400, 'The application must include a brand name.');
  }
  if (typeof o.beverageClass !== 'string' || !BEVERAGE_CLASSES.has(o.beverageClass)) {
    throw new HttpError(
      400,
      'beverageClass must be one of: distilled_spirits, wine, malt_beverage.',
    );
  }
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v)
      ? v
      : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
        ? Number(v)
        : null;

  return {
    applicationId:
      typeof o.applicationId === 'string' && o.applicationId.trim() !== ''
        ? o.applicationId
        : 'unspecified',
    beverageClass: o.beverageClass as ApplicationRecord['beverageClass'],
    brandName: o.brandName,
    classType: typeof o.classType === 'string' ? o.classType : '',
    alcoholContentAbv: num(o.alcoholContentAbv),
    netContentsMl: num(o.netContentsMl),
    bottlerNameAddress: typeof o.bottlerNameAddress === 'string' ? o.bottlerNameAddress : null,
    countryOfOrigin: typeof o.countryOfOrigin === 'string' ? o.countryOfOrigin : null,
    isImport: o.isImport === true || o.isImport === 'true',
    alcoholContentOptional: o.alcoholContentOptional === true || o.alcoholContentOptional === 'true',
  };
}

/**
 * When a batch image has no matching application row, the label is still
 * transcribed, but every comparison reports "nothing to compare against"
 * rather than inventing an expected value.
 *
 * Every field is deliberately empty. An earlier version put the FILENAME in
 * brandName — which meant an unmatched label was compared against
 * "image-01.jpeg" and always reported a brand-name violation. A false
 * violation caused by the tool's own placeholder data is far worse than
 * reporting honestly that there was nothing to compare against.
 */
interface Submission {
  /** Display name: the single filename, or "front.jpg + back.jpg". */
  label: string;
  application: ApplicationRecord;
  files: Express.Multer.File[];
}

/**
 * Groups uploaded images into submissions.
 *
 * Manifest rows sharing an applicationId describe one label across several
 * panels, so their images travel together. Anything without a manifest row
 * stands alone — guessing which unmatched photos belong together would be
 * worse than checking them separately and saying so.
 *
 * Upload order is preserved so an exported CSV still lines up with the batch.
 */
function groupIntoSubmissions(
  files: Express.Multer.File[],
  applications: Record<string, ApplicationRecord>,
): Submission[] {
  const byApplication = new Map<string, Submission>();
  const submissions: Submission[] = [];

  files.forEach((file, index) => {
    const application = applications[file.originalname];

    if (!application) {
      submissions.push({
        label: file.originalname,
        application: fallbackApplication(file.originalname, index),
        files: [file],
      });
      return;
    }

    const existing = byApplication.get(application.applicationId);
    if (existing) {
      existing.files.push(file);
      existing.label = existing.files.map((f) => f.originalname).join(' + ');
      return;
    }

    const submission: Submission = {
      label: file.originalname,
      application,
      files: [file],
    };
    byApplication.set(application.applicationId, submission);
    submissions.push(submission);
  });

  return submissions;
}

function fallbackApplication(_fileName: string, index: number): ApplicationRecord {
  return {
    applicationId: `UNMATCHED-${index + 1}`,
    beverageClass: 'distilled_spirits',
    brandName: '',
    classType: '',
    alcoholContentAbv: null,
    netContentsMl: null,
    bottlerNameAddress: null,
    countryOfOrigin: null,
    isImport: false,
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendError(res: express.Response, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof ExtractionError) {
    res.status(err.code === 'no_api_key' ? 503 : 502).json({ error: err.message, code: err.code });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
}

// In production the built frontend is served from the same origin as the API,
// so there is no CORS surface and nothing to configure at deploy time.
if (process.env.NODE_ENV === 'production') {
  const dist = path.join(here, '..', 'dist');
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.listen(config.port, () => {
  console.log(`\n  TTB Label Check — API on http://localhost:${config.port}`);
  if (config.demoMode) {
    console.log('  DEMO MODE — serving stored transcriptions. No API calls are made.\n');
  } else if (!config.hasApiKey) {
    console.log(`  Model: ${config.model} (effort: ${config.effort})`);
    console.log('  WARNING: ANTHROPIC_API_KEY is not set. Copy .env.example to .env,');
    console.log('           or set DEMO_MODE=true to run without a key.\n');
  } else {
    console.log(`  Model: ${config.model} (effort: ${config.effort})\n`);
  }
});
