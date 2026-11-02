'use client';
import { useMemo, useState } from 'react';
import { api, type Rates } from '@/lib/api';
import { currencyName } from '@/lib/money';

export interface Ccy { currency: string; country?: string; source: 'gps' | 'locale' | 'manual' | 'default' }

export default function CurrencyPicker({ value, rates, onChange }: { value: Ccy; rates: Rates | null; onChange: (c: Ccy) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const options = useMemo(() => Object.keys(rates?.rates ?? { USD: 1 }).sort(), [rates]);
  const paypalOk = !rates || rates.paypal.includes(value.currency);

  async function detect() {
    setBusy(true);
    setMsg('');
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error('no geolocation'));
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000, maximumAge: 600000 });
      });
      // Rounded to one decimal (about 10 km): we only need the country, not where you are.
      const lat = pos.coords.latitude.toFixed(1);
      const lon = pos.coords.longitude.toFixed(1);
      const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
      const d = await r.json();
      const cc = String(d?.countryCode ?? '');
      if (!cc) throw new Error('no country');
      const info = await api.country(cc);
      onChange({ currency: info.currency, country: info.country, source: 'gps' });
      setMsg(`Detected from your location: ${d.countryName ?? cc}.`);
    } catch {
      try {
        const region = new Intl.Locale(navigator.language).maximize().region ?? '';
        if (!region) throw new Error('no region');
        const info = await api.country(region);
        onChange({ currency: info.currency, country: info.country, source: 'locale' });
        setMsg('Location unavailable, so this is estimated from your browser language. You can change it below.');
      } catch {
        setMsg('Location unavailable. Please choose your currency below.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ccy">
      <div className="ccy-row">
        <button type="button" className="btn ghost small" onClick={detect} disabled={busy}>
          {busy ? 'Locating…' : 'Use my location'}
        </button>
        <label className="ccy-select">
          Currency
          <select
            value={value.currency}
            onChange={(e) => onChange({ currency: e.target.value, country: value.country, source: 'manual' })}
          >
            {options.map((c) => (
              <option key={c} value={c}>{c} · {currencyName(c)}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="ccy-note">
        {value.source === 'default' && 'USD is selected for now. '}
        {paypalOk
          ? `You will pay in ${value.currency}.`
          : `PayPal cannot charge in ${value.currency}, so you will be charged in USD. Amounts shown in ${value.currency} are estimates; your bank converts at its own rate.`}
        {msg && <> {msg}</>}
      </p>
    </div>
  );
}
