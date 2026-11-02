import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { randomUUID } from 'crypto';
import { config, modes } from '../config';
import { store } from '../store';
import { executeTool, toolDefinitions } from './tools';

const SYSTEM = `You are ProcureAI, a procurement agent for a small office. You find the best deals and prepare purchase proposals. A human approves and pays; you never spend money yourself.

Process for each item you are asked to restock:
1. Call get_low_stock and get_budget first (unless the goal already names the items).
2. Call search_catalog using the item's suggested search. Compare offers across products and merchants. Ignore out-of-stock offers.
3. Choose the cheapest in-stock offer at or under the item's max unit price. Prefer products whose title matches the item (right size, count, type).
4. Order units_needed. If quantity is 10 or more, call negotiate_price once with a target about 5% under the best list price. The negotiation is simulated; say so if you mention it.
5. Call propose_purchase with a short rationale a buyer can scan in five seconds (price, merchant, savings versus the next best offer).
6. If a tool returns an error, read it and adjust once (different merchant, product, or quantity). If it still fails, skip the item and say why.

One-off shopping requests: if the goal says the person wants to buy something specific (not a restock), skip get_low_stock. Run search_catalog with a clear query; if the results are poor, try one or two different phrasings. Respect any brand, size, quantity, or price limit the person gave; if they gave no quantity, assume 1. If the goal says they want an exact number of units, use exactly that number. Compare merchants, pick the best match at the lowest in-stock price, and call propose_purchase WITHOUT sku (pass max_unit_price only if the person gave a price limit). Do not ask questions; state any assumptions in the rationale. If nothing suitable exists, say so plainly instead of proposing something unrelated.

Never invent products, prices, or merchants; use only tool results. Stay within budget. When finished, reply with a brief summary: what you proposed, what you skipped, total proposed spend.`;

// ---- AI runs: daily cap + automatic fallback -------------------------------------------------------------------

let usage = { day: '', count: 0 };
/** True while today's AI-run budget lasts. Counts every AI run from every user. */
function aiAllowed(): boolean {
  const day = new Date().toISOString().slice(0, 10);
  if (usage.day !== day) usage = { day, count: 0 };
  if (usage.count >= config.aiRunsPerDay) return false;
  usage.count++;
  return true;
}

/** A short, safe reason for the activity log (never the full API error). */
function briefError(e: any): string {
  const m = String(e?.message ?? e);
  if (/429|RESOURCE_EXHAUSTED|quota|rate/i.test(m)) return 'rate or quota limit reached';
  if (/503|UNAVAILABLE|overloaded|high demand/i.test(m)) return 'the service is busy';
  if (/401|403|API key|authentication|permission/i.test(m)) return 'API key problem';
  if (/404|not found|no longer available/i.test(m)) return 'model not available';
  return m.replace(/\s+/g, ' ').slice(0, 100);
}

const runScriptedAny = (runId: string, shop?: { request: string; quantity?: number }) =>
  shop ? runScriptedShop(runId, shop.request, shop.quantity ?? 1) : runScripted(runId);

export async function runAgent(runId: string, goal: string, shop?: { request: string; quantity?: number }): Promise<void> {
  const ai = modes.agent === 'gemini' ? 'Gemini' : modes.agent === 'claude' ? 'Claude' : null;
  if (!ai) {
    store.log(runId, 'info', 'No GEMINI_API_KEY or ANTHROPIC_API_KEY set. Running the scripted demo agent (same tools, no LLM reasoning).');
    return runScriptedAny(runId, shop);
  }
  if (!aiAllowed()) {
    store.log(runId, 'info', `This demo has used its ${config.aiRunsPerDay} AI runs for today, so the built-in scripted agent is handling this one. The AI agent is back tomorrow.`);
    return runScriptedAny(runId, shop);
  }
  try {
    return await (ai === 'Gemini' ? runGemini(runId, goal) : runClaude(runId, goal));
  } catch (e: any) {
    store.log(runId, 'info', `${ai} is unavailable right now (${briefError(e)}). Switching to the built-in scripted agent so you still get a result.`);
    if (shop && store.proposals.some((p) => p.runId === runId)) return; // the AI already got as far as a proposal
    return runScriptedAny(runId, shop);
  }
}

async function callTool(runId: string, name: string, input: any) {
  store.log(runId, 'tool', `${name}(${compact(input)})`);
  try {
    const result = await executeTool(runId, name, input);
    store.log(runId, result.ok ? 'result' : 'error', compact(result.data, 400));
    return result;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    store.log(runId, 'error', `${name} failed: ${msg}`);
    return { ok: false, data: { error: msg } };
  }
}

async function runClaude(runId: string, goal: string): Promise<void> {
  const client = new Anthropic({ apiKey: config.anthropicKey, authToken: null });
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: goal }];

  for (let turn = 0; turn < 25; turn++) {
    const res = await client.messages.create({
      model: config.anthropicModel,
      max_tokens: 4096,
      system: SYSTEM,
      tools: toolDefinitions,
      messages,
    });

    for (const block of res.content) {
      if (block.type === 'text' && block.text.trim()) store.log(runId, 'thought', block.text.trim());
    }
    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason !== 'tool_use') return;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue;
      const r = await callTool(runId, block.name, block.input);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(r.data), is_error: !r.ok });
    }
    messages.push({ role: 'user', content: results });
  }
  store.log(runId, 'error', 'Stopped after 25 turns without finishing.');
}


async function withRetry<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const retryable = /429|RESOURCE_EXHAUSTED|503|UNAVAILABLE|overloaded/i.test(msg);
      if (!retryable || attempt >= 3) throw e;
      const wait = 5 * 2 ** attempt; // 5s, 10s, 20s
      store.log(runId, 'info', `Gemini is rate-limited or busy. Retrying in ${wait}s...`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

async function runGemini(runId: string, goal: string): Promise<void> {
  const ai = new GoogleGenAI({ apiKey: config.geminiKey });

  // Same tools as the Claude agent, converted from Anthropic's format to Gemini function declarations.
  const functionDeclarations = toolDefinitions.map((t: any) => {
    const schema = t.input_schema ?? {};
    const hasProps = Object.keys(schema.properties ?? {}).length > 0;
    return hasProps
      ? { name: t.name, description: t.description, parametersJsonSchema: { type: 'object', properties: schema.properties, required: schema.required ?? [] } }
      : { name: t.name, description: t.description };
  });

  const contents: any[] = [{ role: 'user', parts: [{ text: goal }] }];

  for (let turn = 0; turn < 25; turn++) {
    const res: any = await withRetry(runId, () =>
      ai.models.generateContent({
        model: config.geminiModel,
        contents,
        config: { systemInstruction: SYSTEM, tools: [{ functionDeclarations }], temperature: 0.2 },
      }),
    );

    const content = res.candidates?.[0]?.content;
    if (!content) {
      store.log(runId, 'error', `Gemini returned no content (${res.candidates?.[0]?.finishReason ?? res.promptFeedback?.blockReason ?? 'unknown reason'}).`);
      return;
    }
    for (const part of content.parts ?? []) {
      if (part.text && !part.thought && part.text.trim()) store.log(runId, 'thought', part.text.trim());
    }
    contents.push(content); // keep the model's turn exactly as returned (Gemini needs its thought signatures back)

    const calls: any[] = res.functionCalls ?? [];
    if (!calls.length) return;

    const parts: any[] = [];
    for (const c of calls) {
      const r = await callTool(runId, c.name, c.args ?? {});
      parts.push({
        functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response: r.ok ? { result: r.data } : { error: r.data } },
      });
    }
    contents.push({ role: 'user', parts });
  }
  store.log(runId, 'error', 'Stopped after 25 turns without finishing.');
}

/** Deterministic stand-in so the whole app works before you have an Anthropic key. */
async function runScripted(runId: string): Promise<void> {
  const low = store.lowStock();
  if (!low.length) return void store.log(runId, 'thought', 'Nothing is below its reorder point.');
  store.log(runId, 'thought', `${low.length} item(s) need restocking: ${low.map((i) => i.sku).join(', ')}.`);

  for (const item of low) {
    // The AI may already have handled this item before it failed.
    if (store.proposals.some((p) => p.sku === item.sku && (p.status === 'pending' || p.status === 'awaiting_payment'))) continue;
    const needed = item.targetLevel - item.onHand - item.incoming;
    const search = await callTool(runId, 'search_catalog', { query: item.searchQuery, limit: 5 });
    if (!search.ok) continue;

    const candidates = (search.data as any[])
      .flatMap((p) => p.offers.filter((o: any) => o.in_stock && o.unit_price <= item.maxUnitPrice).map((o: any) => ({ product: p, offer: o })))
      .sort((a, b) => a.offer.unit_price - b.offer.unit_price);
    if (!candidates.length) {
      store.log(runId, 'thought', `${item.sku}: no in-stock offer at or under $${item.maxUnitPrice}. Skipping.`);
      continue;
    }

    const best = candidates[0];
    const next = candidates.find((c) => c.offer.merchant !== best.offer.merchant || c.product.product_id !== best.product.product_id);
    let price = best.offer.unit_price as number;
    let negotiated = '';
    if (needed >= 10) {
      const n = await callTool(runId, 'negotiate_price', {
        product_id: best.product.product_id,
        merchant: best.offer.merchant,
        quantity: needed,
        target_unit_price: Math.round(best.offer.unit_price * 95) / 100,
      });
      const quote = (n.data as any)?.quoted_unit_price;
      if (n.ok && typeof quote === 'number' && quote < price) {
        negotiated = ` Simulated negotiation lowered it from $${price.toFixed(2)}.`;
        price = quote;
      }
    }
    const saving = next ? ` Next best was $${next.offer.unit_price.toFixed(2)} at ${next.offer.merchant}.` : '';
    await callTool(runId, 'propose_purchase', {
      sku: item.sku,
      product_id: best.product.product_id,
      merchant: best.offer.merchant,
      quantity: needed,
      rationale: `Best in-stock price: $${price.toFixed(2)} at ${best.offer.merchant}.${negotiated}${saving}`,
    });
  }
  store.log(runId, 'thought', 'Done. Review the approval queue.');
}

/** Scripted one-off shopping: cheapest in-stock result. (Gemini/Claude also check that the product really matches.) */
async function runScriptedShop(runId: string, request: string, quantity: number): Promise<void> {
  const search = await callTool(runId, 'search_catalog', { query: request, limit: 8 });
  if (!search.ok) return;
  const candidates = (search.data as any[])
    .flatMap((p) => p.offers.filter((o: any) => o.in_stock).map((o: any) => ({ product: p, offer: o })))
    .sort((a, b) => a.offer.unit_price - b.offer.unit_price);
  if (!candidates.length) {
    store.log(runId, 'thought', `Nothing in stock found for "${request}".`);
    return;
  }
  const best = candidates[0];
  let price = best.offer.unit_price as number;
  let note = '';
  if (quantity >= 10) {
    const n = await callTool(runId, 'negotiate_price', {
      product_id: best.product.product_id,
      merchant: best.offer.merchant,
      quantity,
      target_unit_price: Math.round(price * 95) / 100,
    });
    const quote = (n.data as any)?.quoted_unit_price;
    if (n.ok && typeof quote === 'number' && quote < price) {
      note = ` Simulated negotiation lowered it from $${price.toFixed(2)}.`;
      price = quote;
    }
  }
  await callTool(runId, 'propose_purchase', {
    product_id: best.product.product_id,
    merchant: best.offer.merchant,
    quantity,
    rationale: `Lowest in-stock price for "${request}": $${price.toFixed(2)} at ${best.offer.merchant}.${note} Scripted mode does not check that the product matches.`,
  });
  store.log(runId, 'thought', 'Done. Review the approval queue.');
}

export function newRunId() {
  return randomUUID().slice(0, 6);
}

function compact(v: unknown, max = 220): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}
