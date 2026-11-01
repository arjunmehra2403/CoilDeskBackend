import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { UserModel } from './models.js';

const sign = (u) => jwt.sign({ id: u.id, name: u.name, role: u.role }, process.env.JWT_SECRET, { expiresIn: '12h' });
const pub = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

export function requireAuth(req, res, next) {
  try { req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expired. Sign in again.' }); }
}
export const requireAdmin = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required.' });

export const authRouter = Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true });
const creds = z.object({ email: z.string().email(), password: z.string().min(8).max(100) });

authRouter.get('/status', async (_q, res) => res.json({ needsSetup: (await UserModel.estimatedDocumentCount()) === 0 }));

// First account becomes admin; after that only admins create users.
authRouter.post('/register', limiter, async (req, res, next) => {
  const first = (await UserModel.estimatedDocumentCount()) === 0;
  if (!first) return requireAuth(req, res, () => requireAdmin(req, res, () => create(req, res, false)));
  return create(req, res, true);
});
async function create(req, res, first) {
  const body = creds.extend({ name: z.string().trim().min(2).max(60), role: z.enum(['admin', 'operator']).optional() }).parse(req.body);
  if (await UserModel.exists({ email: body.email.toLowerCase() })) return res.status(409).json({ error: 'Email already registered.' });
  const u = await UserModel.create({ ...body, role: first ? 'admin' : body.role || 'operator', password: await bcrypt.hash(body.password, 11) });
  res.status(201).json({ user: pub(u), token: first ? sign(u) : undefined });
}
authRouter.post('/login', limiter, async (req, res) => {
  const { email, password } = creds.parse(req.body);
  const u = await UserModel.findOne({ email: email.toLowerCase() }).select('+password');
  if (!u || !(await bcrypt.compare(password, u.password))) return res.status(401).json({ error: 'Wrong email or password.' });
  res.json({ user: pub(u), token: sign(u) });
});
