export interface InventoryItem {
  sku: string;
  name: string;
  /** Search phrase the agent should start from. */
  searchQuery: string;
  onHand: number;
  /** Incoming units from paid, not-yet-received orders. */
  incoming: number;
  reorderPoint: number;
  /** Stock level we want to be at after restocking. */
  targetLevel: number;
  /** Highest unit price we are willing to pay. */
  maxUnitPrice: number;
}

export interface Offer {
  domain: string;
  url: string;
  price: number; // dollars
  currency: string;
  availability: string;
}

export interface CatalogProduct {
  id: string;
  title: string;
  brand?: string;
  offers: Offer[];
}

export type ProposalStatus = 'pending' | 'awaiting_payment' | 'paid' | 'rejected' | 'failed';

export interface Proposal {
  id: string;
  runId: string;
  sku: string;
  productId: string;
  title: string;
  merchant: string;
  quantity: number;
  listUnitPrice: number;
  unitPrice: number; // after (simulated) negotiation
  total: number;
  currency: string;
  rationale: string;
  buyUrl: string;
  status: ProposalStatus;
  createdAt: string;
  paypalOrderId?: string;
  captureId?: string;
  error?: string;
  /** Set when the buyer approves: what PayPal actually charges. */
  payCurrency?: string;
  payAmount?: number;
  fxRate?: number; // 1 USD = fxRate payCurrency
  fxSource?: string;
  paidAt?: string;
  invoiceNo?: string;
}

export type LogKind = 'info' | 'thought' | 'tool' | 'result' | 'error' | 'done';

export interface LogEntry {
  id: number;
  ts: string;
  runId: string;
  kind: LogKind;
  text: string;
}

export interface Budget {
  totalLimit: number;
  perPurchaseLimit: number;
  spent: number; // captured payments
  committed: number; // pending + awaiting_payment proposals
  remaining: number;
}
