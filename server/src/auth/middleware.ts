import { runWithStore } from '../store';
import { verifyToken } from './users';

/** Requires "Authorization: Bearer <token>", then runs the rest of the request inside that user's own store. */
export function requireAuth(req: any, res: any, next: any) {
  const header = String(req.headers?.authorization ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  req.user = { id: user.id, email: user.email, name: user.name };
  runWithStore(user.id, () => next());
}
