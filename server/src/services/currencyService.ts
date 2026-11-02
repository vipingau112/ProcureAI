/**
 * Currency support.
 * - PayPal can only charge in the currencies it lists (checked against PayPal's currency-codes docs).
 *   INR is NOT on that list, so Indian buyers are charged in USD; we show an INR estimate and their bank converts.
 * - Rates come from open.er-api.com (free, no key, updates daily, attribution required) with a built-in fallback.
 */

/** Currencies we will actually send to PayPal. BRL, CNY and MYR are left out: PayPal allows them for in-country accounts only. */
export const PAYPAL_CURRENCIES = ['AUD', 'CAD', 'CHF', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'ILS', 'JPY', 'MXN', 'NOK', 'NZD', 'PHP', 'PLN', 'SEK', 'SGD', 'THB', 'TWD', 'USD'];
/** PayPal rejects decimal amounts in these. */
export const NO_DECIMALS = new Set(['HUF', 'JPY', 'TWD']);

export const roundFor = (currency: string, n: number) => (NO_DECIMALS.has(currency) ? Math.round(n) : Math.round(n * 100) / 100);
export const formatForPayPal = (currency: string, n: number) => (NO_DECIMALS.has(currency) ? String(Math.round(n)) : n.toFixed(2));

const BY_CURRENCY: Record<string, string> = {
  USD: 'US PR GU VI AS MP EC SV PA TL FM MH PW',
  EUR: 'AT BE BG HR CY EE FI FR DE GR IE IT LV LT LU MT NL PT SK SI ES AD MC SM VA ME XK',
  GBP: 'GB IM JE GG', INR: 'IN', NPR: 'NP', PKR: 'PK', BDT: 'BD', LKR: 'LK', BTN: 'BT', MVR: 'MV',
  AED: 'AE', SAR: 'SA', QAR: 'QA', KWD: 'KW', BHD: 'BH', OMR: 'OM', ILS: 'IL', TRY: 'TR', EGP: 'EG', JOD: 'JO',
  CAD: 'CA', AUD: 'AU', NZD: 'NZ', SGD: 'SG', HKD: 'HK', JPY: 'JP', CNY: 'CN', KRW: 'KR', TWD: 'TW', THB: 'TH',
  MYR: 'MY', IDR: 'ID', PHP: 'PH', VND: 'VN',
  CHF: 'CH LI', SEK: 'SE', NOK: 'NO', DKK: 'DK GL FO', ISK: 'IS', PLN: 'PL', CZK: 'CZ', HUF: 'HU', RON: 'RO', UAH: 'UA',
  BRL: 'BR', MXN: 'MX', ARS: 'AR', CLP: 'CL', COP: 'CO', PEN: 'PE', UYU: 'UY',
  ZAR: 'ZA', NGN: 'NG', KES: 'KE', GHS: 'GH', MAD: 'MA', TZS: 'TZ', UGX: 'UG', ETB: 'ET',
  KZT: 'KZ', GEL: 'GE', AMD: 'AM', AZN: 'AZ',
};
const COUNTRY_CURRENCY: Record<string, string> = {};
for (const [cur, list] of Object.entries(BY_CURRENCY)) for (const cc of list.split(' ')) COUNTRY_CURRENCY[cc] = cur;

export function countryInfo(cc: string) {
  const country = String(cc ?? '').toUpperCase().slice(0, 2);
  const currency = COUNTRY_CURRENCY[country] ?? 'USD';
  return { country, currency, paypalCurrency: PAYPAL_CURRENCIES.includes(currency) ? currency : 'USD' };
}

// ---- rates ---------------------------------------------------------------------------------------------

const FALLBACK: Record<string, number> = {
  USD: 1, EUR: 0.92, GBP: 0.79, INR: 84, AUD: 1.52, CAD: 1.37, JPY: 150, SGD: 1.34, CHF: 0.88, AED: 3.6725, SAR: 3.75,
  PKR: 278, BDT: 120, LKR: 300, NPR: 134, CNY: 7.2, HKD: 7.8, KRW: 1350, THB: 35, MYR: 4.5, IDR: 15600, PHP: 57,
  VND: 25000, NZD: 1.65, SEK: 10.5, NOK: 10.8, DKK: 6.9, PLN: 4.0, CZK: 23, HUF: 360, ILS: 3.7, MXN: 18, BRL: 5.2,
  ZAR: 18.5, TRY: 34, EGP: 49, NGN: 1600, KES: 129, TWD: 32,
};

export interface Rates { rates: Record<string, number>; updatedAt: string; source: 'live' | 'fallback' }
const CACHE_MS = 6 * 3600_000;
let cache: (Rates & { fetchedAt: number }) | null = null;

export async function getRates(): Promise<Rates> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_MS) return cache;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(5000) });
    const d: any = await res.json();
    if (d?.result === 'success' && d.rates?.USD) {
      cache = { rates: d.rates, updatedAt: String(d.time_last_update_utc ?? new Date().toISOString()), source: 'live', fetchedAt: now };
      return cache;
    }
  } catch {
    /* offline or throttled: use what we have */
  }
  if (cache) return cache; // stale but real
  // Remember the fallback for 5 minutes so an offline server does not wait 5s on every request.
  cache = { rates: FALLBACK, updatedAt: 'built-in approximate rates', source: 'fallback', fetchedAt: now - (CACHE_MS - 5 * 60_000) };
  return cache;
}

/** Which currency we will really charge, and at what rate. Unsupported currencies fall back to USD. */
export async function chargePlan(preferred?: string) {
  const r = await getRates();
  const want = String(preferred ?? 'USD').toUpperCase();
  const ok = PAYPAL_CURRENCIES.includes(want) && typeof r.rates[want] === 'number';
  const currency = ok ? want : 'USD';
  return { currency, rate: currency === 'USD' ? 1 : r.rates[currency], source: r.source, updatedAt: r.updatedAt, requested: want, converted: ok };
}
