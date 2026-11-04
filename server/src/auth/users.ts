import { createHash, createHmac, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { persistence } from '../persistence';
import { sendOtpEmail } from '../services/mailer';

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  verified: boolean;
  tokenVersion: number;
  createdAt: string;
}
export type PublicUser = { id: string; email: string; name: string };
const pub = (u: User): PublicUser => ({ id: u.id, email: u.email, name: u.name });

// ---- storage ---------------------------------------------------------------------------------

try {
  fs.mkdirSync(config.dataDir, { recursive: true });
} catch {
  /* read-only disk: AUTH_SECRET must then be set */
}
const secretFile = path.join(config.dataDir, 'auth-secret.key');
const users = new Map<string, User>(); // by email

/** Loads the saved accounts. Call once at startup, after persistence.init(). */
export async function initAuth() {
  for (const u of await persistence.loadUsers()) users.set(u.email, u);
}
const persistUser = (u: User) => persistence.saveUser(u);

function loadSecret(): string {
  if (config.authSecret) return config.authSecret;
  try {
    return fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    const s = randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(secretFile, s);
    } catch {
      console.warn('WARNING: could not save a login secret. Set AUTH_SECRET, or everyone is signed out whenever the server restarts.');
    }
    return s;
  }
}
const SECRET = loadSecret();

// ---- small helpers -----------------------------------------------------------------------------

const hits = new Map<string, number[]>();
export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
  recent.push(now);
  hits.set(key, recent);
}

export const normEmail = (e: unknown) => String(e ?? '').trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const isDemo = (email: string) => config.demoAccount && email === normEmail(config.demoEmail);

function checkEmail(email: string) {
  if (!EMAIL.test(email) || email.length > 120) throw new HttpError(400, 'Please enter a valid email address.');
}
function checkPassword(pw: unknown): string {
  const s = String(pw ?? '');
  if (s.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (s.length > 128) throw new HttpError(400, 'Password is too long.');
  return s;
}

function hashPassword(pw: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(pw, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- tokens ---------------------------------------------------------------------------------------

const TOKEN_DAYS = 7;
function signToken(u: User): string {
  const body = Buffer.from(JSON.stringify({ uid: u.id, v: u.tokenVersion, exp: Date.now() + TOKEN_DAYS * 864e5 })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token: string): User | null {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const expect = createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!(p.exp > Date.now())) return null;
    const u = [...users.values()].find((x) => x.id === p.uid);
    return u && u.verified && u.tokenVersion === p.v ? u : null;
  } catch {
    return null;
  }
}

// ---- one-time passwords ----------------------------------------------------------------------------

type Purpose = 'signup' | 'reset';
interface Otp { hash: string; expires: number; attempts: number; sentAt: number }
const otps = new Map<string, Otp>();
const OTP_TTL = 5 * 60_000;
const OTP_COOLDOWN = 30_000;
const OTP_MAX_ATTEMPTS = 5;

const hashCode = (email: string, purpose: Purpose, code: string) =>
  createHash('sha256').update(`${SECRET}|${email}|${purpose}|${code}`).digest('hex');

async function deliver(email: string, code: string, purpose: Purpose) {
  if (config.otpDemo) console.log(`[OTP ${purpose}] ${email} -> ${code}   (demo mode: also shown on screen)`);
  if (!config.mailProvider) return;
  try {
    await sendOtpEmail(email, code, purpose);
  } catch (e: any) {
    if (config.otpDemo) return; // the code is on screen anyway
    throw new HttpError(e?.status ?? 502, e?.message ?? 'We could not send the email right now. Please try again.');
  }
}

/** At most 5 codes per hour to one address, so the form cannot be used to flood someone's inbox. */
const sentLog = new Map<string, number[]>();
function checkAddressCap(email: string) {
  const now = Date.now();
  const recent = (sentLog.get(email) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= 5) throw new HttpError(429, 'Too many codes were sent to this address. Please try again in an hour.');
  recent.push(now);
  sentLog.set(email, recent);
}

export async function issueOtp(email: string, purpose: Purpose): Promise<{ demoCode?: string }> {
  const key = `${purpose}:${email}`;
  const prev = otps.get(key);
  if (prev && Date.now() - prev.sentAt < OTP_COOLDOWN) {
    throw new HttpError(429, `Please wait ${Math.ceil((OTP_COOLDOWN - (Date.now() - prev.sentAt)) / 1000)}s before asking for another code.`);
  }
  checkAddressCap(email);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  otps.set(key, { hash: hashCode(email, purpose, code), expires: Date.now() + OTP_TTL, attempts: 0, sentAt: Date.now() });
  try {
    await deliver(email, code, purpose);
  } catch (e) {
    otps.delete(key); // nothing was delivered, so do not make the person wait out the cooldown
    throw e;
  }
  return config.otpDemo ? { demoCode: code } : {};
}

function checkOtp(email: string, purpose: Purpose, code: unknown): boolean {
  const key = `${purpose}:${email}`;
  const o = otps.get(key);
  if (!o) return false;
  if (Date.now() > o.expires || ++o.attempts > OTP_MAX_ATTEMPTS) {
    otps.delete(key);
    return false;
  }
  const ok = hashCode(email, purpose, String(code ?? '').trim()) === o.hash;
  if (ok) otps.delete(key);
  return ok;
}

// ---- account actions ----------------------------------------------------------------------------------

export async function signup(input: { name: unknown; email: unknown; password: unknown }) {
  const email = normEmail(input.email);
  checkEmail(email);
  const name = String(input.name ?? '').trim();
  if (name.length < 2 || name.length > 60) throw new HttpError(400, 'Please enter your name (2 to 60 characters).');
  const password = checkPassword(input.password);

  const existing = users.get(email);
  if (existing?.verified) throw new HttpError(409, 'An account with this email already exists. Please log in.');

  const user: User = existing ?? { id: randomUUID(), email, name, passwordHash: '', verified: false, tokenVersion: 0, createdAt: new Date().toISOString() };
  user.name = name;
  user.passwordHash = hashPassword(password); // an unverified signup may be retried with a new password
  users.set(email, user);
  await persistUser(user);

  return { needsVerification: true, email, ...(await issueOtp(email, 'signup')) };
}

export async function verifySignup(emailRaw: unknown, code: unknown) {
  const email = normEmail(emailRaw);
  const user = users.get(email);
  if (!user || user.verified) throw new HttpError(400, 'That code is not valid. Please check it or ask for a new one.');
  if (!checkOtp(email, 'signup', code)) throw new HttpError(400, 'That code is wrong or has expired.');
  user.verified = true;
  await persistUser(user);
  return { token: signToken(user), user: pub(user) };
}

export async function login(emailRaw: unknown, password: unknown) {
  const email = normEmail(emailRaw);
  const user = users.get(email);
  // Same message for "no such user" and "wrong password" so the form does not reveal who has an account.
  if (!user || !verifyPassword(String(password ?? ''), user.passwordHash)) throw new HttpError(401, 'Wrong email or password.');
  if (!user.verified) return { needsVerification: true, email, ...(await issueOtp(email, 'signup').catch(() => ({}))) };
  return { token: signToken(user), user: pub(user) };
}

export async function resend(emailRaw: unknown, purpose: unknown) {
  const email = normEmail(emailRaw);
  const p: Purpose = purpose === 'reset' ? 'reset' : 'signup';
  const user = users.get(email);
  if (!user || (p === 'signup' && user.verified) || (p === 'reset' && !user.verified)) return {}; // generic: reveal nothing
  return issueOtp(email, p);
}

export async function forgot(emailRaw: unknown) {
  const email = normEmail(emailRaw);
  checkEmail(email);
  const user = users.get(email);
  if (!user || !user.verified || isDemo(email)) return {};
  return issueOtp(email, 'reset');
}

export async function resetPassword(emailRaw: unknown, code: unknown, newPassword: unknown) {
  const email = normEmail(emailRaw);
  if (isDemo(email)) throw new HttpError(400, 'The demo account password cannot be changed.');
  const password = checkPassword(newPassword);
  const user = users.get(email);
  if (!user || !user.verified || !checkOtp(email, 'reset', code)) throw new HttpError(400, 'That code is wrong or has expired.');
  user.passwordHash = hashPassword(password);
  user.tokenVersion += 1; // signs out every old session
  await persistUser(user);
}

export const publicUser = pub;

// ---- demo account ---------------------------------------------------------------------------------------

/** Creates the shared demo user on startup (when enabled). Returns its id, or null when the demo account is off. */
export async function ensureDemoUser(): Promise<string | null> {
  if (!config.demoAccount) return null;
  const email = normEmail(config.demoEmail);
  let u = users.get(email);
  if (!u) {
    u = { id: randomUUID(), email, name: 'Demo Buyer', passwordHash: hashPassword(config.demoPassword), verified: true, tokenVersion: 0, createdAt: new Date().toISOString() };
    users.set(email, u);
    await persistUser(u);
  } else if (!u.verified) {
    u.verified = true;
    await persistUser(u);
  }
  return u.id;
}

export const demoInfo = () => ({ enabled: config.demoAccount, email: config.demoEmail });

export function demoLogin() {
  if (!config.demoAccount) throw new HttpError(404, 'The demo account is not enabled on this server.');
  const u = users.get(normEmail(config.demoEmail));
  if (!u) throw new HttpError(404, 'The demo account is not set up yet. Restart the server.');
  return { token: signToken(u), user: pub(u) };
}
