import { randomUUID } from 'crypto';
import { config, modes } from '../config';
import type { Proposal } from '../types';
import { formatForPayPal } from './currencyService';

/**
 * PayPal Orders v2 over plain REST (the old @paypal/checkout-server-sdk is deprecated).
 * Flow: create order -> buyer approves at approveUrl -> we capture on return.
 *
 * The order is created in the buyer's chosen currency when PayPal supports it (see currencyService),
 * otherwise in USD.
 *
 * DEMO CAVEAT: the money lands in the sandbox business account that owns your app,
 * not in the retailer's account. A real multi-merchant flow needs PayPal Payouts or
 * a marketplace setup, plus a real purchasing integration with each merchant.
 */

let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  const basic = Buffer.from(`${config.paypalClientId}:${config.paypalClientSecret}`).toString('base64');
  const res = await fetch(`${config.paypalBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}). Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.`);
  const data: any = await res.json();
  cached = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cached.token;
}

/** The body we send to PayPal. Exported so it can be checked without a network call. */
export function buildOrderBody(p: Proposal) {
  const currency = p.payCurrency ?? p.currency;
  const amount = formatForPayPal(currency, p.payAmount ?? p.total);
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: p.id,
        description: `Procurement: ${p.sku}`.slice(0, 127),
        amount: { currency_code: currency, value: amount, breakdown: { item_total: { currency_code: currency, value: amount } } },
        // One line for the whole order, so rounding after currency conversion can never make the totals disagree.
        items: [{ name: `${p.quantity} x ${p.title}`.slice(0, 127), quantity: '1', unit_amount: { currency_code: currency, value: amount } }],
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          user_action: 'PAY_NOW',
          return_url: `${config.serverUrl}/api/paypal/return`,
          cancel_url: `${config.serverUrl}/api/paypal/cancel?proposal=${p.id}`,
        },
      },
    },
  };
}

export async function createOrder(p: Proposal): Promise<{ orderId: string; approveUrl: string }> {
  if (modes.payments === 'mock') {
    const orderId = `MOCK-${randomUUID().slice(0, 8).toUpperCase()}`;
    return { orderId, approveUrl: `${config.serverUrl}/api/paypal/return?token=${orderId}&mock=1` };
  }

  const token = await accessToken();
  const res = await fetch(`${config.paypalBase}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': `create-${p.id}-${randomUUID()}` },
    body: JSON.stringify(buildOrderBody(p)),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`PayPal create order failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);

  const link = (data.links ?? []).find((l: any) => l.rel === 'payer-action') ?? (data.links ?? []).find((l: any) => l.rel === 'approve');
  if (!link) throw new Error('PayPal order created but no approval link was returned.');
  return { orderId: data.id, approveUrl: link.href };
}

export async function captureOrder(orderId: string): Promise<{ captureId: string }> {
  if (orderId.startsWith('MOCK-')) return { captureId: `MOCKCAP-${orderId.slice(5)}` };

  const token = await accessToken();
  const res = await fetch(`${config.paypalBase}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': `capture-${orderId}` },
  });
  const data: any = await res.json();
  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
  if (res.ok && data.status === 'COMPLETED' && capture?.status === 'PENDING') {
    throw new Error('Payment is pending: the PayPal business account does not hold this currency. In PayPal, open Settings > Payment preferences and allow payments in currencies you do not hold (or convert them), or pay in USD.');
  }
  if (!res.ok || data.status !== 'COMPLETED') {
    throw new Error(`PayPal capture failed (${res.status}, status=${data.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { captureId: capture?.id ?? orderId };
}
