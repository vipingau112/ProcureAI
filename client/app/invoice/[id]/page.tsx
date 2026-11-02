'use client';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError, tokenStore, type Invoice } from '@/lib/api';
import { formatMoney } from '@/lib/money';

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const [inv, setInv] = useState<Invoice | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!tokenStore.get()) return setError('Please log in first, then open the invoice from your dashboard.');
    api.invoice(id).then(setInv).catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the invoice.'));
  }, [id]);

  if (error) return <main className="invoice-wrap"><p className="notice bad">{error}</p><a className="link-btn" href="/">Back to dashboard</a></main>;
  if (!inv) return <div className="boot" role="status">Loading…</div>;

  const pay = inv.payment;
  const converted = pay.currency !== 'USD';

  return (
    <main className="invoice-wrap">
      <div className="invoice-actions no-print">
        <a className="link-btn" href="/">← Dashboard</a>
        <button className="btn" onClick={() => window.print()}>Print / Save as PDF</button>
      </div>

      <article className="invoice" aria-label={`Invoice ${inv.invoiceNo}`}>
        <header className="inv-head">
          <div>
            <p className="inv-brand">Procure<span>AI</span></p>
            <p className="inv-muted">Payment receipt</p>
          </div>
          <div className="inv-meta">
            <p className="inv-no">{inv.invoiceNo}</p>
            <p>{new Date(inv.issuedAt).toLocaleString()}</p>
            <p className="inv-paid">{inv.status}</p>
          </div>
        </header>

        <section className="inv-parties">
          <div>
            <h3>Billed to</h3>
            <p><b>{inv.buyer.name}</b></p>
            <p>{inv.buyer.email}</p>
          </div>
          <div>
            <h3>Issued by</h3>
            <p><b>{inv.seller.name}</b></p>
            <p className="inv-muted">Item sourced from {inv.item.merchant}</p>
          </div>
        </section>

        <table className="inv-table">
          <thead>
            <tr><th>Description</th><th className="num">Qty</th><th className="num">Unit price (USD)</th><th className="num">Amount (USD)</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>{inv.item.title}{inv.item.sku && <span className="inv-muted"> · {inv.item.sku}</span>}</td>
              <td className="num">{inv.item.quantity}</td>
              <td className="num">{formatMoney(inv.item.unitPriceUsd, 'USD')}</td>
              <td className="num">{formatMoney(inv.totalUsd, 'USD')}</td>
            </tr>
          </tbody>
        </table>

        <section className="inv-totals">
          <div><span>Total (USD)</span><b>{formatMoney(inv.totalUsd, 'USD')}</b></div>
          {converted && <div><span>Exchange rate</span><b>1 USD = {pay.fxRate.toFixed(4)} {pay.currency} ({pay.fxSource === 'live' ? 'live' : 'approximate'})</b></div>}
          <div className="inv-grand"><span>Amount paid</span><b>{formatMoney(pay.amount, pay.currency)}</b></div>
        </section>

        <section className="inv-pay">
          <h3>Payment</h3>
          <p>Method: {pay.method} (sandbox)</p>
          {pay.orderId && <p>PayPal order: <code>{pay.orderId}</code></p>}
          {pay.captureId && <p>Capture ID: <code>{pay.captureId}</code></p>}
        </section>

        <footer className="inv-foot">
          <p><b>धन्यवाद · Thank you.</b></p>
          <p className="inv-muted">{inv.seller.note}</p>
          <p className="inv-muted">Exchange rates by <a href={inv.ratesAttribution} target="_blank" rel="noopener noreferrer">Exchange Rate API</a>. Your bank may convert at its own rate.</p>
        </footer>
      </article>
    </main>
  );
}
