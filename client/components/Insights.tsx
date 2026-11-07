'use client';
import { studioTheme, enableStudioDevValidations } from 'ag-studio';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { useMemo, useState } from 'react';
import type { ProposalRow } from '@/lib/api';
import { buildData, buildInitialState, sampleRows, toInsightRows } from '@/lib/insights';

if (process.env.NODE_ENV !== 'production') enableStudioDevValidations(); // extra checks while developing

const LICENSE = process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE || '';

// Studio's prop types are very strict (for example field formats must be exact literals) and it validates its input at
// runtime anyway, so the components are used loosely typed here. Problems show up as clear messages in the console.
const Studio: any = AgStudio;
const Provider: any = AgStudioProvider;

export default function Insights({ proposals }: { proposals: ProposalRow[] }) {
  const real = useMemo(() => toInsightRows(proposals), [proposals]);
  const [sample, setSample] = useState<boolean | null>(null); // null = decide automatically
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const useSample = sample ?? real.length === 0;
  const rows = useMemo(() => (useSample ? sampleRows() : real), [useSample, real]);

  const data: any = useMemo(() => buildData(rows), [rows]);
  // Typed loosely on purpose: Studio validates the state at runtime and reports problems in the console.
  const initialState: any = useMemo(() => buildInitialState(), []);
  const theme = useMemo(
    () =>
      studioTheme.withParams({
        accentColor: '#c2185b', // rani pink
        backgroundColor: '#ffffff',
        foregroundColor: '#1f1b4d', // deep indigo
        borderColor: '#d9d4ec',
        fontFamily: 'var(--font-ui), system-ui, sans-serif',
        spacing: 7,
      }),
    [],
  );

  const studio = (
    <div className="insights-studio">
      <Studio
        key={useSample ? 'sample' : 'real'} // start fresh when switching data
        data={data}
        initialState={initialState}
        mode={mode}
        theme={theme}
      />
    </div>
  );

  return (
    <section aria-label="Insights">
      <div className="insights-head">
        <p className="hint">
          {useSample
            ? 'Showing sample data, because this account has no proposals yet. Create one and switch to your own data.'
            : 'Live view of your proposals. Charts update as you approve and pay.'}
        </p>
        <div className="insights-actions">
          {real.length > 0 && (
            <button className="btn ghost small" onClick={() => setSample(!useSample)}>
              {useSample ? 'Use my data' : 'Show sample data'}
            </button>
          )}
          <button className="btn small" onClick={() => setMode(mode === 'view' ? 'edit' : 'view')}>
            {mode === 'view' ? 'Customize dashboard' : 'Done editing'}
          </button>
        </div>
      </div>
      <div className="insights-frame">{LICENSE ? <Provider licenseKey={LICENSE}>{studio}</Provider> : studio}</div>
    </section>
  );
}
