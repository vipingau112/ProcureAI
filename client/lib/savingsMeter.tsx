'use client';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getInsightRows, subscribeInsightRows } from './insightsStore';

/**
 * Savings meter: a custom AG Studio widget for ProcureAI.
 * It maps two numeric fields (amount saved vs list price, amount paid) and shows how much of the list price was saved.
 * Registered in Insights.tsx only when NEXT_PUBLIC_CUSTOM_WIDGET=true.
 *
 * It never leaves Studio stuck on its loading spinner: the query result is used when it arrives, and if it is slow
 * (6 s) or comes back in an unexpected shape, the widget falls back to the rows the dashboard already holds.
 */

type FieldRef = { id: string; aggregation?: string };
type Totals = { saved: number; spent: number; savedText?: string; spentText?: string };

// A response row may be an array or an object depending on the data engine, so read it defensively.
function cell(row: any, field: FieldRef, index: number): unknown {
  if (Array.isArray(row)) return row[index];
  if (row && typeof row === 'object') return field.id in row ? row[field.id] : Object.values(row)[index];
  return row;
}

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T | null> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

function SavingsMeter({ dataMapping, widgetApi }: any) {
  const saved: FieldRef | undefined = dataMapping?.saved?.[0];
  const spent: FieldRef | undefined = dataMapping?.spent?.[0];
  // Studio may hand over a new dataMapping object on every render. Depend on its content, not its identity, or the effect
  // below restarts forever and each query is replaced by the next one before it ever finishes.
  const mappingKey = JSON.stringify([saved ?? null, spent ?? null]);
  const apiRef = useRef(widgetApi);
  apiRef.current = widgetApi;
  const run = useRef(0);
  const [fromQuery, setFromQuery] = useState<Totals | null>(null);
  const rows = useSyncExternalStore(subscribeInsightRows, getInsightRows, getInsightRows);

  useEffect(() => {
    const api = apiRef.current;
    const mine = ++run.current;
    const stale = () => mine !== run.current;
    if (!saved || !spent) {
      api.setDisplayState('incompleteDataMapping');
      return () => { run.current++; };
    }
    (async () => {
      try {
        api.setDisplayState('loading', { prominent: false }); // a slow query must never hide the widget
        const response: any = await withTimeout(api.getData({ fields: [saved, spent] }), 6000);
        if (stale()) return;
        const row = response?.results?.rows?.[0];
        const s = Number(cell(row, saved, 0));
        const p = Number(cell(row, spent, 1));
        if (row && Number.isFinite(s) && Number.isFinite(p)) {
          const fmt = (f: FieldRef, v: number) => {
            try { return String(api.formatFieldValue(f, v)); } catch { return usd(v); }
          };
          setFromQuery({ saved: s, spent: p, savedText: fmt(saved, s), spentText: fmt(spent, p) });
        } else {
          console.warn('[savings-meter] no usable query result, using the dashboard rows instead', response);
          setFromQuery(null);
        }
      } catch (e) {
        if (stale()) return;
        console.warn('[savings-meter] query failed, using the dashboard rows instead', e);
        setFromQuery(null);
      } finally {
        if (!stale()) api.setDisplayState('displayed'); // always leave the loading state
      }
    })();
    return () => { run.current++; };
  }, [mappingKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals: Totals | null = useMemo(() => {
    if (fromQuery) return fromQuery;
    if (!rows.length) return null;
    return { saved: rows.reduce((a, r) => a + r.savings, 0), spent: rows.reduce((a, r) => a + r.total, 0) };
  }, [fromQuery, rows]);

  if (!totals) return <div style={{ padding: '10px 18px', fontSize: 13, opacity: 0.7 }}>No data yet.</div>;
  const listTotal = totals.saved + totals.spent; // list price total = what was paid + what was saved
  const pct = listTotal > 0 ? Math.min(100, Math.max(0, (totals.saved / listTotal) * 100)) : 0;
  const view = { pct, savedText: totals.savedText ?? usd(totals.saved), spentText: totals.spentText ?? usd(totals.spent) };
  const accent = 'var(--ag-accent-color, #c2185b)';
  return (
    <div style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10, padding: '10px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Savings meter</div>
        <div style={{ fontSize: 30, fontWeight: 700, color: accent }}>{view.pct.toFixed(1)}%</div>
      </div>
      <div
        role="meter"
        aria-label="Share of the list price saved"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(view.pct)}
        style={{ height: 16, borderRadius: 8, overflow: 'hidden', background: 'var(--ag-border-color, #d9d4ec)' }}
      >
        <div style={{ width: `${view.pct > 0 ? Math.max(view.pct, 2) : 0}%`, height: '100%', background: accent, transition: 'width 0.6s ease' }} />
      </div>
      <div style={{ fontSize: 13, opacity: 0.85 }}>
        Saved <strong>{view.savedText}</strong> against list prices, paid {view.spentText} for the same items.
      </div>
    </div>
  );
}

// Shaped exactly like AG Studio's documented custom widget example: data mapping with `requires`, a `form`, sizes and AI text.
export const savingsMeterWidget: any = {
  id: 'savings-meter',
  icon: { url: 'https://www.ag-grid.com/studio/images/brandmark.svg' },
  label: 'Savings meter',
  dataMapping: {
    saved: { type: 'field', supportedRoles: ['numeric'], requires: { cardinality: 'one' }, required: true },
    spent: { type: 'field', supportedRoles: ['numeric'], requires: { cardinality: 'one' }, required: true },
  },
  form: (params: any) =>
    params.createDefaults({
      dataMappingItems: [
        { key: 'saved', label: 'Saved vs list price' },
        { key: 'spent', label: 'Amount paid' },
      ],
    }),
  comp: SavingsMeter,
  defaultSize: { width: 400, height: 200 },
  minSize: { width: 200, height: 100 },
  ai: {
    description: 'Shows what share of the list price was saved, from an amount-saved field and an amount-paid field.',
  },
};