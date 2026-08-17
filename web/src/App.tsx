import { useEffect, useState } from 'react';
import { SingleCheck } from './components/SingleCheck.tsx';
import { BatchCheck } from './components/BatchCheck.tsx';

interface Health {
  apiKeyConfigured: boolean;
  demoMode: boolean;
  canRun: boolean;
  model: string;
  effort: string;
  batchConcurrency: number;
}

type Tab = 'single' | 'batch';

export function App() {
  const [tab, setTab] = useState<Tab>('single');
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <header className="masthead">
        <div className="masthead-inner">
          <h1>TTB Label Check</h1>
          <span className="tagline">Compare a label against its application</span>
          {health && (
            <span className="model-badge">
              {health.model} · effort {health.effort} · {health.batchConcurrency} at a time
            </span>
          )}
        </div>
      </header>

      <main id="main">
        {health && health.demoMode && (
          <div className="notice error" role="alert">
            <strong>Demo mode — these are stored results, not real readings.</strong>
            <br />
            No label is being read and no API call is being made. Every result comes from a
            transcription recorded earlier for the sample labels. Set <code>DEMO_MODE=false</code>{' '}
            and add an API key to check real labels.
          </div>
        )}

        {health && !health.canRun && (
          <div className="notice error" role="alert">
            <strong>No API key is configured.</strong>
            <br />
            Copy <code>.env.example</code> to <code>.env</code> and add your Anthropic API key, or
            set <code>DEMO_MODE=true</code> to explore the tool with the sample labels.
          </div>
        )}

        <div className="notice info">
          <strong>This is a prototype and it does not make decisions.</strong>
          <br />
          Every result is a suggestion for an agent to confirm or overrule. Nothing here is filed,
          stored, or sent to COLA.
        </div>

        <div className="tabs" role="tablist" aria-label="Verification mode">
          <button
            type="button"
            className="tab"
            role="tab"
            id="tab-single"
            aria-selected={tab === 'single'}
            aria-controls="panel-single"
            onClick={() => setTab('single')}
          >
            One label
          </button>
          <button
            type="button"
            className="tab"
            role="tab"
            id="tab-batch"
            aria-selected={tab === 'batch'}
            aria-controls="panel-batch"
            onClick={() => setTab('batch')}
          >
            Many labels at once
          </button>
        </div>

        {tab === 'single' ? (
          <div role="tabpanel" id="panel-single" aria-labelledby="tab-single">
            <SingleCheck />
          </div>
        ) : (
          <div role="tabpanel" id="panel-batch" aria-labelledby="tab-batch">
            <BatchCheck />
          </div>
        )}
      </main>
    </>
  );
}
