/**
 * Sends one-time-password emails.
 *  - Brevo (BREVO_API_KEY): HTTPS API, works everywhere including Render free plan.
 *  - Resend (RESEND_API_KEY): HTTPS API, works anywhere.
 *  - Gmail (GMAIL_USER + GMAIL_APP_PASSWORD): SMTP through smtp.gmail.com (blocked on Render free plan).
 */
import { config } from '../config';

export class MailError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Purpose = 'signup' | 'reset';

function buildMessage(code: string, purpose: Purpose) {
  const subject = purpose === 'signup' ? 'Your ProcureAI verification code' : 'Your ProcureAI password reset code';
  const lead = purpose === 'signup' ? 'Use this code to verify your email and finish creating your account.' : 'Use this code to reset your password.';
  const text = `${lead}\n\nYour code: ${code}\n\nIt expires in 5 minutes. If you did not ask for it, you can ignore this email.\n\nProcureAI`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f4fb;font-family:Arial,Helvetica,sans-serif;color:#1f1b4d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border:2px solid #1f1b4d">
<tr><td style="background:#1f1b4d;color:#ffffff;padding:18px 24px;font-size:22px;font-weight:bold">Procure<span style="color:#f4a300">AI</span></td></tr>
<tr><td style="height:6px;background:#f4a300"></td></tr>
<tr><td style="padding:24px">
<p style="margin:0 0 16px;font-size:16px;line-height:1.5">${lead}</p>
<p style="margin:0 0 16px;text-align:center"><span style="display:inline-block;padding:12px 22px;background:#fdebc4;border:2px solid #1f1b4d;font-size:30px;letter-spacing:8px;font-weight:bold;font-family:Consolas,Menlo,monospace">${code}</span></p>
<p style="margin:0;font-size:13px;color:#5b5780;line-height:1.5">It expires in 5 minutes. If you did not ask for it, you can ignore this email.</p>
</td></tr></table></body></html>`;
  return { subject, text, html };
}

let transporter: any;
async function viaGmail(to: string, code: string, purpose: Purpose) {
  if (!transporter) {
    const nm: any = await import('nodemailer');
    const create = nm.createTransport ?? nm.default?.createTransport;
    transporter = create({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: config.gmailUser, pass: config.gmailAppPassword },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  const m = buildMessage(code, purpose);
  await transporter.sendMail({ from: `"ProcureAI" <${config.gmailUser}>`, to, subject: m.subject, text: m.text, html: m.html });
}

async function viaResend(to: string, code: string, purpose: Purpose) {
  const m = buildMessage(code, purpose);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.mailFrom, to: [to], subject: m.subject, text: m.text, html: m.html }),
  });
  if (!res.ok) throw new Error(`Resend answered ${res.status}`);
}

async function viaBrevo(to: string, code: string, purpose: Purpose) {
  const m = buildMessage(code, purpose);
  const apiKey = (config as any).brevoApiKey || (config as any).brevoKey || (config as any).brevoSmtpKey;
  const senderEmail = (config as any).brevoSender || config.mailFrom || config.gmailUser || 'noreply@procureai.app';

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'ProcureAI', email: senderEmail },
      to: [{ email: to }],
      subject: m.subject,
      textContent: m.text,
      htmlContent: m.html,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Brevo API answered ${res.status}: ${errBody.slice(0, 100)}`);
  }
}

/** Short, secret-free reason for the server log. */
function why(e: any): string {
  const detail = [e?.code, e?.responseCode].filter(Boolean).join(' ');
  const hint =
    e?.code === 'EAUTH'
      ? ' (Mail provider refused login/key: check your API credentials)'
      : /ETIMEDOUT|ESOCKET|ECONNECTION|ECONNREFUSED/.test(String(e?.code))
        ? ' (could not reach the mail server)'
        : '';
  return `${detail} ${String(e?.message ?? e).slice(0, 120)}${hint}`.trim();
}

let usage = { day: '', n: 0 };

/** Sends the code. Does nothing when no provider is configured (demo mode shows the code on screen instead). */
export async function sendOtpEmail(to: string, code: string, purpose: Purpose): Promise<void> {
  if (!config.mailProvider) return;
  const day = new Date().toISOString().slice(0, 10);
  if (usage.day !== day) usage = { day, n: 0 };
  if (usage.n >= config.maxEmailsPerDay) throw new MailError(429, 'The daily email limit for this app has been reached. Please try again tomorrow.');
  usage.n++;
  try {
    const provider = String(config.mailProvider).toLowerCase();
    if (provider === 'brevo') {
      await viaBrevo(to, code, purpose);
    } else if (provider === 'gmail') {
      await viaGmail(to, code, purpose);
    } else if (provider === 'resend') {
      await viaResend(to, code, purpose);
    }
  } catch (e: any) {
    console.error(`[mail] sending through ${config.mailProvider} failed: ${why(e)}`);
    throw new MailError(502, 'We could not send the email right now. Please try again in a minute.');
  }
}