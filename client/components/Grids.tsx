'use client';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ICellRendererParams } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useEffect, useMemo, useState } from 'react';
import { usd, type InventoryRow, type ProposalRow } from '@/lib/api';
import { formatMoney } from '@/lib/money';

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  backgroundColor: '#ffffff',
  foregroundColor: '#1f1b4d',
  headerBackgroundColor: '#efeaf8',
  headerFontWeight: 600,
  borderColor: '#d9d4ec',
  accentColor: '#c2185b',
  fontFamily: 'var(--font-ui), system-ui, sans-serif',
  fontSize: 14,
  borderRadius: 4,
  wrapperBorderRadius: 6,
});

const STATUS_LABEL: Record<ProposalRow['status'], string> = {
  pending: 'Needs approval',
  awaiting_payment: 'Awaiting payment',
  paid: 'Paid',
  rejected: 'Rejected',
  failed: 'Payment failed',
};

export interface Fx { currency: string; rate: number }
interface Ctx {
  busyId: string | null;
  fx: Fx | null; // local-currency estimate shown under USD totals
  approve: (id: string) => void;
  reject: (id: string) => void;
  invoice: (id: string) => void;
  onQty: (id: string, quantity: number) => void;
}

/** Quantity box for a proposal that has not been approved yet: - / + buttons or type a number. */
function QtyCell({ d, onQty }: { d: ProposalRow; onQty: (id: string, quantity: number) => void }) {
  const [val, setVal] = useState(String(d.quantity));
  useEffect(() => setVal(String(d.quantity)), [d.quantity]);
  if (d.status !== 'pending') return <span className="qty-static">{d.quantity}</span>;
  const commit = (n: number) => {
    if (Number.isFinite(n) && n >= 1 && Math.floor(n) !== d.quantity) onQty(d.id, Math.floor(n));
    else setVal(String(d.quantity));
  };
  return (
    <span className="qty">
      <button type="button" aria-label="Decrease quantity" disabled={d.quantity <= 1} onClick={() => commit(d.quantity - 1)}>&minus;</button>
      <input
        type="number"
        min={1}
        max={100}
        value={val}
        aria-label="Quantity"
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => commit(Number(val))}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <button type="button" aria-label="Increase quantity" onClick={() => commit(d.quantity + 1)}>+</button>
    </span>
  );
}

export function ProposalGrid({ rows, busyId, fx, approve, reject, invoice, onQty }: { rows: ProposalRow[] } & Ctx) {
  const cols = useMemo<ColDef<ProposalRow>[]>(
    () => [
      { headerName: 'Status', field: 'status', width: 170, autoHeight: true,
        cellRenderer: (p: ICellRendererParams<ProposalRow>) => {
          const d = p.data;
          if (!d) return null;
          return (
            <span>
              <span className={`pill ${d.status}`}>{STATUS_LABEL[d.status]}</span>
              {d.status === 'paid' && d.payAmount != null && <span className="sub">{formatMoney(d.payAmount, d.payCurrency ?? 'USD')} · {d.invoiceNo}</span>}
              {d.error && <span className="err">{d.error.slice(0, 90)}</span>}
            </span>
          );
        } },
      { headerName: 'Item', field: 'sku', width: 110, valueFormatter: (p) => (p.value === 'CUSTOM' ? 'One-off' : p.value) },
      { headerName: 'Product', field: 'title', flex: 2, minWidth: 220, wrapText: true, autoHeight: true },
      { headerName: 'Merchant', field: 'merchant', width: 130 },
      { headerName: 'Qty', field: 'quantity', width: 140, autoHeight: true,
        headerTooltip: 'Change the quantity before you approve. The price is recalculated.',
        cellRenderer: (p: ICellRendererParams<ProposalRow>) => (p.data ? <QtyCell d={p.data} onQty={onQty} /> : null) },
      { headerName: 'Unit price', field: 'unitPrice', width: 120, type: 'rightAligned',
        valueFormatter: (p) => usd(p.value),
        tooltipValueGetter: (p) => (p.data && p.data.unitPrice < p.data.listUnitPrice ? `List price ${usd(p.data.listUnitPrice)}` : undefined) },
      { headerName: 'Total', field: 'total', width: 150, type: 'rightAligned', autoHeight: true,
        cellRenderer: (p: ICellRendererParams<ProposalRow>) => {
          const d = p.data;
          if (!d) return null;
          return (
            <span className="total">
              {usd(d.total)}
              {fx && fx.currency !== 'USD' && <span className="sub">≈ {formatMoney(d.total * fx.rate, fx.currency)}</span>}
            </span>
          );
        } },
      { headerName: 'Why this one', field: 'rationale', flex: 3, minWidth: 260, wrapText: true, autoHeight: true, cellClass: 'why' },
      { headerName: '', colId: 'actions', width: 190, sortable: false, pinned: 'right', autoHeight: true,
        cellRenderer: (p: ICellRendererParams<ProposalRow>) => {
          const d = p.data;
          if (!d) return null;
          if (d.status === 'paid') {
            return (
              <div className="row-actions">
                <button className="go" onClick={() => invoice(d.id)}>Invoice</button>
              </div>
            );
          }
          if (d.status !== 'pending' && d.status !== 'awaiting_payment') return null;
          const busy = busyId === d.id;
          return (
            <div className="row-actions">
              <button className="go" disabled={busy} onClick={() => approve(d.id)}>
                {d.status === 'awaiting_payment' ? 'Resume payment' : 'Approve & pay'}
              </button>
              <button disabled={busy} onClick={() => reject(d.id)}>Reject</button>
            </div>
          );
        } },
    ],
    [busyId, fx, approve, reject, invoice, onQty],
  );

  return (
    <div className="grid-wrap">
      <AgGridReact<ProposalRow>
        theme={theme}
        rowData={rows}
        columnDefs={cols}
        getRowId={(p) => p.data.id}
        domLayout="autoHeight"
        defaultColDef={{ sortable: true, resizable: true }}
        tooltipShowDelay={300}
        suppressCellFocus
      />
    </div>
  );
}

export function InventoryGrid({ rows, onEdit }: { rows: InventoryRow[]; onEdit: (sku: string, onHand: number) => void }) {
  const cols = useMemo<ColDef<InventoryRow>[]>(
    () => [
      { headerName: 'Item', field: 'sku', width: 130 },
      { headerName: 'Name', field: 'name', flex: 2, minWidth: 220 },
      { headerName: 'On hand', field: 'onHand', width: 120, type: 'rightAligned', editable: true,
        valueParser: (p) => Math.max(0, Math.floor(Number(p.newValue))),
        headerTooltip: 'Double-click to change stock and simulate a shortage.' },
      { headerName: 'Incoming', field: 'incoming', width: 120, type: 'rightAligned' },
      { headerName: 'Reorder at', field: 'reorderPoint', width: 120, type: 'rightAligned' },
      { headerName: 'Target', field: 'targetLevel', width: 100, type: 'rightAligned' },
      { headerName: 'Max unit price', field: 'maxUnitPrice', width: 150, type: 'rightAligned', valueFormatter: (p) => usd(p.value) },
      { headerName: 'Stock', field: 'low', width: 130,
        cellRenderer: (p: ICellRendererParams<InventoryRow>) => p.data && <span className={`pill ${p.data.low ? 'low' : 'ok'}`}>{p.data.low ? 'Reorder' : 'Healthy'}</span> },
    ],
    [],
  );
  return (
    <div className="grid-wrap">
      <AgGridReact<InventoryRow>
        theme={theme}
        rowData={rows}
        columnDefs={cols}
        getRowId={(p) => p.data.sku}
        domLayout="autoHeight"
        defaultColDef={{ sortable: true, resizable: true }}
        onCellValueChanged={(e) => e.data && e.colDef.field === 'onHand' && onEdit(e.data.sku, e.data.onHand)}
        suppressCellFocus
      />
    </div>
  );
}
