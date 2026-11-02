import { Router } from 'express';
import { config } from '../config';
import { demoInfo, demoLogin, forgot, HttpError, login, rateLimit, resend, resetPassword, signup, verifySignup, verifyToken, publicUser } from './users';

export const authRouter = Router();

const handle = (fn: (req: any, res: any) => Promise<unknown> | unknown) => async (req: any, res: any) => {
  try {
    rateLimit(`ip:${req.ip}`, 60, 60_000);
    res.json(await fn(req, res));
  } catch (e: any) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error('[auth]', e);
    res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : e.message, ...(e.extra ?? {}) });
  }
};

// One-click demo account (only when the server has it enabled).
authRouter.get('/demo', handle(() => demoInfo()));
authRouter.post('/demo-login', handle(() => demoLogin()));

authRouter.post('/signup', handle((req) => signup(req.body ?? {})));

authRouter.post('/verify', handle((req) => {
  rateLimit(`verify:${req.ip}`, 20, 10 * 60_000);
  return verifySignup(req.body?.email, req.body?.code);
}));

authRouter.post('/login', handle((req) => {
  rateLimit(`login:${req.ip}`, 15, 15 * 60_000);
  return login(req.body?.email, req.body?.password);
}));

authRouter.post('/resend', handle((req) => resend(req.body?.email, req.body?.purpose)));

// Always answers the same way, whether or not the email has an account.
authRouter.post('/forgot', handle(async (req) => {
  rateLimit(`forgot:${req.ip}`, 10, 15 * 60_000);
  const r: any = await forgot(req.body?.email).catch((e) => {
    if (e instanceof HttpError && e.status === 429) return {}; // cooldown: stay quiet
    throw e;
  });
  return { ok: true, message: 'If that email has an account, we have sent a code.', ...(config.otpDemo && r.demoCode ? { demoCode: r.demoCode } : {}) };
}));

authRouter.post('/reset', handle((req) => {
  rateLimit(`reset:${req.ip}`, 15, 15 * 60_000);
  resetPassword(req.body?.email, req.body?.code, req.body?.newPassword);
  return { ok: true };
}));

authRouter.get('/me', handle((req) => {
  const header = String(req.headers?.authorization ?? '');
  const user = header.startsWith('Bearer ') ? verifyToken(header.slice(7)) : null;
  if (!user) throw new HttpError(401, 'Please log in.');
  return { user: publicUser(user) };
}));
