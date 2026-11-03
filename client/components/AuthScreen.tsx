'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, tokenStore, type User } from '@/lib/api';
import Rangoli from './Rangoli';

type Mode = 'login' | 'signup' | 'verify' | 'forgot' | 'reset';

function OtpBoxes({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const onInput = (i: number, raw: string) => {
    const d = raw.replace(/\D/g, '').slice(-1);
    if (!d) return;
    onChange((value.slice(0, i) + d + value.slice(i + 1)).slice(0, 6));
    refs.current[Math.min(i + 1, 5)]?.focus();
  };
  const onKey = (i: number, e: React.KeyboardEvent) => {
    if (e.key !== 'Backspace') return;
    e.preventDefault();
    if (value[i]) onChange(value.slice(0, i) + value.slice(i + 1));
    else if (i > 0) {
      onChange(value.slice(0, i - 1) + value.slice(i));
      refs.current[i - 1]?.focus();
    }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const t = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (!t) return;
    e.preventDefault();
    onChange(t);
    refs.current[Math.min(t.length, 5)]?.focus();
  };
  return (
    <div className="otp" onPaste={onPaste}>
      {Array.from({ length: 6 }, (_, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          aria-label={`OTP digit ${i + 1}`}
          value={value[i] ?? ''}
          onChange={(e) => onInput(i, e.target.value)}
          onKeyDown={(e) => onKey(i, e)}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}

export default function AuthScreen({ onAuthed }: { onAuthed: (user: User) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [demoCode, setDemoCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [demo, setDemo] = useState<{ enabled: boolean; email: string } | null>(null);
  const [waking, setWaking] = useState(false);

  // Free hosting puts the server to sleep when idle. Keep trying for a while and say what is happening.
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const attempt = () => {
      api.demoInfo()
        .then((d) => {
          if (cancelled) return;
          setDemo(d);
          setWaking(false);
        })
        .catch(() => {
          if (cancelled) return;
          setDemo(null);
          if (++tries < 30) {
            setWaking(true);
            setTimeout(attempt, 4000);
          } else setWaking(false);
        });
    };
    attempt();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const go = (m: Mode) => {
    setMode(m);
    setError('');
    setInfo('');
    setCode('');
    setDemoCode('');
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the server. Is it running?');
    } finally {
      setBusy(false);
    }
  };

  const finish = (r: { token?: string; user?: User }) => {
    if (r.token && r.user) {
      tokenStore.set(r.token);
      onAuthed(r.user);
    }
  };

  const doDemo = () =>
    run(async () => {
      finish(await api.demoLogin());
    });

  const doLogin = () =>
    run(async () => {
      const r = await api.login(email, password);
      if (r.needsVerification) {
        setMode('verify');
        setDemoCode(r.demoCode ?? '');
        setInfo('Please verify your email first. We have sent you a code.');
        setCooldown(30);
      } else finish(r);
    });

  const doSignup = () =>
    run(async () => {
      const r = await api.signup(name, email, password);
      setMode('verify');
      setDemoCode(r.demoCode ?? '');
      setInfo(`We sent a 6-digit code to ${email}.`);
      setCooldown(30);
    });

  const doVerify = () =>
    run(async () => {
      finish(await api.verify(email, code));
    });

  const doForgot = () =>
    run(async () => {
      const r = await api.forgot(email);
      setMode('reset');
      setDemoCode(r.demoCode ?? '');
      setInfo('If that email has an account, we have sent a code.');
      setCooldown(30);
    });

  const doReset = () =>
    run(async () => {
      await api.reset(email, code, newPassword);
      go('login');
      setPassword('');
      setInfo('Password changed. Please log in with your new password.');
    });

  const doResend = () =>
    run(async () => {
      const r = await api.resend(email, mode === 'reset' ? 'reset' : 'signup');
      if (r.demoCode) setDemoCode(r.demoCode);
      setInfo('A new code is on its way.');
      setCooldown(30);
    });

  const titles: Record<Mode, [string, string]> = {
    login: ['Welcome back', 'Log in to your account'],
    signup: ['Create your account', 'It takes a few seconds and it is free'],
    verify: ['Enter your code', 'The 6-digit OTP we sent to your email'],
    forgot: ['Forgot your password?', 'No problem. We will send you a code'],
    reset: ['Set a new password', 'Enter the code and choose a new password'],
  };

  return (
    <main className="auth">
      <section className="auth-art" aria-hidden="true">
        <div className="auth-art-inner">
          <p className="namaste">नमस्ते</p>
          <h1 className="auth-brand">Procure<span>AI</span></h1>
          <p className="auth-tag">An AI buyer that shops the bazaar for you. You just say yes.</p>
          <div className="rangoli-wrap"><Rangoli size={300} /></div>
          <ul className="auth-points">
            <li>Pay from anywhere, in your own currency</li>
            <li>An invoice for every payment, ready to print</li>
            <li>Secure login with OTP</li>
          </ul>
        </div>
      </section>

      <section className="auth-form-side">
        <div className="auth-card">
          <h2>{titles[mode][0]}</h2>
          <p className="auth-sub">{titles[mode][1]}</p>

          {waking && (
            <p className="notice demo" role="status">
              <strong>Waking up the server.</strong> Free hosting sleeps when idle, so this can take up to a minute. This page keeps retrying by itself. (Running locally? Check that the server is started.)
            </p>
          )}
          {info && <p className="notice ok" role="status">{info}</p>}
          {error && <p className="notice bad" role="alert">{error}</p>}
          {mode === 'login' && demo?.enabled && (
            <div className="notice demo">
              <strong>Just looking around?</strong> Use the ready-made demo account. No signup or OTP needed.
              <button type="button" className="btn ghost small" style={{ marginLeft: 10 }} disabled={busy} onClick={doDemo}>Log in as demo</button>
            </div>
          )}
          {demoCode && (mode === 'verify' || mode === 'reset') && (
            <div className="notice demo" role="status">
              <strong>Demo mode.</strong> No email service is connected, so the OTP is shown here: <b className="demo-code">{demoCode}</b>
              <button type="button" className="link-btn" onClick={() => setCode(demoCode)}>Fill it for me</button>
            </div>
          )}

          {(mode === 'login' || mode === 'signup' || mode === 'forgot') && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (mode === 'login') doLogin();
                else if (mode === 'signup') doSignup();
                else doForgot();
              }}
            >
              {mode === 'signup' && (
                <label className="field">Your name
                  <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required minLength={2} />
                </label>
              )}
              <label className="field">Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
              </label>
              {mode !== 'forgot' && (
                <label className="field">Password
                  <span className="pw">
                    <input
                      type={showPw ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                      required
                      minLength={mode === 'signup' ? 8 : 1}
                    />
                    <button type="button" className="link-btn" onClick={() => setShowPw((s) => !s)}>{showPw ? 'Hide' : 'Show'}</button>
                  </span>
                  {mode === 'signup' && <small>At least 8 characters.</small>}
                </label>
              )}
              <button className="btn wide" disabled={busy}>
                {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : mode === 'signup' ? 'Create account' : 'Send code'}
              </button>
            </form>
          )}

          {mode === 'verify' && (
            <form onSubmit={(e) => { e.preventDefault(); doVerify(); }}>
              <OtpBoxes value={code} onChange={setCode} />
              <button className="btn wide" disabled={busy || code.length < 6}>{busy ? 'Please wait…' : 'Verify'}</button>
            </form>
          )}

          {mode === 'reset' && (
            <form onSubmit={(e) => { e.preventDefault(); doReset(); }}>
              <OtpBoxes value={code} onChange={setCode} />
              <label className="field">New password
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" required minLength={8} />
                <small>At least 8 characters.</small>
              </label>
              <button className="btn wide" disabled={busy || code.length < 6}>{busy ? 'Please wait…' : 'Change password'}</button>
            </form>
          )}

          <div className="auth-links">
            {(mode === 'verify' || mode === 'reset') && (
              <button type="button" className="link-btn" onClick={doResend} disabled={busy || cooldown > 0}>
                {cooldown > 0 ? `Resend code (${cooldown}s)` : 'Resend code'}
              </button>
            )}
            {mode === 'login' && (
              <>
                <button type="button" className="link-btn" onClick={() => go('forgot')}>Forgot password?</button>
                <button type="button" className="link-btn strong" onClick={() => go('signup')}>Create a new account</button>
              </>
            )}
            {mode !== 'login' && <button type="button" className="link-btn" onClick={() => go('login')}>Back to log in</button>}
          </div>
          <p className="auth-foot">Demo project. Payments use the PayPal sandbox, so no real money moves.</p>
        </div>
      </section>
    </main>
  );
}
