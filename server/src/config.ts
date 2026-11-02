import 'dotenv/config';
import path from 'path';

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : fallback;
};

// Demo mode: the OTP is shown on screen. In that state anyone can already create an account, so a public demo login adds no extra exposure.
const otpDemo = process.env.OTP_DEMO_MODE ? process.env.OTP_DEMO_MODE === 'true' : !process.env.RESEND_API_KEY;

export const config = {
  port: num(process.env.PORT, 5000),
  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
  serverUrl: process.env.SERVER_URL || 'http://localhost:5000',

  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',

  geminiKey: process.env.GEMINI_API_KEY || '',
  // gemini-2.5-flash was closed to new accounts, so default to the alias that always points at the current flash model.
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',

  paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
  paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
  // Only sandbox is wired up on purpose: this is a demo, not a production payments system.
  paypalBase: 'https://api-m.sandbox.paypal.com',

  channel3Key: process.env.CHANNEL3_API_KEY || '',

  budgetTotal: num(process.env.BUDGET_TOTAL, 5000),
  budgetPerPurchase: num(process.env.BUDGET_PER_PURCHASE, 1500),

  // --- accounts ---
  authSecret: process.env.AUTH_SECRET || '',
  resendKey: process.env.RESEND_API_KEY || '',
  mailFrom: process.env.MAIL_FROM || 'ProcureAI <onboarding@resend.dev>',
  // Demo mode shows the OTP on screen (and in the server log) because no email provider is configured.
  otpDemo,
  // A ready-made account for judges: one click on the login screen, no signup. Everyone who uses it shares its data.
  demoAccount: process.env.DEMO_ACCOUNT ? process.env.DEMO_ACCOUNT === 'true' : otpDemo,
  demoEmail: process.env.DEMO_EMAIL || 'demo@procureai.app',
  demoPassword: process.env.DEMO_PASSWORD || 'Demo#ProcureAI1',
  // Cap on AI-agent runs per day (all users together). After that the built-in scripted agent is used, so a hosted demo cannot burn your API quota.
  aiRunsPerDay: num(process.env.AI_RUNS_PER_DAY, 100),
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
};

export const modes = {
  agent: config.geminiKey ? 'gemini' : config.anthropicKey ? 'claude' : 'scripted-demo',
  catalog: config.channel3Key ? 'channel3' : 'mock',
  payments: config.paypalClientId && config.paypalClientSecret ? 'paypal-sandbox' : 'mock',
  otp: config.resendKey ? 'email' : 'demo-screen',
} as const;

if (Boolean(config.paypalClientId) !== Boolean(config.paypalClientSecret)) {
  console.warn('WARNING: only one of PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET is set. Falling back to MOCK payments.');
}
if (!config.otpDemo && !config.resendKey) {
  console.warn('WARNING: OTP_DEMO_MODE=false but RESEND_API_KEY is empty. Nobody will receive OTP codes.');
}
