import { config } from '../config';
import { MOCK_PRODUCTS } from '../mock/catalog';
import type { CatalogProduct, Offer } from '../types';

/** Normalizes a Channel3 /v1/search product. Tolerates a few price shapes (number, {amount}, {price}, {value}). */
function normalize(p: any): CatalogProduct {
  const amountOf = (o: any): number | null => {
    const pr = o?.price;
    const v = typeof pr === 'number' ? pr : (pr?.amount ?? pr?.price ?? pr?.value);
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const offers: Offer[] = (p.offers ?? [])
    .map((o: any) => ({ o, amount: amountOf(o) }))
    .filter((x: any) => x.amount !== null)
    .map(({ o, amount }: any) => ({
      domain: String(o.domain ?? 'unknown'),
      url: String(o.url ?? ''),
      price: amount as number,
      currency: String(o.price?.currency ?? o.currency ?? 'USD'),
      availability: String(o.availability ?? 'Unknown'),
    }));

  const brand = Array.isArray(p.brands) && p.brands[0]?.name ? String(p.brands[0].name) : undefined;
  return { id: String(p.id), title: String(p.title ?? 'Untitled product'), brand, offers };
}

export async function searchProducts(query: string, limit = 5): Promise<CatalogProduct[]> {
  if (!config.channel3Key) return mockSearch(query, limit);

  const res = await fetch('https://api.trychannel3.com/v1/search', {
    method: 'POST',
    headers: { 'x-api-key': config.channel3Key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit }),
  });
  if (!res.ok) throw new Error(`Channel3 search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const data: any = await res.json();
  const list: any[] = Array.isArray(data) ? data : (data.products ?? data.results ?? data.items ?? []);
  const products = list.map(normalize).filter((p: CatalogProduct) => p.offers.length > 0);

  if (!products.length) {
    console.warn(
      `[channel3] "${query}" gave 0 usable products out of ${list.length}. ` +
        `First product keys: ${Object.keys(list[0] ?? {}).join(', ') || '(none)'}. ` +
        `Offers sample: ${JSON.stringify(list[0]?.offers?.slice(0, 2))}`,
    );
  }
  return products;
}

function mockSearch(query: string, limit: number): CatalogProduct[] {
  const tokens = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  return MOCK_PRODUCTS.map((p) => ({ p, score: tokens.filter((t) => p.keywords.includes(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ p }) => ({ id: p.id, title: p.title, brand: p.brand, offers: p.offers }));
}