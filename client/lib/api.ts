// API address: NEXT_PUBLIC_API_URL if it is set (the Render build), else the local server when the page runs on
// localhost, else the hosted API. Before this, the hosted address was hardcoded, so a local client never reached a local server.
const HOSTED_API = 'https://procureai-api-148w.onrender.com';
function pickApi(): string {
  const env = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/+$/, '');
  if (env) return env;
  if (typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) return 'http://localhost:5000';
  return HOSTED_API;
}
export const API = pickApi();
// ---- types -------------------------------------------------------------------------------------------
export interface User { id: string; email: string; name: string }
export interface InventoryRow {
  sku: string; name: string; onHand: number; incoming: number;
  reorderPoint: number; targetLevel: number; maxUnitPrice: number; low: boolean;
}
export interface ProposalRow {
  id: string; sku: string; title: string; merchant: string; quantity: number;
  listUnitPrice: number; unitPrice: number; total: number; rationale: string;
  status: 'pending' | 'awaiting_payment' | 'paid' | 'rejected' | 'failed';
  error?: string; buyUrl: string;
  payCurrency?: string; payAmount?: number; invoiceNo?: string;
}
export interface LogRow { id: number; ts: string; runId: string; kind: 'info' | 'thought' | 'tool' | 'result' | 'error' | 'done'; text: string }
export interface Budget { totalLimit: number; perPurchaseLimit: number; spent: number; committed: number; remaining: number }
export interface AppState {
  modes: { agent: string; catalog: string; payments: string; otp: string };
  running: boolean; budget: Budget;
  inventory: InventoryRow[]; proposals: ProposalRow[]; logs: LogRow[];
}
export interface Rates { base: 'USD'; rates: Record<string, number>; source: 'live' | 'fallback'; updatedAt: string; paypal: string[]; attribution: string }
export interface CountryInfo { country: string; currency: string; paypalCurrency: string }
export interface AuthReply { token?: string; user?: User; needsVerification?: boolean; email?: string; demoCode?: string; ok?: boolean; message?: string }
export interface Invoice {
  invoiceNo: string; issuedAt: string; status: string;
  seller: { name: string; note: string };
  buyer: { name: string; email: string };
  item: { title: string; sku?: string; merchant: string; quantity: number; unitPriceUsd: number; listUnitPriceUsd: number };
  totalUsd: number;
  payment: { method: string; currency: string; amount: number; fxRate: number; fxSource: string; orderId?: string; captureId?: string };
  ratesAttribution: string;
}

// ---- token ---------------------------------------------------------------------------------------------
// The login token lives in localStorage so a refresh keeps you signed in. Trade-off: any script on the page could read it.
const TOKEN_KEY = 'procure_token';
export const tokenStore = {
  get: () => (typeof window === 'undefined' ? '' : window.localStorage.getItem(TOKEN_KEY) ?? ''),
  set: (t: string) => window.localStorage.setItem(TOKEN_KEY, t),
  clear: () => window.localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(message: string, public status: number, public extra?: any) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit, useAuth = true): Promise<T> {
  const token = useAuth ? tokenStore.get() : '';
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && useAuth) {
    tokenStore.clear();
    window.dispatchEvent(new Event('procure-logout'));
  }
  if (!res.ok) throw new ApiError(body?.error || `Request failed (${res.status})`, res.status, body);
  return body as T;
}
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const api = {
  // account (no login needed)
  signup: (name: string, email: string, password: string) => req<AuthReply>('/api/auth/signup', post({ name, email, password }), false),
  verify: (email: string, code: string) => req<AuthReply>('/api/auth/verify', post({ email, code }), false),
  login: (email: string, password: string) => req<AuthReply>('/api/auth/login', post({ email, password }), false),
  resend: (email: string, purpose: 'signup' | 'reset') => req<AuthReply>('/api/auth/resend', post({ email, purpose }), false),
  forgot: (email: string) => req<AuthReply>('/api/auth/forgot', post({ email }), false),
  reset: (email: string, code: string, newPassword: string) => req<AuthReply>('/api/auth/reset', post({ email, code, newPassword }), false),
  me: () => req<{ user: User }>('/api/auth/me'),
  demoInfo: () => req<{ enabled: boolean; email: string }>('/api/auth/demo', undefined, false),
  demoLogin: () => req<AuthReply>('/api/auth/demo-login', { method: 'POST' }, false),
  // currency (public)
  rates: () => req<Rates>('/api/currency/rates', undefined, false),
  country: (cc: string) => req<CountryInfo>(`/api/currency/country?cc=${encodeURIComponent(cc)}`, undefined, false),
  // app (login needed)
  state: () => req<AppState>('/api/state'),
  run: (goal?: string) => req<{ runId: string }>('/api/agent/run', post({ goal })),
  shop: (request: string, quantity?: number) => req<{ runId: string }>('/api/agent/shop', post({ request, quantity })),
  setQuantity: (id: string, quantity: number) => req<{ ok: true }>(`/api/proposals/${id}/quantity`, post({ quantity })),
  approve: (id: string, currency: string) => req<{ approveUrl: string; currency: string; amount: number; converted: boolean }>(`/api/proposals/${id}/approve`, post({ currency })),
  reject: (id: string) => req<{ ok: true }>(`/api/proposals/${id}/reject`, { method: 'POST' }),
  invoice: (id: string) => req<Invoice>(`/api/proposals/${id}/invoice`),
  setStock: (sku: string, onHand: number) => req<{ ok: true }>(`/api/inventory/${sku}`, post({ onHand })),
  resetDemo: () => req<{ ok: true }>('/api/reset', { method: 'POST' }),
};

export const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
