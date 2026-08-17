import { useMemo, useRef, useState } from 'react';
import type { CheckResult, VerifyResult, Verdict } from '../types.ts';
import { VERDICT_MARKS } from '../types.ts';
import {
  downloadCsv,
  downloadJson,
  parseManifest,
  resultsToCsv,
  resultsToJson,
  type ManifestRow,
} from '../csv.ts';
import { ImageDrop } from './ImageDrop.tsx';
import { VerdictBanner } from './VerdictBanner.tsx';
import { CheckCard } from './CheckCard.tsx';

interface Entry {
  fileName: string;
  result: VerifyResult;
}
interface Failure {
  fileName: string;
  error: string;
}
interface Summary {
  total: number;
  succeeded: number;
  failed: number;
  elapsedMs: number;
  concurrency: number;
}

type Filter = 'all' | 'fail' | 'review' | 'pass';

/**
 * Batch verification.
 *
 * Sarah Chen: "during peak season, we get these big importers who dump 200, 300
 * label applications on us at once ... right now we literally have to process
 * them one at a time."
 *
 * Results stream in as newline-delimited JSON and render the moment each label
 * finishes, so a 300-label run is useful within seconds instead of after the
 * whole run completes. That responsiveness is the specific thing the previous
 * scanning-vendor pilot lacked.
 */
export function BatchCheck() {
  const [files, setFiles] = useState<File[]>([]);
  const [manifest, setManifest] = useState<ManifestRow[] | null>(null);
  const [manifestName, setManifestName] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  /**
   * "Every image here is one label."
   *
   * Grouping normally comes from the manifest, but requiring a correctly
   * matched CSV just to check the front and back of one bottle is a bad trade.
   * This is the explicit override for that case.
   */
  const [groupAll, setGroupAll] = useState(false);
  const [open, setOpen] = useState<Entry | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const done = entries.length + failures.length;
  const percent = files.length === 0 ? 0 : Math.round((done / files.length) * 100);

  const counts = useMemo(() => {
    const c = { pass: 0, review: 0, fail: 0 };
    for (const e of entries) {
      if (e.result.overall === 'pass') c.pass++;
      else if (e.result.overall === 'review') c.review++;
      else c.fail++;
    }
    return c;
  }, [entries]);

  const visible = useMemo(
    () => (filter === 'all' ? entries : entries.filter((e) => e.result.overall === filter)),
    [entries, filter],
  );

  /**
   * Images with no matching row in the manifest.
   *
   * Without this warning, a manifest whose fileName column does not match the
   * uploaded files runs silently and every label comes back with comparison
   * failures — which reads as "the tool is broken" rather than "the filenames
   * do not line up". Surfacing the mismatch before the run is the difference.
   */
  const unmatched = useMemo(() => {
    if (!manifest || files.length === 0) return [];
    const known = new Set(manifest.map((row) => row.fileName));
    return files.filter((file) => !known.has(file.name)).map((file) => file.name);
  }, [files, manifest]);

  /** Adds to the selection rather than replacing it; see SingleCheck. */
  function addFiles(picked: File[]) {
    setFiles((current) => {
      const seen = new Set(current.map((f) => `${f.name}:${f.size}`));
      return [...current, ...picked.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
    setEntries([]);
    setFailures([]);
    setSummary(null);
  }

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, i) => i !== index));
    setEntries([]);
    setFailures([]);
    setSummary(null);
  }

  async function run() {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    setEntries([]);
    setFailures([]);
    setSummary(null);
    setOpen(null);

    const controller = new AbortController();
    abortRef.current = controller;

    const body = new FormData();
    for (const file of files) body.append('images', file);
    if (groupAll) body.append('groupAll', 'true');
    if (manifest) {
      body.append(
        'applications',
        JSON.stringify(
          manifest.map((row) => ({
            fileName: row.fileName,
            applicationId: row.applicationId,
            beverageClass: row.beverageClass,
            brandName: row.brandName,
            classType: row.classType,
            alcoholContentAbv: row.alcoholContentAbv,
            netContentsMl: row.netContentsMl,
            bottlerNameAddress: row.bottlerNameAddress,
            countryOfOrigin: row.countryOfOrigin,
            isImport: row.isImport,
            alcoholContentOptional: row.alcoholContentOptional,
          })),
        ),
      );
    }

    try {
      const response = await fetch('/api/batch', {
        method: 'POST',
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error ?? `The batch could not be started (${response.status}).`);
      }
      if (!response.body) throw new Error('The server sent no results.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Read line-delimited JSON. A chunk boundary can land mid-line, so the
      // trailing partial line is always carried into the next read.
      while (true) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });

        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) handleLine(line);
        }
      }
      if (buffer.trim()) handleLine(buffer.trim());
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function handleLine(line: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === 'result') {
      setEntries((prev) => [
        ...prev,
        { fileName: message.fileName as string, result: message.result as VerifyResult },
      ]);
    } else if (message.type === 'error') {
      setFailures((prev) => [
        ...prev,
        { fileName: message.fileName as string, error: message.error as string },
      ]);
    } else if (message.type === 'summary') {
      setSummary(message as unknown as Summary);
    }
  }

  return (
    <>
      <div className="panel">
        <h2>1. Choose the label images</h2>
        <p className="hint" style={{ marginBottom: 18 }}>
          Select as many as you like — a whole importer submission at once is fine.
        </p>

        <ImageDrop
          multiple
          onFiles={addFiles}
          label={files.length > 0 ? 'Add more images' : 'Choose images'}
          hint={files.length > 0 ? undefined : 'Drag images here, or'}
        >
          {files.length > 0 && (
            <p className="file-name">
              {files.length} image{files.length === 1 ? '' : 's'} selected
            </p>
          )}
        </ImageDrop>

        {files.length > 0 && (
          <>
            <ul className="file-list" aria-label="Selected images">
              {files.map((file, index) => (
                <li key={`${file.name}-${file.size}`}>
                  <span className="name">{file.name}</span>
                  <button
                    type="button"
                    className="remove-inline"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => removeFile(index)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginTop: 12, minHeight: 48, padding: '10px 20px' }}
              onClick={() => {
                setFiles([]);
                setEntries([]);
                setFailures([]);
                setSummary(null);
              }}
            >
              Remove all {files.length} images
            </button>
          </>
        )}

        {files.length > 1 && (
          <div
            className="checkbox-row"
            style={{ marginTop: 18, padding: '4px 2px', alignItems: 'flex-start' }}
          >
            <input
              id="groupAll"
              type="checkbox"
              checked={groupAll}
              onChange={(e) => setGroupAll(e.target.checked)}
              style={{ marginTop: 12 }}
            />
            <label htmlFor="groupAll" style={{ fontWeight: 500 }}>
              These are all photographs of <strong>one</strong> label
              <br />
              <span className="hint" style={{ fontWeight: 400 }}>
                Tick this for the front and back of a single bottle. They will be read
                together, so information printed on one panel counts for the whole label.
                Leave it unticked when each image is a different label.
              </span>
            </label>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>2. Add the application details (optional)</h2>
        <p className="hint" style={{ marginBottom: 18 }}>
          A CSV with one row per label, including a <code>fileName</code> column that matches each
          image. Without it, labels are still read and checked for the mandatory elements, but
          nothing can be compared against an application.
        </p>

        <ImageDrop
          accept=".csv,text/csv"
          onFiles={async (picked) => {
            const csvFile = picked[0];
            if (!csvFile) return;
            try {
              const rows = parseManifest(await csvFile.text());
              setManifest(rows);
              setManifestName(`${csvFile.name} — ${rows.length} application rows`);
              setError(null);
            } catch {
              setError('That CSV could not be read.');
            }
          }}
          label={manifest ? 'Choose a different CSV' : 'Choose a CSV'}
          hint={manifest ? undefined : 'Drag a CSV here, or'}
        >
          {manifestName && <p className="file-name">{manifestName}</p>}
        </ImageDrop>
      </div>

      {unmatched.length > 0 && (
        <div className="notice error" role="alert">
          <strong>
            {unmatched.length === files.length
              ? 'None of these images match a row in the CSV.'
              : `${unmatched.length} of ${files.length} images do not match a row in the CSV.`}
          </strong>
          <br />
          The <code>fileName</code> column has to match the image filename exactly, including
          the extension. These images have no matching row:{' '}
          {unmatched.slice(0, 5).join(', ')}
          {unmatched.length > 5 && `, and ${unmatched.length - 5} more`}.
          {manifest && manifest.length > 0 && (
            <>
              <br />
              The CSV lists: {manifest.slice(0, 5).map((r) => r.fileName).join(', ')}
              {manifest.length > 5 && `, and ${manifest.length - 5} more`}.
            </>
          )}
          <br />
          You can still run this — the labels will be checked for the mandatory elements, but
          nothing can be compared against an application.
        </div>
      )}

      <button
        type="button"
        className="btn btn-primary btn-block"
        onClick={run}
        disabled={files.length === 0 || busy}
      >
        {busy && <span className="spinner" aria-hidden="true" />}
        {busy
          ? `Checking ${done} of ${files.length}…`
          : `Check ${files.length || ''} label${files.length === 1 ? '' : 's'}`.trim()}
      </button>

      {busy && (
        <>
          <button
            type="button"
            className="btn btn-secondary btn-block"
            style={{ marginTop: 12 }}
            onClick={() => abortRef.current?.abort()}
          >
            Stop
          </button>
          <div className="progress-wrap">
            <div
              className="progress-bar"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Batch progress"
            >
              <span style={{ width: `${percent}%` }} />
            </div>
            <p className="progress-label" aria-live="polite">
              {done} of {files.length} finished
            </p>
          </div>
        </>
      )}

      {error && (
        <div className="notice error" role="alert">
          <strong>Could not run this batch.</strong>
          <br />
          {error}
        </div>
      )}

      {(entries.length > 0 || failures.length > 0) && (
        <div className="panel">
          <h2>Results</h2>

          <div className="summary-tiles">
            <div className="tile pass">
              <div className="n">{counts.pass}</div>
              <div className="k">No problems found</div>
            </div>
            <div className="tile review">
              <div className="n">{counts.review}</div>
              <div className="k">Need your judgement</div>
            </div>
            <div className="tile fail">
              <div className="n">{counts.fail}</div>
              <div className="k">Problems found</div>
            </div>
            <div className="tile">
              <div className="n">{failures.length}</div>
              <div className="k">Could not be read</div>
            </div>
          </div>

          {summary && (
            <p className="meta-line">
              {summary.total} labels in {(summary.elapsedMs / 1000).toFixed(1)} seconds —{' '}
              {(summary.elapsedMs / 1000 / Math.max(1, summary.total)).toFixed(1)}s per label at{' '}
              {summary.concurrency} at a time.
            </p>
          )}

          <div className="filters" role="group" aria-label="Filter results">
            {(
              [
                ['all', `Show all (${entries.length})`],
                ['fail', `Problems (${counts.fail})`],
                ['review', `Needs review (${counts.review})`],
                ['pass', `Passed (${counts.pass})`],
              ] as Array<[Filter, string]>
            ).map(([key, text]) => (
              <button
                key={key}
                type="button"
                className="filter-btn"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {text}
              </button>
            ))}

            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginLeft: 'auto', minHeight: 48, padding: '10px 20px' }}
              onClick={() =>
                downloadCsv(
                  `ttb-label-check-${new Date().toISOString().slice(0, 10)}.csv`,
                  resultsToCsv(entries),
                )
              }
              disabled={entries.length === 0}
            >
              Download as CSV
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              style={{ minHeight: 48, padding: '10px 20px' }}
              onClick={() =>
                downloadJson(
                  `ttb-label-check-${new Date().toISOString().slice(0, 10)}.json`,
                  resultsToJson(entries),
                )
              }
              disabled={entries.length === 0}
            >
              Download full records
            </button>
          </div>

          <table>
            <caption className="visually-hidden">Batch verification results</caption>
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">File</th>
                <th scope="col">Application</th>
                <th scope="col">Result</th>
                <th scope="col">What was found</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => (
                <tr key={entry.fileName}>
                  <td>
                    <img className="thumb" src={entry.result.thumbnailDataUrl} alt="" />
                  </td>
                  <td style={{ wordBreak: 'break-all' }}>{entry.fileName}</td>
                  <td>{entry.result.applicationId}</td>
                  <td>
                    <span className={`badge ${entry.result.overall}`}>
                      {VERDICT_MARKS[entry.result.overall]} {labelFor(entry.result.overall)}
                    </span>
                  </td>
                  <td>{entry.result.headline}</td>
                  <td>
                    <button type="button" className="row-btn" onClick={() => setOpen(entry)}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
              {failures.map((failure) => (
                <tr key={failure.fileName}>
                  <td />
                  <td style={{ wordBreak: 'break-all' }}>{failure.fileName}</td>
                  <td>—</td>
                  <td>
                    <span className="badge fail">✕ Error</span>
                  </td>
                  <td colSpan={2}>{failure.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div className="panel">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
            <h2 style={{ marginBottom: 8 }}>{open.fileName}</h2>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginLeft: 'auto', minHeight: 48, padding: '10px 20px' }}
              onClick={() => setOpen(null)}
            >
              Close
            </button>
          </div>
          <VerdictBanner verdict={open.result.overall} headline={open.result.headline} />
          {[...open.result.checks]
            .sort((a, b) => rank(a.verdict) - rank(b.verdict))
            .map((check: CheckResult) => (
              <CheckCard key={check.id} check={check} />
            ))}
        </div>
      )}
    </>
  );
}

function rank(verdict: string): number {
  return { fail: 0, review: 1, pass: 2, not_compared: 3, not_applicable: 4 }[verdict] ?? 5;
}

function labelFor(verdict: Verdict): string {
  return {
    pass: 'Passed',
    review: 'Review',
    fail: 'Problem',
    not_applicable: 'N/A',
    not_compared: 'Not compared',
  }[verdict];
}
