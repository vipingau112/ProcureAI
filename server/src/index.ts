import cors from 'cors';
import express from 'express';
import { newRunId, runAgent } from './agent/procurementAgent';
import { requireAuth } from './auth/middleware';
import { authRouter } from './auth/routes';
import { ensureDemoUser, initAuth } from './auth/users';
import { config, modes } from './config';
import { volumeDiscount } from './agent/tools';
import { chargePlan, countryInfo, getRates, PAYPAL_CURRENCIES, roundFor } from './services/currencyService';
import { persistence } from './persistence';
import { captureOrder, createOrder } from './services/paypalService';
import { findByOrderId, findByProposalId, flushUser, initStores, round2, runWithStore, store } from './store';

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: config.clientUrl })); // tokens travel in the Authorization header, so no cookies are needed
app.use(express.json({ limit: '50kb' }));

// ===== Public routes (no login) ==============================================================

app.get('/api/health', (_req, res) => res.json({ ok: true, modes }));
app.use('/api/auth', authRouter);

app.get('/api/currency/rates', async (_req, res) => {
  const r = await getRates();
  res.json({ base: 'USD', rates: r.rates, source: r.source, updatedAt: r.updatedAt, paypal: PAYPAL_CURRENCIES, attribution: 'https://www.exchangerate-api.com' });
});
app.get('/api/currency/country', (req, res) => res.json(countryInfo(String(req.query.cc ?? ''))));

// PayPal sends the buyer's browser back here, with no login header, so we find the order's owner ourselves.
app.get('/api/paypal/return', async (req, res) => {
  const orderId = String(req.query.token ?? '');
  const found = findByOrderId(orderId);
  if (!found) return res.redirect(`${config.clientUrl}/?payment=unknown`);

  const outcome = await runWithStore(found.userId, async () => {
    const p = found.proposal;
    if (p.status === 'paid') return { code: 'paid', id: p.id };
    try {
      const { captureId } = await captureOrder(orderId);
      p.status = 'paid';
      p.captureId = captureId;
      p.paidAt = new Date().toISOString();
      p.invoiceNo = store.nextInvoiceNo();
      const item = store.inventory.find((i) => i.sku === p.sku);
      if (item) item.incoming += p.quantity;
      store.log(p.runId, 'info', `Payment captured for ${p.sku === 'CUSTOM' ? 'one-off item' : p.sku}: ${p.payAmount ?? p.total} ${p.payCurrency ?? 'USD'} (capture ${captureId}). Invoice ${p.invoiceNo}.`);
      await flushUser(found.userId).catch((e: any) => console.warn('[store] could not save the payment right away:', e?.message ?? e));
      return { code: 'paid', id: p.id };
    } catch (e: any) {
      p.status = 'failed';
      p.error = e?.message ?? String(e);
      store.log(p.runId, 'error', `Capture failed for ${p.sku}: ${p.error}`);
      return { code: 'failed', id: p.id };
    }
  });
  res.redirect(`${config.clientUrl}/?payment=${outcome.code}&id=${outcome.id}`);
});

app.get('/api/paypal/cancel', (req, res) => {
  const found = findByProposalId(String(req.query.proposal ?? ''));
  if (found && found.proposal.status === 'awaiting_payment') {
    runWithStore(found.userId, () => {
      found.proposal.status = 'pending';
      found.proposal.paypalOrderId = undefined;
      store.log(found.proposal.runId, 'info', `Payment cancelled for ${found.proposal.sku}. Proposal is back in the queue.`);
    });
  }
  res.redirect(`${config.clientUrl}/?payment=cancelled`);
});

// ===== Everything below needs a login =================================================================

app.use('/api', requireAuth);

app.get('/api/state', (_req, res) => {
  res.json({
    modes,
    running: store.running,
    budget: store.budget(),
    inventory: store.inventory.map((i) => ({ ...i, low: i.onHand + i.incoming <= i.reorderPoint })),
    proposals: store.proposals,
    logs: store.logs.slice(-200),
  });
});

// --- Agent -------------------------------------------------------------------------------------

function startRun(res: any, goal: string, label: string, shop?: { request: string; quantity?: number }) {
  if (store.running) return res.status(409).json({ error: 'The agent is already running.' });
  const runId = newRunId();
  store.running = true;
  store.forcedQty = shop?.quantity;
  store.log(runId, 'info', `Run ${runId} started: ${label}`);
  res.status(202).json({ runId });

  runAgent(runId, goal, shop)
    .catch((e: any) => store.log(runId, 'error', `Agent error: ${e?.message ?? e}`))
    .finally(() => {
      store.log(runId, 'done', `Run ${runId} finished`);
      store.running = false;
      store.forcedQty = undefined;
    });
}

// Restock everything that is low (optionally with an extra instruction).
app.post('/api/agent/run', (req, res) => {
  const custom = typeof req.body?.goal === 'string' ? req.body.goal.trim().slice(0, 300) : '';
  const goal =
    custom ||
    'Restock every inventory item at or below its reorder point. Find the best in-stock deal for each, negotiate where it makes sense, and submit proposals for approval.';
  startRun(res, goal, custom ? `"${custom.slice(0, 120)}"` : 'restock low items');
});

// Buy anything: a one-off request typed by the person (quantity is optional; blank = the agent reads it from the text, else 1).
app.post('/api/agent/shop', (req, res) => {
  const request = typeof req.body?.request === 'string' ? req.body.request.trim().slice(0, 300) : '';
  if (!request) return res.status(400).json({ error: 'Tell me what you want to buy.' });
  const raw = req.body?.quantity;
  let quantity: number | undefined;
  if (raw !== undefined && raw !== null && raw !== '') {
    quantity = Math.floor(Number(raw));
    if (!(quantity >= 1 && quantity <= 100)) return res.status(400).json({ error: 'Quantity must be a whole number from 1 to 100.' });
  }
  const goal = `The person wants to buy this (a one-off purchase, not an inventory restock): "${request}".${quantity ? ` They want exactly ${quantity} unit${quantity > 1 ? 's' : ''}.` : ''} Find the best match and submit a proposal for approval.`;
  startRun(res, goal, `buy ${quantity ? `${quantity} x ` : ''}"${request.slice(0, 120)}"`, { request, quantity });
});

// --- Approval + PayPal -----------------------------------------------------------------------------

app.post('/api/proposals/:id/approve', async (req: any, res) => {
  const p = store.proposals.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Proposal not found.' });
  if (p.status !== 'pending' && p.status !== 'awaiting_payment') return res.status(409).json({ error: `Proposal is ${p.status}.` });

  // Charge in the buyer's currency if PayPal supports it, otherwise USD.
  const plan = await chargePlan(typeof req.body?.currency === 'string' ? req.body.currency : undefined);
  p.payCurrency = plan.currency;
  p.fxRate = plan.rate;
  p.fxSource = plan.source;
  p.payAmount = roundFor(plan.currency, p.total * plan.rate);

  try {
    const { orderId, approveUrl } = await createOrder(p);
    p.paypalOrderId = orderId;
    p.status = 'awaiting_payment';
    p.error = undefined;
    store.log(p.runId, 'info', `Approved ${p.sku} ($${p.total.toFixed(2)}, charging ${p.payAmount} ${p.payCurrency}). PayPal order ${orderId} created; waiting for payment.`);
    res.json({ approveUrl, currency: plan.currency, amount: p.payAmount, converted: plan.converted, requested: plan.requested });
  } catch (e: any) {
    p.error = e?.message ?? String(e);
    store.log(p.runId, 'error', `Could not create PayPal order for ${p.sku}: ${p.error}`);
    res.status(502).json({ error: p.error });
  }
});

app.post('/api/proposals/:id/reject', (req, res) => {
  const p = store.proposals.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Proposal not found.' });
  if (p.status !== 'pending' && p.status !== 'awaiting_payment') return res.status(409).json({ error: `Proposal is ${p.status}.` });
  p.status = 'rejected';
  store.log(p.runId, 'info', `Rejected proposal for ${p.sku}.`);
  res.json({ ok: true });
});

// Change the quantity of a proposal before paying. The price is recalculated with the same simulated bulk-discount rule the agent's negotiation uses.
app.post('/api/proposals/:id/quantity', (req, res) => {
  const p = store.proposals.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Proposal not found.' });
  if (p.status !== 'pending') return res.status(409).json({ error: 'Quantity can only be changed before you approve.' });
  const quantity = Math.floor(Number(req.body?.quantity));
  if (!(quantity >= 1)) return res.status(400).json({ error: 'Quantity must be a whole number of at least 1.' });

  const item = p.sku === 'CUSTOM' ? undefined : store.inventory.find((i) => i.sku === p.sku);
  if (item) {
    const needed = item.targetLevel - item.onHand - item.incoming;
    if (quantity > needed) return res.status(400).json({ error: `Only ${Math.max(needed, 0)} more unit(s) are needed to reach the target stock for ${item.sku}.` });
  } else if (quantity > 100) {
    return res.status(400).json({ error: 'One-off purchases are limited to 100 units.' });
  }

  const unitPrice = round2(p.listUnitPrice * (1 - volumeDiscount(quantity)));
  if (item && unitPrice > item.maxUnitPrice) return res.status(400).json({ error: `Unit price $${unitPrice} is above the maximum of $${item.maxUnitPrice} for ${item.sku}.` });
  const total = round2(unitPrice * quantity);
  const b = store.budget();
  if (total > b.perPurchaseLimit) return res.status(400).json({ error: `Total $${total} is above the per-purchase limit of $${b.perPurchaseLimit}.` });
  if (total > round2(b.remaining + p.total)) return res.status(400).json({ error: `Total $${total} is more than your remaining budget ($${round2(b.remaining + p.total)} available for this order).` });

  p.quantity = quantity;
  p.unitPrice = unitPrice;
  p.total = total;
  if (!p.rationale.includes('(Quantity edited')) p.rationale += ' (Quantity edited by you; price recalculated.)';
  store.log(p.runId, 'info', `Quantity for ${p.sku === 'CUSTOM' ? 'one-off item' : p.sku} changed to ${quantity}. New total $${total.toFixed(2)}.`);
  res.json({ ok: true, proposal: p });
});

// Everything the printable invoice page needs.
app.get('/api/proposals/:id/invoice', (req: any, res) => {
  const p = store.proposals.find((x) => x.id === req.params.id);
  if (!p || p.status !== 'paid') return res.status(404).json({ error: 'No invoice for this order yet. Invoices appear after payment.' });
  res.json({
    invoiceNo: p.invoiceNo,
    issuedAt: p.paidAt,
    status: 'PAID',
    seller: { name: 'ProcureAI', note: 'Demo marketplace. Payment made in the PayPal sandbox, so this is a receipt for a test payment and not a tax invoice.' },
    buyer: { name: req.user.name, email: req.user.email },
    item: { title: p.title, sku: p.sku === 'CUSTOM' ? undefined : p.sku, merchant: p.merchant, quantity: p.quantity, unitPriceUsd: p.unitPrice, listUnitPriceUsd: p.listUnitPrice },
    totalUsd: p.total,
    payment: {
      method: 'PayPal',
      currency: p.payCurrency ?? 'USD',
      amount: p.payAmount ?? p.total,
      fxRate: p.fxRate ?? 1,
      fxSource: p.fxSource ?? 'n/a',
      orderId: p.paypalOrderId,
      captureId: p.captureId,
    },
    ratesAttribution: 'https://www.exchangerate-api.com',
  });
});

// --- Demo helpers ------------------------------------------------------------------------------------

/** Simulate a stock drop so the agent's low-stock detection has something to find. */
app.post('/api/inventory/:sku', (req, res) => {
  const item = store.inventory.find((i) => i.sku === req.params.sku);
  const onHand = Math.floor(Number(req.body?.onHand));
  if (!item) return res.status(404).json({ error: 'SKU not found.' });
  if (!(onHand >= 0)) return res.status(400).json({ error: 'onHand must be a non-negative integer.' });
  item.onHand = onHand;
  res.json({ ok: true });
});

app.post('/api/reset', (_req, res) => {
  store.reset();
  res.json({ ok: true });
});

/** Resolves once saved data is loaded and the server is listening. Exported so tests can wait for it. */
export const ready: Promise<void> = (async () => {
  await persistence.init();
  await initAuth();
  await initStores();
  await ensureDemoUser();
  await new Promise<void>((resolve) => {
    app.listen(config.port, () => {
      console.log(`ProcureAI server on :${config.port}`);
      console.log(`  agent: ${modes.agent} | catalog: ${modes.catalog} | payments: ${modes.payments} | otp: ${modes.otp} | storage: ${modes.db}`);
      if (config.demoAccount) console.log(`  demo login: enabled (${config.demoEmail}), shown as a button on the login screen`);
      resolve();
    });
  });
})();
ready.catch((e: any) => {
  console.error('Startup failed:', e?.message ?? e);
  process.exit(1);
});
