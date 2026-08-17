import type { CheckResult } from '../types.ts';
import { VERDICT_WORDS } from '../types.ts';

/**
 * One compliance check, rendered so an agent can confirm or overrule it without
 * opening anything else.
 *
 * Every card shows what the application said next to what the label said. That
 * side-by-side is the whole job Sarah described — "making sure the number on
 * the form is the same as the number on the label" — so it is never hidden
 * behind a disclosure control.
 */
export function CheckCard({ check }: { check: CheckResult }) {
  const showComparison = check.expected != null || check.found != null;

  return (
    <section className={`check ${check.verdict}`}>
      <div className="check-head">
        <h3>{check.title}</h3>
        {/*
          An item that only needs confirming is not a finding against the label,
          so it is badged for what it is instead of carrying "Needs review"
          alongside — two badges saying different things invited the reading
          that something had gone wrong.
        */}
        <span className={`badge ${check.requiresAgentConfirmation ? 'not_compared' : check.verdict}`}>
          {check.requiresAgentConfirmation ? 'Confirm by eye' : VERDICT_WORDS[check.verdict]}
        </span>
      </div>

      <p className="check-summary">{check.summary}</p>

      {showComparison && (
        <div className="compare">
          <div className="cell">
            <h4>Application says</h4>
            <p className={check.expected ? '' : 'empty'}>{check.expected ?? 'Nothing recorded'}</p>
          </div>
          <div className="cell">
            <h4>Label says</h4>
            <p className={check.found ? '' : 'empty'}>{check.found ?? 'Not found on the label'}</p>
          </div>
        </div>
      )}

      {check.diff && check.diff.length > 0 && (
        <>
          <div className="diff">
            {check.diff.map((segment, index) => (
              <span key={index} className={segment.kind}>
                {segment.text}
              </span>
            ))}
          </div>
          <p className="diff-key">
            <strong>Struck through</strong> = required wording that is missing.{' '}
            <strong>Highlighted</strong> = wording on the label that should not be there.
          </p>
        </>
      )}

      {check.detail && <p className="check-detail">{check.detail}</p>}
      {check.citation && <p className="citation">{check.citation}</p>}
    </section>
  );
}
