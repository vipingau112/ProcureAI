import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { config } from './config';
import { persistence } from './persistence';
import type { Budget, CatalogProduct, InventoryItem, LogEntry, LogKind, Proposal } from './types';

const seedInventory = (): InventoryItem[] => [
  { sku: 'PAPER-A', name: 'Copy paper, 500 sheets', searchQuery: 'copy paper 500 sheets letter', onHand: 4, incoming: 0, reorderPoint: 10, targetLevel: 40, maxUnitPrice: 25 },
  { sku: 'MARKER-12', name: 'Whiteboard markers, 12 pack', searchQuery: 'dry erase markers 12 pack', onHand: 2, incoming: 0, reorderPoint: 5, targetLevel: 15, maxUnitPrice: 14 },
  { sku: 'USBC-6FT', name: 'USB-C cable, 6 ft', searchQuery: 'usb-c cable 6ft', onHand: 3, incoming: 0, reorderPoint: 8, targetLevel: 20, maxUnitPrice: 12 },
  { sku: 'LAMP-LED', name: 'LED desk lamp', searchQuery: 'led desk lamp', onHand: 1, incoming: 0, reorderPoint: 3, targetLevel: 6, maxUnitPrice: 90 },
  { sku: 'MOUSE-WL', name: 'Wireless mouse', searchQuery: 'wireless mouse', onHand: 9, incoming: 0, reorderPoint: 5, targetLevel: 12, maxUnitPrice: 25 },
  { sku: 'COFFEE-1KG', name: 'Whole bean coffee, 1 kg', searchQuery: 'whole bean roasted coffee bag', onHand: 12, incoming: 0, reorderPoint: 6, targetLevel: 14, maxUnitPrice: 22 },
];

/** One Store per signed-in user: their inventory, proposals, payments and agent log. */
export class Store {
  inventory: InventoryItem[] = seedInventory();
  proposals: Proposal[] = [];
  logs: LogEntry[] = [];
  /** Products seen in search results this session, so later tool calls can refer to them by id. */
  catalog = new Map<string, CatalogProduct>();
  /** Negotiated unit prices, keyed `${productId}|${domain}|${quantity}`. The server, not the model, decides what price a proposal uses. */
  deals = new Map<string, number>();
  running = false;
  /** Exact quantity the person typed for a one-off purchase; propose_purchase refuses any other number. */
  forcedQty?: number;
  invoiceSeq = 0;
  lastSaved = '';
  private logSeq = 0;

  constructor(public readonly userId: string) {}

  log(runId: string, kind: LogKind, text: string) {
    this.logs.push({ id: ++this.logSeq, ts: new Date().toISOString(), runId, kind, text });
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
  }

  lowStock(): InventoryItem[] {
    return this.inventory.filter((i) => i.onHand + i.incoming <= i.reorderPoint);
  }

  budget(): Budget {
    const spent = this.sum((p) => p.status === 'paid');
    const committed = this.sum((p) => p.status === 'pending' || p.status === 'awaiting_payment');
    return {
      totalLimit: config.budgetTotal,
      perPurchaseLimit: config.budgetPerPurchase,
      spent,
      committed,
      remaining: round2(config.budgetTotal - spent - committed),
    };
  }

  private sum(pred: (p: Proposal) => boolean) {
    return round2(this.proposals.filter(pred).reduce((a, p) => a + p.total, 0));
  }

  addProposal(p: Omit<Proposal, 'id' | 'createdAt' | 'status'>): Proposal {
    const proposal: Proposal = { ...p, id: randomUUID().slice(0, 8), createdAt: new Date().toISOString(), status: 'pending' };
    this.proposals.unshift(proposal);
    return proposal;
  }

  nextInvoiceNo(): string {
    return `INV-${new Date().getFullYear()}-${String(++this.invoiceSeq).padStart(4, '0')}`;
  }

  snapshot() {
    return { inventory: this.inventory, proposals: this.proposals, invoiceSeq: this.invoiceSeq };
  }

  restore(d: any) {
    if (Array.isArray(d?.inventory)) this.inventory = d.inventory;
    if (Array.isArray(d?.proposals)) this.proposals = d.proposals;
    this.invoiceSeq = Number(d?.invoiceSeq) || 0;
  }

  reset() {
    this.inventory = seedInventory();
    this.proposals = [];
    this.logs = [];
    this.catalog.clear();
    this.deals.clear();
    this.running = false;
    this.forcedQty = undefined;
    this.invoiceSeq = 0;
  }
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

// ---- per-user registry + persistence ---------------------------------------------------------------------------
// While the server runs everything lives in memory. Saved data is loaded once at startup (initStores), then written back
// to the database (or JSON files) every few seconds, and immediately after a payment.

const stores = new Map<string, Store>();

export function storeFor(userId: string): Store {
  let s = stores.get(userId);
  if (!s) {
    s = new Store(userId);
    stores.set(userId, s);
  }
  return s;
}

/** Loads every user's saved data. Call once at startup, after persistence.init(). */
export async function initStores(): Promise<void> {
  for (const [id, data] of await persistence.loadAllUserData()) {
    const s = storeFor(id);
    s.restore(data);
    s.lastSaved = JSON.stringify(s.snapshot());
  }
}

async function saveStore(s: Store) {
  const json = JSON.stringify(s.snapshot());
  if (json === s.lastSaved) return;
  await persistence.saveUserData(s.userId, json);
  s.lastSaved = json;
}

/** Saves one user's data now (used right after a payment is captured). */
export async function flushUser(userId: string): Promise<void> {
  const s = stores.get(userId);
  if (s) await saveStore(s);
}

export async function flushAll(): Promise<void> {
  for (const s of stores.values()) {
    try {
      await saveStore(s);
    } catch (e: any) {
      console.warn('[store] could not save user data:', e?.message ?? e);
    }
  }
}

let saving: Promise<void> | null = null;
setInterval(() => {
  if (!saving) saving = flushAll().finally(() => { saving = null; });
}, 3000).unref();
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { flushAll().finally(() => process.exit(0)); });

/** Finds a proposal in any user's store (PayPal's redirect arrives without a login header). */
export function findByOrderId(orderId: string) {
  for (const s of stores.values()) {
    const proposal = s.proposals.find((x) => x.paypalOrderId === orderId);
    if (proposal) return { userId: s.userId, proposal };
  }
  return null;
}
export function findByProposalId(id: string) {
  for (const s of stores.values()) {
    const proposal = s.proposals.find((x) => x.id === id);
    if (proposal) return { userId: s.userId, proposal };
  }
  return null;
}

// ---- "store" always means: the signed-in user's store -------------------------------------------
// Agent tools, the agent loop and the routes keep using `store.x`. Behind the scenes it resolves to
// whichever user's request is being handled (AsyncLocalStorage), so users never see each other's data.

const als = new AsyncLocalStorage<Store>();
const fallback = new Store('anonymous'); // used by scripts such as `npm run check`

export function runWithStore<T>(userId: string, fn: () => T): T {
  return als.run(storeFor(userId), fn);
}

export const store: Store = new Proxy({} as Store, {
  get(_t, prop) {
    const s: any = als.getStore() ?? fallback;
    const v = s[prop];
    return typeof v === 'function' ? v.bind(s) : v;
  },
  set(_t, prop, value) {
    const s: any = als.getStore() ?? fallback;
    s[prop] = value;
    return true;
  },
});
