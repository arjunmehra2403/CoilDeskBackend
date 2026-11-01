import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import mongoose from 'mongoose';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { authRouter, requireAuth } from './auth.js';
import { api } from './routes.js';
import { initIO } from './realtime.js';

const { PORT = 4000, MONGO_URL, JWT_SECRET, CORS_ORIGIN = 'http://localhost:3000' } = process.env;
if (!MONGO_URL || !JWT_SECRET) throw new Error('MONGO_URL and JWT_SECRET are required');
const origins = CORS_ORIGIN.split(',');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }), cors({ origin: origins }), compression(), express.json({ limit: '1mb' }));
app.get('/health', (_q, r) => r.json({ ok: mongoose.connection.readyState === 1 }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true }));
app.use('/api/auth', authRouter);
app.use('/api', requireAuth, api);

app.use((err, _req, res, _next) => {
  if (err instanceof ZodError) return res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid id.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

await mongoose.connect(MONGO_URL, { maxPoolSize: 20 });
const server = http.createServer(app);
initIO(server, origins);
server.listen(PORT, () => console.log(`API on :${PORT}`));
process.on('SIGTERM', () => server.close(() => mongoose.disconnect()));
