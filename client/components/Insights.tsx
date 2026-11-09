'use client';
import { AgStudioAiModule, AgStudioModuleRegistry, createAiHarness, studioTheme, enableStudioDevValidations } from 'ag-studio';
import { AgStudio, AgStudioProvider, createWidgets } from 'ag-studio-react';
import { savingsMeterWidget } from '@/lib/savingsMeter';
import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ProposalRow } from '@/lib/api';
import { geminiProxyAdapter } from '@/lib/geminiProxyAdapter';
import { buildData, buildInitialState, sampleRows, toInsightRows, type InsightRow } from '@/lib/insights';
import { setInsightRows } from '@/lib/insightsStore';

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

/**
 * Safe-mode ladder. Level 0 = everything on. If Studio crashes, or is still showing its loading spinner after 15 s,
 * the next level switches off one more optional piece: 1 = custom widget off, 2 = AI assistant off, 3 = give up and say so.
 * Levels for features that are not enabled are skipped.
 */
const nextLevel = (l: number) => {
  let n = l + 1;
  while (n < 3 && ((n === 1 && !CUSTOM_WIDGET) || (n === 2 && !STUDIO_AI))) n++;
  return Math.min(n, 3);
};

/** If Studio rejects the custom widget and crashes, drop the widget and show the plain dashboard instead of a dead tab. */
class StudioBoundary extends Component<{ onError: () => void; fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error('[insights] AG Studio crashed:', err);
    this.props.onError();
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

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
  const [level, setLevel] = useState(0); // safe-mode level, see nextLevel()
  const customOk = CUSTOM_WIDGET && level < 1;
  const aiOn = STUDIO_AI && level < 2;
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (level >= 3) return;
    const t = setTimeout(() => {
      if (/loading/i.test(frameRef.current?.innerText ?? '')) {
        console.warn(`[insights] Studio still loading after 15 s at safe-mode level ${level}; trying a simpler setup.`);
        setLevel(nextLevel);
      }
    }, 15000);
    return () => clearTimeout(t);
  }, [level, useSample]);
  // Studio can fail inside its own async set-up (an unhandled promise rejection in `resetWidgets`), which no React error boundary sees
  // and which leaves the spinner up forever. Catch it and step down to a simpler setup straight away instead of waiting.
  const lastStep = useRef(0);
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      const text = String((e.reason as any)?.stack ?? e.reason ?? '');
      if (!/resetWidgets/.test(text) || Date.now() - lastStep.current < 3000) return;
      lastStep.current = Date.now();
      console.warn('[insights] AG Studio failed while setting up its widgets; trying a simpler setup.', e.reason);
      setLevel(nextLevel);
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, []);
  const initialState: any = useMemo(() => buildInitialState(customOk), [customOk]);
  // The custom widget can read the same rows as the dashboard (used as a fallback if its own query is slow).
  useLayoutEffect(() => setInsightRows(rows), [rows]);
  // Without the flag there is no `ai` prop, so there is no chat panel and the page is exactly as before.
  const ai: any = useMemo(() => {
    if (!aiOn) return undefined;
    const adapter = geminiProxyAdapter();
    return ({ api }: any) =>
      createAiHarness(api, {
        adapter,
        promptStarters: [
          { label: 'What can I chart?', prompt: 'What tables and fields does this dashboard have available?' },
          { label: 'Spend by merchant', prompt: 'Add a chart of total spend by merchant.' },
        ],
      });
  }, [aiOn]);
  // Without the flag no `widgets` prop is passed, so Studio keeps its normal widget set.
  const widgets: any = useMemo(
    () =>
      customOk
        ? (widgetConfig: any) =>
            (createWidgets as any)({
              additionalTypes: [savingsMeterWidget],
              menu: [...widgetConfig.menu, { label: 'ProcureAI', widgetIds: ['savings-meter'] }],
            })
        : undefined,
    [customOk],
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
      <StudioBoundary
        key={`${useSample ? 'sample' : 'real'}-L${level}`} // start fresh when switching data or safe-mode level
        onError={() => setLevel(nextLevel)}
        fallback={<p className="hint">The dashboard could not load. Press F12 and check the Console for the reason.</p>}
      >
        <Studio data={data} initialState={initialState} mode={mode} theme={theme} ai={ai} widgets={widgets} />
      </StudioBoundary>
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
      {level > 0 && level < 3 && (
        <p className="hint" role="status">
          Safe mode: {level === 1 ? 'the custom widget is off' : 'the custom widget and the AI assistant are off'}, because the dashboard took too long to load.
        </p>
      )}
      {level >= 3 && (
        <p className="hint" role="alert">
          The dashboard still did not load. Press F12, open Console, and look for the red error.
        </p>
      )}
      <div ref={frameRef} className={`insights-frame${mode === 'edit' ? ' editing' : ''}`}>{LICENSE ? <Provider licenseKey={LICENSE}>{studio}</Provider> : studio}</div>
    </section>
  );
}
