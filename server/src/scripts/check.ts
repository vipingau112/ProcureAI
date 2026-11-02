/**
 * Setup check. Run from server/:
 *   npm run check             tests each service with your real keys
 *   npm run check -- --agent  also runs the full agent (no payment is made)
 * Never prints your keys.
 */
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { runAgent } from '../agent/procurementAgent';
import { config, modes } from '../config';
import { searchProducts } from '../services/channel3Service';
import { createOrder } from '../services/paypalService';
import { store } from '../store';
import type { Proposal } from '../types';

type Status = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
const rows: { name: string; status: Status; note: string }[] = [];
const say = (name: string, status: Status, note: string) => {
  rows.push({ name, status, note });
  console.log(`[${status}] ${name}: ${note}`);
};
const UNAVAILABLE = /out\s*of\s*stock|sold\s*out|discontinued|unavailable/i;

async function checkGemini() {
  const ai = new GoogleGenAI({ apiKey: config.geminiKey });
  try {
    const res: any = await ai.models.generateContent({ model: config.geminiModel, contents: 'Reply with the single word OK.' });
    say('Gemini', 'PASS', `model ${config.geminiModel} replied "${String(res.text ?? '').trim().slice(0, 30)}"`);
  } catch (e: any) {
    let hint = '';
    try {
      const names: string[] = [];
      const pager: any = await ai.models.list();
      for await (const m of pager) {
        if (/gemini/i.test(String(m.name))) names.push(String(m.name).replace('models/', ''));
        if (names.length >= 8) break;
      }
      if (names.length) hint = ` Models your key can see: ${names.join(', ')}. Put one in GEMINI_MODEL.`;
    } catch {
      /* key probably invalid; the main error above says so */
    }
    say('Gemini', 'FAIL', `${String(e?.message ?? e).slice(0, 300)}. Check GEMINI_API_KEY and GEMINI_MODEL.${hint}`);
  }
}

async function checkClaude() {
  if (modes.agent !== 'claude') return say('AI model', 'SKIP', 'Neither GEMINI_API_KEY nor ANTHROPIC_API_KEY is set (scripted demo agent will be used).');
  try {
    const client = new Anthropic({ apiKey: config.anthropicKey, authToken: null });
    const res: any = await client.messages.create({
      model: config.anthropicModel,
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    });
    const text = (res.content ?? []).map((b: any) => b.text ?? '').join('').trim();
    say('Claude', 'PASS', `model ${config.anthropicModel} replied "${text.slice(0, 30)}"`);
  } catch (e: any) {
    say('Claude', 'FAIL', `${e?.message ?? e}. Check ANTHROPIC_API_KEY and ANTHROPIC_MODEL.`);
  }
}

async function checkChannel3() {
  if (modes.catalog !== 'channel3') return say('Channel3', 'SKIP', 'CHANNEL3_API_KEY not set (mock catalog will be used).');
  for (const item of store.inventory) {
    try {
      const products = await searchProducts(item.searchQuery, 5);
      const prices = products.flatMap((p) => p.offers.filter((o) => !UNAVAILABLE.test(o.availability) && o.currency === 'USD').map((o) => o.price));
      if (!products.length) {
        say(`Channel3 · ${item.sku}`, 'FAIL', `no results for "${item.searchQuery}". Try a more general searchQuery in server/src/store.ts.`);
      } else if (!prices.length) {
        say(`Channel3 · ${item.sku}`, 'WARN', `${products.length} products but no in-stock USD offers.`);
      } else {
        const cheapest = Math.min(...prices);
        if (cheapest > item.maxUnitPrice) {
          say(`Channel3 · ${item.sku}`, 'WARN', `cheapest in-stock price is $${cheapest.toFixed(2)} but maxUnitPrice is $${item.maxUnitPrice}. The agent will skip this item. Raise maxUnitPrice to about $${Math.ceil(cheapest * 1.3)} in server/src/store.ts.`);
        } else {
          say(`Channel3 · ${item.sku}`, 'PASS', `${products.length} products, cheapest in-stock $${cheapest.toFixed(2)} (max $${item.maxUnitPrice}). e.g. "${products[0].title.slice(0, 60)}"`);
        }
      }
    } catch (e: any) {
      say(`Channel3 · ${item.sku}`, 'FAIL', `${e?.message ?? e}`);
      break; // same error would repeat for every item
    }
  }
}

async function checkPayPal() {
  if (modes.payments !== 'paypal-sandbox') return say('PayPal', 'SKIP', 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set (mock payments will be used).');
  try {
    const probe: Proposal = {
      id: 'check01', runId: 'check', sku: 'CHECK', productId: 'check', title: 'ProcureAI setup check item', merchant: 'example.com',
      quantity: 2, listUnitPrice: 5, unitPrice: 5, total: 10, currency: 'USD', rationale: '', buyUrl: '', status: 'pending', createdAt: new Date().toISOString(),
    };
    const { orderId, approveUrl } = await createOrder(probe);
    say('PayPal', 'PASS', `sandbox order ${orderId} created. Approval link (open with a sandbox BUYER account to test the full flow): ${approveUrl}`);
  } catch (e: any) {
    say('PayPal', 'FAIL', `${e?.message ?? e}. Use the Sandbox (not Live) Client ID and Secret.`);
  }
}

async function main() {
  console.log(`Modes: agent=${modes.agent} catalog=${modes.catalog} payments=${modes.payments}\n`);
  if (modes.agent === 'gemini') await checkGemini();
  else await checkClaude();
  await checkChannel3();
  await checkPayPal();

  if (process.argv.includes('--agent')) {
    console.log('\nRunning the full agent (no payment will be made)...\n');
    try {
      await runAgent('check', 'Restock every inventory item at or below its reorder point. Find the best in-stock deal for each, negotiate where it makes sense, and submit proposals for approval.');
      store.logs.forEach((l) => console.log(`  [${l.kind}] ${l.text.slice(0, 200)}`));
      console.log('\nProposals:');
      store.proposals.forEach((p) => console.log(`  ${p.sku}: ${p.quantity} x $${p.unitPrice.toFixed(2)} from ${p.merchant} = $${p.total.toFixed(2)}`));
      say('Agent run', store.proposals.length ? 'PASS' : 'WARN', `${store.proposals.length} proposal(s) created.`);
    } catch (e: any) {
      say('Agent run', 'FAIL', `${e?.message ?? e}`);
    }
  }

  const failed = rows.filter((r) => r.status === 'FAIL').length;
  const warned = rows.filter((r) => r.status === 'WARN').length;
  console.log(`\n${failed ? 'Fix the FAIL items above, then re-run.' : warned ? 'Works, with warnings above.' : 'All checks passed.'}`);
  process.exit(failed ? 1 : 0);
}

main();