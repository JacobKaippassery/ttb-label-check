import { useEffect, useState } from 'react';
import type { ApplicationForm, VerifyResult } from '../types.ts';
import { SAMPLE_APPLICATION, toApplicationPayload } from '../types.ts';
import { downloadCsv, downloadJson, resultsToCsv, resultsToJson } from '../csv.ts';
import { ApplicationFields } from './ApplicationFields.tsx';
import { ImageDrop } from './ImageDrop.tsx';
import { VerdictBanner } from './VerdictBanner.tsx';
import { CheckCard } from './CheckCard.tsx';

export function SingleCheck() {
  const [application, setApplication] = useState<ApplicationForm>(SAMPLE_APPLICATION);
  // Several photographs of ONE label. A bottle's front and back are panels of a
  // single submission, and the mandatory elements are spread across them.
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);

  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviewUrls(urls);
    return () => urls.forEach(URL.revokeObjectURL);
  }, [files]);

  /**
   * Picking images adds to the selection rather than replacing it, so a front
   * and a back can be gathered in separate trips through the file dialog.
   * Removal is per-image, which is what makes adding safe: a wrong photo is
   * deleted, not worked around by starting over.
   *
   * Deduplicated by name and size — re-picking the same file is a common slip
   * and silently duplicating a panel would double-count it in the merge.
   */
  function addFiles(picked: File[]) {
    setFiles((current) => {
      const seen = new Set(current.map((f) => `${f.name}:${f.size}`));
      return [...current, ...picked.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
    setResult(null);
    setError(null);
  }

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, i) => i !== index));
    setResult(null);
    setError(null);
  }

  async function check() {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    setResult(null);

    const body = new FormData();
    for (const file of files) body.append('image', file);
    body.append('application', JSON.stringify(toApplicationPayload(application)));

    try {
      const response = await fetch('/api/verify', { method: 'POST', body });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'The check could not be completed.');
      setResult(payload as VerifyResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Sorted so anything requiring action is at the top of the page, and the
  // items that merely need a glance sink to the bottom.
  const ordered = result
    ? [...result.checks].sort((a, b) => rank(a.verdict) - rank(b.verdict))
    : [];

  return (
    <>
      <div className="two-col">
        <div className="panel">
          <h2>1. The application</h2>
          <p className="hint" style={{ marginBottom: 20 }}>
            What the applicant submitted. In production this comes from COLA.
          </p>
          <ApplicationFields value={application} onChange={setApplication} disabled={busy} />
        </div>

        <div className="panel">
          <h2>2. The label</h2>
          <p className="hint" style={{ marginBottom: 20 }}>
            Photographs or scans of the label artwork. If the label wraps around the bottle,
            add the front and the back together — they are checked as one label, because the
            required information is spread across both.
          </p>

          <ImageDrop
            multiple
            onFiles={addFiles}
            label={files.length > 0 ? 'Add more images' : 'Choose images'}
            hint={files.length > 0 ? undefined : 'Drag images here, or'}
          >
            {previewUrls.length > 0 && (
              <div className="panel-grid">
                {files.map((file, i) => (
                  <div className="panel-thumb" key={`${file.name}-${file.size}`}>
                    <img
                      src={previewUrls[i]}
                      alt={`Label panel ${i + 1} of ${files.length}: ${file.name}`}
                    />
                    <span className="caption">{file.name}</span>
                    <button
                      type="button"
                      className="remove-btn"
                      aria-label={`Remove ${file.name}`}
                      title={`Remove ${file.name}`}
                      onClick={() => removeFile(i)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            {files.length > 1 && (
              <p className="file-name">{files.length} panels of one label</p>
            )}
          </ImageDrop>

          <button
            type="button"
            className="btn btn-primary btn-block"
            style={{ marginTop: 22 }}
            onClick={check}
            disabled={files.length === 0 || busy}
          >
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? 'Checking…' : 'Check this label'}
          </button>
        </div>
      </div>

      <div aria-live="polite">
        {error && (
          <div className="notice error" role="alert">
            <strong>Could not check this label.</strong>
            <br />
            {error}
          </div>
        )}

        {result && (
          <>
            <VerdictBanner verdict={result.overall} headline={result.headline} />

            {ordered.some((c) => c.verdict === 'not_compared') && (
              <div className="notice info">
                <strong>
                  {ordered.filter((c) => c.verdict === 'not_compared').length} item
                  {ordered.filter((c) => c.verdict === 'not_compared').length === 1 ? '' : 's'}{' '}
                  could not be compared against an application.
                </strong>
                <br />
                Those fields were read off the label but there was nothing to check them
                against. Fill in the application details above and check again to compare
                them. Everything else below was fully checked.
              </div>
            )}

            <div className="panel">
              <h2>
                What was checked
                {result.isDemo && (
                  <span className="badge fail" style={{ marginLeft: 12, verticalAlign: 'middle' }}>
                    Demo data
                  </span>
                )}
              </h2>
              {ordered.map((check) => (
                <CheckCard key={check.id} check={check} />
              ))}

              <div
                style={{
                  display: 'flex',
                  gap: 12,
                  flexWrap: 'wrap',
                  marginTop: 20,
                  paddingTop: 20,
                  borderTop: '1px solid var(--line)',
                }}
              >
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ minHeight: 48, padding: '10px 20px' }}
                  onClick={() =>
                    downloadCsv(
                      `${downloadStem(result, files)}.csv`,
                      resultsToCsv([{ fileName: panelNames(result, files), result }]),
                    )
                  }
                >
                  Download as CSV
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ minHeight: 48, padding: '10px 20px' }}
                  onClick={() =>
                    downloadJson(
                      `${downloadStem(result, files)}.json`,
                      resultsToJson([{ fileName: panelNames(result, files), result }]),
                    )
                  }
                >
                  Download full record
                </button>
                <span className="hint" style={{ alignSelf: 'center' }}>
                  The full record keeps the verbatim transcription and every citation, for
                  the file.
                </span>
              </div>

              <p className="meta-line">
                Checked in {(result.timings.totalMs / 1000).toFixed(1)} seconds using {result.model}.
                Reading the label took {(result.timings.extractionMs / 1000).toFixed(1)}s; applying
                the rules took {result.timings.rulesMs}ms.
                {result.imageTransformations.length > 0 && (
                  <> Image adjustments: {result.imageTransformations.join('; ')}.</>
                )}
              </p>
            </div>

            <details className="panel">
              <summary style={{ cursor: 'pointer', fontWeight: 700, minHeight: 44 }}>
                Show the raw transcription
              </summary>
              <p className="hint" style={{ marginTop: 12 }}>
                Exactly what was read off the label, before any rules were applied. Every finding
                above traces back to this.
              </p>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: '#f7f9fb',
                  padding: 16,
                  borderRadius: 8,
                  fontSize: '0.85rem',
                }}
              >
                {JSON.stringify(result.extraction, null, 2)}
              </pre>
            </details>
          </>
        )}
      </div>
    </>
  );
}

function rank(verdict: string): number {
  // Problems first, then judgement calls, then things that were actually
  // verified. "Not compared" sinks to the bottom with the non-findings.
  return { fail: 0, review: 1, pass: 2, not_compared: 3, not_applicable: 4 }[verdict] ?? 5;
}

function panelNames(result: VerifyResult, files: File[]): string {
  const names = result.panels?.map((p) => p.fileName) ?? files.map((f) => f.name);
  return names.join(' + ');
}

/** Names the download after the application, falling back to the filename. */
function downloadStem(result: VerifyResult, files: File[]): string {
  const base =
    result.applicationId && result.applicationId !== 'unspecified'
      ? result.applicationId
      : (files[0]?.name.replace(/\.[^.]+$/, '') ?? 'label');
  return `ttb-label-check-${base}`.replace(/[^a-z0-9._-]/gi, '-');
}
