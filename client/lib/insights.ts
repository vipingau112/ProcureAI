/**
 * Data and starting layout for the AG Studio "Insights" dashboard.
 * Kept free of React and of the Studio package so it can be checked on its own.
 * Widget syntax follows the AG Studio 3.1 docs: value (KPI), bar-chart-grouped, grid, on a 24-column layout.
 */
import type { ProposalRow } from './api';

export interface InsightRow {
  id: string;
  product: string;
  merchant: string;
  item: string;
  quantity: number;
  unitPrice: number;
  listPrice: number;
  total: number;
  savings: number; // (list price - price paid) x quantity, from the simulated bulk discount
  status: string;
}

const STATUS_LABEL: Record<ProposalRow['status'], string> = {
  pending: 'Needs approval',
  awaiting_payment: 'Awaiting payment',
  paid: 'Paid',
  rejected: 'Rejected',
  failed: 'Payment failed',
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const shorten = (s: string, n = 48) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function toInsightRows(proposals: ProposalRow[]): InsightRow[] {
  return proposals.map((p) => ({
    id: p.id,
    product: shorten(p.title),
    merchant: p.merchant,
    item: p.sku === 'CUSTOM' ? 'One-off' : p.sku,
    quantity: p.quantity,
    unitPrice: p.unitPrice,
    listPrice: p.listUnitPrice,
    total: p.total,
    savings: round2((p.listUnitPrice - p.unitPrice) * p.quantity),
    status: STATUS_LABEL[p.status],
  }));
}

// ---- sample data (shown until the account has proposals, clearly labelled in the UI) ------------------------

const discount = (q: number) => (q >= 100 ? 0.1 : q >= 50 ? 0.06 : q >= 10 ? 0.03 : 0);
const SAMPLE: [string, string, string, number, number, string][] = [
  // product, merchant, item, quantity, list price, status
  ['Copy paper, 500 sheets', 'staples.com', 'PAPER-A', 36, 15.99, 'Paid'],
  ['Dry erase markers, 12 pack', 'amazon.com', 'MARKER-12', 13, 9.99, 'Paid'],
  ['USB-C cable, 6 ft', 'amazon.com', 'USBC-6FT', 17, 7.99, 'Paid'],
  ['LED desk lamp', 'walmart.com', 'LAMP-LED', 5, 64.0, 'Paid'],
  ['Wireless mouse', 'bestbuy.com', 'One-off', 2, 19.99, 'Paid'],
  ['Whole bean coffee, 1 kg', 'target.com', 'COFFEE-1KG', 12, 18.97, 'Paid'],
  ['Standing desk mat', 'amazon.com', 'One-off', 4, 34.5, 'Paid'],
  ['HDMI cable, 2 m', 'bestbuy.com', 'One-off', 6, 12.99, 'Paid'],
  ['Notebook, A5', 'staples.com', 'One-off', 24, 3.49, 'Paid'],
  ['Copy paper, 500 sheets', 'walmart.com', 'PAPER-A', 20, 14.99, 'Needs approval'],
  ['Webcam, 1080p', 'amazon.com', 'One-off', 3, 49.0, 'Needs approval'],
  ['Desk organiser', 'target.com', 'One-off', 8, 16.25, 'Needs approval'],
  ['Stapler, heavy duty', 'staples.com', 'One-off', 5, 14.95, 'Needs approval'],
  ['Wireless keyboard', 'bestbuy.com', 'One-off', 4, 29.99, 'Awaiting payment'],
  ['Monitor stand', 'amazon.com', 'One-off', 2, 39.99, 'Awaiting payment'],
  ['Desk fan', 'walmart.com', 'One-off', 3, 27.5, 'Rejected'],
  ['Whiteboard, 90 x 60 cm', 'target.com', 'One-off', 2, 79.0, 'Rejected'],
  ['Label printer', 'bestbuy.com', 'One-off', 1, 59.0, 'Payment failed'],
];

export function sampleRows(): InsightRow[] {
  return SAMPLE.map(([product, merchant, item, quantity, listPrice, status], i) => {
    const unitPrice = round2(listPrice * (1 - discount(quantity)));
    return {
      id: `S${String(i + 1).padStart(3, '0')}`,
      product,
      merchant,
      item,
      quantity,
      unitPrice,
      listPrice,
      total: round2(unitPrice * quantity),
      savings: round2((listPrice - unitPrice) * quantity),
      status,
    };
  });
}

// ---- Studio configuration ------------------------------------------------------------------------------------------

export type FieldFormat = 'textFormat' | 'integerFormat' | 'currencyFormat';
export interface FieldDef {
  id: string;
  name: string;
  format: FieldFormat; // Studio only accepts known format names
}

export const FIELDS: FieldDef[] = [
  { id: 'id', name: 'Proposal', format: 'textFormat' },
  { id: 'product', name: 'Product', format: 'textFormat' },
  { id: 'merchant', name: 'Merchant', format: 'textFormat' },
  { id: 'item', name: 'Item', format: 'textFormat' },
  { id: 'quantity', name: 'Quantity', format: 'integerFormat' },
  { id: 'unitPrice', name: 'Unit price', format: 'currencyFormat' },
  { id: 'listPrice', name: 'List price', format: 'currencyFormat' },
  { id: 'total', name: 'Total', format: 'currencyFormat' },
  { id: 'savings', name: 'Saved vs list price', format: 'currencyFormat' },
  { id: 'status', name: 'Status', format: 'textFormat' },
];

export function buildData(rows: InsightRow[]) {
  return { sources: [{ id: 'orders', name: 'Proposals', data: rows, fields: FIELDS }] };
}

/** A ready-made first page: three KPIs, two charts and a grid. Users can edit it in Studio's edit mode. */
export function buildInitialState() {
  const kpi = (id: string, aggregation: string, caption: string) => ({
    type: 'value',
    dataMapping: { value: [{ id, aggregation }] },
    format: { caption: { enabled: true, text: caption } },
  });
  const bar = (category: string, title: string) => ({
    type: 'bar-chart-grouped',
    dataMapping: { categoryKey: [{ id: category }], valueKey: [{ id: 'orders.total', aggregation: 'sum' }] },
    format: { title: { enabled: true, text: title } },
  });
  return {
    selectedPageId: 'overview',
    pages: [
      {
        id: 'overview',
        widgets: {
          'kpi-total': kpi('orders.total', 'sum', 'Total value of proposals (USD)'),
          'kpi-saved': kpi('orders.savings', 'sum', 'Saved vs list price (USD)'),
          'kpi-count': kpi('orders.id', 'countd', 'Proposals'),
          'by-merchant': bar('orders.merchant', 'Spend by merchant (USD)'),
          'by-status': bar('orders.status', 'Value by status (USD)'),
          'all-proposals': {
            type: 'grid',
            dataMapping: {
              cols: ['id', 'product', 'merchant', 'quantity', 'unitPrice', 'total', 'savings', 'status'].map((f) => ({ id: `orders.${f}` })),
            },
            format: { title: { enabled: true, text: 'All proposals' } },
          },
        },
        widgetLayout: {
          'kpi-total': { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 6 },
          'kpi-saved': { xTrack: 8, yTrack: 0, xSpan: 8, ySpan: 6 },
          'kpi-count': { xTrack: 16, yTrack: 0, xSpan: 8, ySpan: 6 },
          'by-merchant': { xTrack: 0, yTrack: 6, xSpan: 12, ySpan: 16 },
          'by-status': { xTrack: 12, yTrack: 6, xSpan: 12, ySpan: 16 },
          'all-proposals': { xTrack: 0, yTrack: 22, xSpan: 24, ySpan: 16 },
        },
      },
    ],
  };
}
