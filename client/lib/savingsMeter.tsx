'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Savings meter: a custom AG Studio widget for ProcureAI.
 * It maps two numeric fields (amount saved vs list price, amount paid) and shows how much of the list price was saved.
 * Registered in Insights.tsx only when NEXT_PUBLIC_CUSTOM_WIDGET=true.
 */

type FieldRef = { id: string; aggregation?: string };

// A response row may be an array or an object depending on the data engine, so read it defensively.
function cell(row: any, field: FieldRef, index: number): unknown {
  if (Array.isArray(row)) return row[index];
  if (row && typeof row === 'object') return field.id in row ? row[field.id] : Object.values(row)[index];
  return row;
}

let loggedShape = false;

function SavingsMeter({ dataMapping, widgetApi }: any) {
  const saved: FieldRef | undefined = dataMapping?.saved?.[0];
  const spent: FieldRef | undefined = dataMapping?.spent?.[0];
  const [view, setView] = useState<{ savedText: string; spentText: string; pct: number } | null>(null);
  const hasLoaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (!saved || !spent) {
      widgetApi.setDisplayState('incompleteDataMapping');
      return;
    }
    (async () => {
      try {
        widgetApi.setDisplayState('loading', { prominent: !hasLoaded.current });
        const response = await widgetApi.getData({ fields: [saved, spent] }, { queryId: 'savings-meter' });
        if (cancelled || response?.replaced) return;
        const row = response?.results?.rows?.[0];
        if (!loggedShape) {
          loggedShape = true;
          console.debug('[savings-meter] first data row', row);
        }
        const s = Number(cell(row, saved, 0));
        const p = Number(cell(row, spent, 1));
        if (!row || !Number.isFinite(s) || !Number.isFinite(p)) {
          widgetApi.setDisplayState('noData');
          return;
        }
        const listTotal = s + p; // list price total = what was paid + what was saved
        const pct = listTotal > 0 ? Math.min(100, Math.max(0, (s / listTotal) * 100)) : 0;
        const fmt = (f: FieldRef, v: number) => {
          try {
            return String(widgetApi.formatFieldValue(f, v));
          } catch {
            return v.toFixed(2);
          }
        };
        hasLoaded.current = true;
        setView({ savedText: fmt(saved, s), spentText: fmt(spent, p), pct });
        widgetApi.setDisplayState('displayed');
      } catch (e) {
        console.warn('[savings-meter] could not load data', e);
        if (!cancelled) widgetApi.setDisplayState('noData');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [widgetApi, dataMapping]);

  if (!view) return null;
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

export const savingsMeterWidget: any = {
  id: 'savings-meter',
  label: 'Savings meter',
  icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="9" width="18" height="6" rx="3"/><path d="M3 12h10" stroke-width="6"/></svg>',
  dataMapping: {
    saved: { type: 'field', supportedRoles: ['numeric'], required: true, aiDescription: 'Numeric field with the amount saved versus list price.' },
    spent: { type: 'field', supportedRoles: ['numeric'], required: true, aiDescription: 'Numeric field with the amount actually paid.' },
  },
  comp: SavingsMeter,
  minSize: { width: 200, height: 100 },
};