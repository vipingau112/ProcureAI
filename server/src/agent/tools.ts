import type Anthropic from '@anthropic-ai/sdk';
import { searchProducts } from '../services/channel3Service';
import { round2, store } from '../store';
import type { Offer } from '../types';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'get_low_stock',
    description: 'List inventory items at or below their reorder point, including how many units are needed to reach target stock and the max unit price we will pay.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_budget',
    description: 'Get the remaining procurement budget and the per-purchase limit (USD).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_catalog',
    description: 'Search the live product catalog. Returns products, each with offers from multiple merchants (domain, unit price, availability). Use product ids and merchant domains from here in later calls.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Product search phrase, e.g. "usb-c cable 6ft".' },
        limit: { type: 'integer', description: 'Max products to return (1-8). Default 5.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'negotiate_price',
    description:
      'Ask a merchant for a better unit price on a bulk order. NOTE: negotiation is SIMULATED. Catalog APIs do not support it, so the merchant replies using a volume-discount rule. The result is a binding quote for propose_purchase at the same quantity.',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'string' },
        merchant: { type: 'string', description: 'Merchant domain from search results, e.g. "amazon.com".' },
        quantity: { type: 'integer' },
        target_unit_price: { type: 'number', description: 'Unit price you are asking for, in USD.' },
      },
      required: ['product_id', 'merchant', 'quantity', 'target_unit_price'],
    },
  },
  {
    name: 'propose_purchase',
    description:
      'Submit a purchase proposal to the human approval queue. This does NOT spend money; a person must approve it and pay via PayPal. For inventory restocks pass the sku. For one-off shopping requests leave sku out. The unit price is taken from a prior negotiate_price quote at the same quantity, otherwise the merchant list price. Limits are enforced server-side.',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Inventory SKU being restocked. Omit for one-off purchases.' },
        product_id: { type: 'string' },
        merchant: { type: 'string' },
        quantity: { type: 'integer' },
        max_unit_price: { type: 'number', description: 'One-off purchases only: the highest unit price the person said they would pay, if they gave one.' },
        rationale: { type: 'string', description: 'One or two sentences a buyer can read to decide quickly. State any assumptions.' },
      },
      required: ['product_id', 'merchant', 'quantity', 'rationale'],
    },
  },
];

const UNAVAILABLE = /out\s*of\s*stock|sold\s*out|discontinued|unavailable/i;
const isAvailable = (o: Offer) => !UNAVAILABLE.test(o.availability);

export function volumeDiscount(quantity: number): number {
  if (quantity >= 100) return 0.1;
  if (quantity >= 50) return 0.06;
  if (quantity >= 10) return 0.03;
  return 0;
}

export type ToolResult = { ok: boolean; data: unknown };
const fail = (error: string): ToolResult => ({ ok: false, data: { error } });

export async function executeTool(runId: string, name: string, input: any): Promise<ToolResult> {
  switch (name) {
    case 'get_low_stock':
      return {
        ok: true,
        data: store.lowStock().map((i) => ({
          sku: i.sku,
          name: i.name,
          on_hand: i.onHand,
          incoming: i.incoming,
          reorder_point: i.reorderPoint,
          units_needed: Math.max(0, i.targetLevel - i.onHand - i.incoming),
          max_unit_price: i.maxUnitPrice,
          suggested_search: i.searchQuery,
        })),
      };

    case 'get_budget':
      return { ok: true, data: store.budget() };

    case 'search_catalog': {
      const query = String(input?.query ?? '').trim();
      if (!query) return fail('query is required');
      const limit = Math.min(8, Math.max(1, Number(input?.limit) || 5));
      const products = await searchProducts(query, limit);
      for (const p of products) store.catalog.set(p.id, p);
      return {
        ok: true,
        data: products.map((p) => ({
          product_id: p.id,
          title: p.title,
          brand: p.brand,
          offers: [...p.offers].sort((a, b) => a.price - b.price).map((o) => ({
            merchant: o.domain,
            unit_price: o.price,
            currency: o.currency,
            in_stock: isAvailable(o),
          })),
        })),
      };
    }

    case 'negotiate_price': {
      const product = store.catalog.get(String(input?.product_id));
      if (!product) return fail('Unknown product_id. Run search_catalog first.');
      const offer = product.offers.find((o) => o.domain.toLowerCase() === String(input?.merchant).toLowerCase());
      if (!offer) return fail('That merchant has no offer for this product.');
      const quantity = Math.floor(Number(input?.quantity));
      const target = Number(input?.target_unit_price);
      if (!(quantity > 0) || !(target > 0)) return fail('quantity and target_unit_price must be positive.');

      const floor = round2(offer.price * (1 - volumeDiscount(quantity)));
      const accepted = target >= floor;
      const unitPrice = accepted ? Math.min(round2(target), offer.price) : floor;
      store.deals.set(`${product.id}|${offer.domain}|${quantity}`, unitPrice);
      return {
        ok: true,
        data: {
          simulated: true,
          accepted,
          list_unit_price: offer.price,
          quoted_unit_price: unitPrice,
          note: accepted
            ? 'Merchant accepted your target.'
            : floor < offer.price
              ? `Merchant countered with their best bulk price for ${quantity} units.`
              : 'No volume discount is available at this quantity; list price stands.',
        },
      };
    }

    case 'propose_purchase': {
      const skuIn = typeof input?.sku === 'string' ? input.sku.trim() : '';
      const item = skuIn ? store.inventory.find((i) => i.sku === skuIn) : undefined;
      if (skuIn && !item) return fail('Unknown sku. Leave sku out for a one-off purchase.');
      const product = store.catalog.get(String(input?.product_id));
      if (!product) return fail('Unknown product_id. Run search_catalog first.');
      const offer = product.offers.find((o) => o.domain.toLowerCase() === String(input?.merchant).toLowerCase());
      if (!offer) return fail('That merchant has no offer for this product.');
      if (!isAvailable(offer)) return fail('That offer is out of stock.');
      if (offer.currency !== 'USD') return fail(`Only USD is supported in this demo (offer is ${offer.currency}).`);

      const quantity = Math.floor(Number(input?.quantity));
      if (!(quantity > 0)) return fail('quantity must be a positive integer.');

      let maxUnit = Infinity;
      if (item) {
        const needed = item.targetLevel - item.onHand - item.incoming;
        if (quantity > needed) return fail(`Quantity ${quantity} would exceed target stock. Maximum useful quantity is ${Math.max(needed, 0)}.`);
        if (store.proposals.some((p) => p.sku === item.sku && (p.status === 'pending' || p.status === 'awaiting_payment'))) {
          return fail(`There is already an open proposal for ${item.sku}.`);
        }
        maxUnit = item.maxUnitPrice;
      } else {
        if (store.forcedQty && quantity !== store.forcedQty) return fail(`The person asked for exactly ${store.forcedQty} unit(s). Use that quantity.`);
        if (quantity > 100) return fail('One-off purchases are limited to 100 units.');
        if (store.proposals.some((p) => p.sku === 'CUSTOM' && p.productId === product.id && p.merchant === offer.domain && (p.status === 'pending' || p.status === 'awaiting_payment'))) {
          return fail('That product from that merchant is already in the approval queue.');
        }
        const asked = Number(input?.max_unit_price);
        if (asked > 0) maxUnit = asked;
      }

      const unitPrice = round2(store.deals.get(`${product.id}|${offer.domain}|${quantity}`) ?? offer.price);
      if (unitPrice > maxUnit) return fail(`Unit price $${unitPrice} exceeds the maximum of $${maxUnit}${item ? ` for ${item.sku}` : ''}. Try another product or merchant.`);

      const total = round2(unitPrice * quantity);
      const budget = store.budget();
      if (total > budget.perPurchaseLimit) return fail(`Total $${total} exceeds the per-purchase limit of $${budget.perPurchaseLimit}.`);
      if (total > budget.remaining) return fail(`Total $${total} exceeds the remaining budget of $${budget.remaining}.`);

      const proposal = store.addProposal({
        runId,
        sku: item ? item.sku : 'CUSTOM',
        productId: product.id,
        title: product.title,
        merchant: offer.domain,
        quantity,
        listUnitPrice: offer.price,
        unitPrice,
        total,
        currency: 'USD',
        rationale: String(input?.rationale ?? '').slice(0, 500),
        buyUrl: offer.url,
      });
      return { ok: true, data: { proposal_id: proposal.id, status: 'pending_human_approval', total } };
    }

    default:
      return fail(`Unknown tool: ${name}`);
  }
}
