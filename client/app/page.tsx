'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import AgentTape from '@/components/AgentTape';
import AuthScreen from '@/components/AuthScreen';
import CurrencyPicker, { type Ccy } from '@/components/CurrencyPicker';
import { InventoryGrid, ProposalGrid } from '@/components/Grids';
import { api, tokenStore, usd, type AppState, type Rates, type User } from '@/lib/api';
import { formatMoney } from '@/lib/money';

type Tab = 'queue' | 'inventory';
const CCY_KEY = 'procure_ccy';
const PAYMENT_MESSAGES: Record<string, { text: string; bad?: boolean }> = {
  paid: { text: 'Payment complete! Press "Invoice" on the row to print your invoice.' },
  cancelled: { text: 'Payment cancelled. The proposal is back in the queue.', bad: true },
  failed: { text: 'The payment could not be captured. See the error on the proposal.', bad: true },
  unknown: { text: 'That PayPal order was not found. The server may have restarted.', bad: true },
};

export default function Home() {
  const [user, setUser] = useState<User | null | undefined>(undefined); // undefined = still checking
  const [state, setState] = useState<AppState | null>(null);
  const [offline, setOffline] = useState(false);
  const [tab, setTab] = useState<Tab>('queue');
  const [want, setWant] = useState('');
  const [wantQty, setWantQty] = useState('');
  const [goal, setGoal] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [rates, setRates] = useState<Rates | null>(null);
  const [ccy, setCcy] = useState<Ccy>({ currency: 'USD', source: 'default' });

  const say = useCallback((text: string, bad = false) => {
    setToast({ text, bad });
    setTimeout(() => setToast(null), 5000);
  }, []);

  // who is logged in? what currency did they choose last time?
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(CCY_KEY);
      if (saved) setCcy(JSON.parse(saved));
    } catch { /* ignore a corrupt value */ }
    api.rates().then(setRates).catch(() => setRates(null));
    if (!tokenStore.get()) return setUser(null);
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null));
    const onLogout = () => { setUser(null); setState(null); };
    window.addEventListener('procure-logout', onLogout);
    return () => window.removeEventListener('procure-logout', onLogout);
  }, []);

  // memoised so the grid is not rebuilt on every 1.5 s refresh (that would reset the quantity box while typing)
  const fx = useMemo(() => {
    const r = rates?.rates[ccy.currency];
    return ccy.currency !== 'USD' && r ? { currency: ccy.currency, rate: r } : null;
  }, [rates, ccy.currency]);

  const chooseCcy = (c: Ccy) => {
    setCcy(c);
    window.localStorage.setItem(CCY_KEY, JSON.stringify(c));
  };

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
      setOffline(false);
    } catch (e: any) {
      if (e?.status !== 401) setOffline(true);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    refresh();
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [user, refresh]);

  // message when PayPal sends the buyer back here
  useEffect(() => {
    if (!user) return;
    const code = new URLSearchParams(window.location.search).get('payment');
    if (code && PAYMENT_MESSAGES[code]) {
      const m = PAYMENT_MESSAGES[code];
      say(m.text, m.bad);
      window.history.replaceState({}, '', '/');
    }
  }, [user, say]);

  const logout = () => {
    tokenStore.clear();
    setUser(null);
    setState(null);
  };

  const run = async () => {
    try {
      await api.run(goal.trim() || undefined);
      setTab('queue');
      refresh();
    } catch (e: any) { say(e.message, true); }
  };

  const shop = async () => {
    if (!want.trim()) return;
    try {
      await api.shop(want.trim(), wantQty ? Number(wantQty) : undefined);
      setWant('');
      setWantQty('');
      setTab('queue');
      refresh();
    } catch (e: any) { say(e.message, true); }
  };

  const approve = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      const r = await api.approve(id, ccy.currency);
      if (!r.converted && ccy.currency !== 'USD') say(`PayPal cannot charge in ${ccy.currency}, so you will be charged in USD.`);
      window.location.href = r.approveUrl; // PayPal (or the mock) sends the buyer back here after paying
    } catch (e: any) {
      say(e.message, true);
      setBusyId(null);
      refresh();
    }
  }, [ccy.currency, say, refresh]);

  const reject = useCallback(async (id: string) => {
    setBusyId(id);
    try { await api.reject(id); } catch (e: any) { say(e.message, true); }
    setBusyId(null);
    refresh();
  }, [say, refresh]);

  const changeQty = useCallback(async (id: string, quantity: number) => {
    try { await api.setQuantity(id, quantity); } catch (e: any) { say(e.message, true); }
    refresh();
  }, [say, refresh]);

  const openInvoice = useCallback((id: string) => { window.open(`/invoice/${id}`, '_blank', 'noopener'); }, []);

  const setStock = useCallback(async (sku: string, onHand: number) => {
    try { await api.setStock(sku, onHand); } catch (e: any) { say(e.message, true); }
    refresh();
  }, [say, refresh]);

  const reset = async () => {
    if (!window.confirm('This will remove all your proposals, payments and invoices. Are you sure?')) return;
    await api.resetDemo();
    refresh();
  };

  if (user === undefined) return <div className="boot" role="status">Loading…</div>;
  if (user === null) return <AuthScreen onAuthed={setUser} />;

  const b = state?.budget;
  const pending = state?.proposals.filter((p) => p.status === 'pending' || p.status === 'awaiting_payment').length ?? 0;
  const low = state?.inventory.filter((i) => i.low).length ?? 0;
  const pct = (n: number) => (b ? Math.min(100, (n / b.totalLimit) * 100) : 0);
  const local = (n?: number) => (fx && n != null ? `≈ ${formatMoney(n * fx.rate, fx.currency)}` : '');

  return (
    <div className="app">
      <header className="head">
        <h1 className="brand">
          Procure<span>AI</span>
          <small>नमस्ते {user.name.split(' ')[0]}. The agent finds the best price, you approve, PayPal pays.</small>
        </h1>
        <div className="head-right">
          {state && (
            <p className="modes">
              Agent <b>{state.modes.agent === 'gemini' ? 'Gemini' : state.modes.agent === 'claude' ? 'Claude' : 'scripted demo'}</b> · Catalog <b>{state.modes.catalog === 'channel3' ? 'Channel3' : 'mock'}</b> · Payments <b>{state.modes.payments === 'paypal-sandbox' ? 'PayPal sandbox' : 'mock'}</b>
            </p>
          )}
          <div className="userbox">
            <span>{user.email}</span>
            <button className="btn ghost light small" onClick={logout}>Logout</button>
          </div>
        </div>
      </header>

      <section className="budget" aria-label="Spending">
        <div className="fig"><span>Remaining budget</span><strong>{b ? usd(b.remaining) : '—'}</strong>{b && <em>{local(b.remaining)}</em>}</div>
        <div className="fig"><span>Waiting for approval</span><strong>{b ? usd(b.committed) : '—'}</strong>{b && <em>{local(b.committed)}</em>}</div>
        <div className="fig"><span>Paid</span><strong>{b ? usd(b.spent) : '—'}</strong>{b && <em>{local(b.spent)}</em>}</div>
        <div className="fig"><span>Limit per purchase</span><strong>{b ? usd(b.perPurchaseLimit) : '—'}</strong>{b && <em>{local(b.perPurchaseLimit)}</em>}</div>
        {b && (
          <div className="bar" role="img" aria-label={`${usd(b.spent)} paid and ${usd(b.committed)} pending of ${usd(b.totalLimit)}`}>
            <i style={{ width: `${pct(b.spent + b.committed)}%` }} className="commit" />
            <i style={{ width: `${pct(b.spent)}%` }} />
          </div>
        )}
      </section>

      <section className="ccybar" aria-label="Currency">
        <CurrencyPicker value={ccy} rates={rates} onChange={chooseCcy} />
      </section>

      <div className="body">
        <main className="main">
          {offline && <p className="hint" role="alert">Cannot reach the server. Run <code>npm run dev</code> in the <code>server</code> folder.</p>}

          <div className="controls">
            <input
              value={want}
              onChange={(e) => setWant(e.target.value)}
              placeholder='Buy anything, e.g. "stapler under $20" or "2 wireless keyboards"'
              aria-label="What do you want to buy?"
              onKeyDown={(e) => e.key === 'Enter' && !state?.running && shop()}
            />
            <input
              className="qty-input"
              type="number"
              min={1}
              max={100}
              value={wantQty}
              onChange={(e) => setWantQty(e.target.value)}
              placeholder="Qty"
              title="Optional. Leave empty and the agent reads the quantity from your sentence (or uses 1)."
              aria-label="Quantity (optional)"
              onKeyDown={(e) => e.key === 'Enter' && !state?.running && shop()}
            />
            <button className="btn" onClick={shop} disabled={!state || state.running || !want.trim()}>Find it</button>
          </div>

          <div className="controls">
            <input
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={low ? `Optional instruction. ${low} item${low > 1 ? 's are' : ' is'} below the reorder level.` : 'Optional instruction for the agent'}
              aria-label="Instruction for the agent"
              onKeyDown={(e) => e.key === 'Enter' && !state?.running && run()}
            />
            <button className="btn ghost" onClick={run} disabled={!state || state.running}>
              {state?.running ? 'Agent is working…' : 'Restock low items'}
            </button>
            <button className="btn ghost" onClick={reset} disabled={state?.running}>Reset demo</button>
          </div>

          <div className="tabs" role="tablist">
            <button className="tab" role="tab" aria-selected={tab === 'queue'} onClick={() => setTab('queue')}>
              Approval queue<span className="count">{pending}</span>
            </button>
            <button className="tab" role="tab" aria-selected={tab === 'inventory'} onClick={() => setTab('inventory')}>
              Inventory<span className="count">{low} low</span>
            </button>
          </div>

          {tab === 'queue' && (
            state && state.proposals.length > 0 ? (
              <ProposalGrid rows={state.proposals} busyId={busyId} fx={fx} approve={approve} reject={reject} invoice={openInvoice} onQty={changeQty} />
            ) : (
              <p className="empty">No proposals yet. Type what you want to buy above, or press &ldquo;Restock low items&rdquo;. The agent will compare stores and put its suggestion here.</p>
            )
          )}

          {tab === 'inventory' && state && (
            <>
              <p className="hint">Double-click &ldquo;On hand&rdquo; to change a stock level and watch the agent react. Negotiated prices in this demo are simulated volume discounts.</p>
              <InventoryGrid rows={state.inventory} onEdit={setStock} />
            </>
          )}

          <p className="fineprint">
            Your location is only used to work out your country (taken from your browser, rounded to about 10 km) and is never saved.{' '}
            <a href={rates?.attribution ?? 'https://www.exchangerate-api.com'} target="_blank" rel="noopener noreferrer">Rates By Exchange Rate API</a>
            {rates && <> ({rates.source === 'live' ? 'live' : 'approx.'})</>}
          </p>
        </main>

        <AgentTape logs={state?.logs ?? []} running={!!state?.running} />
      </div>

      {toast && <div className={`toast${toast.bad ? ' bad' : ''}`} role="status">{toast.text}</div>}
    </div>
  );
}
