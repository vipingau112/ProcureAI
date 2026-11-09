'use client';
import { AgStudioAiModule, AgStudioModuleRegistry, createAiHarness, studioTheme, enableStudioDevValidations } from 'ag-studio';
import { AgStudio, AgStudioProvider, createWidgets } from 'ag-studio-react';
import { savingsMeterWidget } from '@/lib/savingsMeter';
import { useMemo, useState } from 'react';
import type { ProposalRow } from '@/lib/api';
import { geminiProxyAdapter } from '@/lib/geminiProxyAdapter';
import { buildData, buildInitialState, sampleRows, toInsightRows, type InsightRow } from '@/lib/insights';

if (process.env.NODE_ENV !== 'production') enableStudioDevValidations(); // extra checks while developing

const LICENSE = process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE || '';

// Studio Agent Framework (chat panel). Off by default: set NEXT_PUBLIC_STUDIO_AI=true and redeploy the web service to turn it on.
const STUDIO_AI = process.env.NEXT_PUBLIC_STUDIO_AI === 'true';
// Custom widget (Savings meter). Off by default: set NEXT_PUBLIC_CUSTOM_WIDGET=true and redeploy the web service to turn it on.
const CUSTOM_WIDGET = process.env.NEXT_PUBLIC_CUSTOM_WIDGET === 'true';
if (STUDIO_AI) AgStudioModuleRegistry.registerModules([AgStudioAiModule]);

// Studio's prop types are very strict (for example field formats must be exact literals) and it validates its input at
// runtime anyway, so the components are used loosely typed here. Problems show up as clear messages in the console.
const Studio: any = AgStudio;
const Provider: any = AgStudioProvider;

export default function Insights({ proposals }: { proposals: ProposalRow[] }) {
  // The page refreshes /api/state every 1.5 s, which hands us a brand-new `proposals` array each time even when nothing
  // changed. Passing a new `data` object to Studio that often re-ingests the data and can interrupt the AI agent while it
  // is building a widget. So compare by content: `real` only gets a new identity when a proposal really changed.
  const realSig = JSON.stringify(toInsightRows(proposals));
  const real = useMemo(() => JSON.parse(realSig) as InsightRow[], [realSig]);
  const [sample, setSample] = useState<boolean | null>(null); // null = decide automatically
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const useSample = sample ?? real.length === 0;
  const rows = useMemo(() => (useSample ? sampleRows() : real), [useSample, real]);

  const data: any = useMemo(() => buildData(rows), [rows]);
  // Typed loosely on purpose: Studio validates the state at runtime and reports problems in the console.
  const initialState: any = useMemo(() => buildInitialState(CUSTOM_WIDGET), []);
  // Without the flag there is no `ai` prop, so there is no chat panel and the page is exactly as before.
  const ai: any = useMemo(() => {
    if (!STUDIO_AI) return undefined;
    const adapter = geminiProxyAdapter();
    return ({ api }: any) =>
      createAiHarness(api, {
        adapter,
        promptStarters: [
          { label: 'What can I chart?', prompt: 'What tables and fields does this dashboard have available?' },
          { label: 'Spend by merchant', prompt: 'Add a chart of total spend by merchant.' },
        ],
      });
  }, []);
  // Without the flag no `widgets` prop is passed, so Studio keeps its normal widget set.
  const widgets: any = useMemo(
    () =>
      CUSTOM_WIDGET
        ? (widgetConfig: any) =>
            (createWidgets as any)({
              additionalTypes: [savingsMeterWidget],
              menu: [...widgetConfig.menu, { label: 'ProcureAI', widgetIds: ['savings-meter'] }],
            })
        : undefined,
    [],
  );
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
        ai={ai}
        widgets={widgets}
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
      <div className={`insights-frame${mode === 'edit' ? ' editing' : ''}`}>{LICENSE ? <Provider licenseKey={LICENSE}>{studio}</Provider> : studio}</div>
    </section>
  );
}
