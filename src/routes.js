import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { Record, normKey } from './models.js';
import { requireAdmin } from './auth.js';
import { emit } from './realtime.js';
import { extract } from './ocr.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
await fs.mkdir(UPLOAD_DIR, { recursive: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_r, f, cb) => cb(null, /^image\//.test(f.mimetype)) });
export const api = Router();

let labelCache = { at: 0, v: [] };
async function knownLabels() {  // labels users already use (most frequent first) -> system learns from corrections
  if (Date.now() - labelCache.at > 60_000) {
    const r = await Record.aggregate([{ $unwind: '$fields' }, { $group: { _id: '$fields.norm', label: { $first: '$fields.key' }, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 300 }]);
    labelCache = { at: Date.now(), v: r.map((x) => x.label) };
  }
  return labelCache.v;
}

// ---- scan: image -> fields (nothing saved until the user confirms) ----
api.post('/scan/preview', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach an image file.' });
  const precise = req.query.precise === '1';
  let data;
  try { data = await extract(req.file.buffer, { precise, knownKeys: await knownLabels() }); }
  catch (e) { console.error('ocr failed:', e); return res.status(422).json({ error: 'Scanner could not read this image. Try a sharper photo.' }); }
  if (precise) {
    data.imageId = `${randomUUID()}.jpg`;
    await fs.writeFile(path.join(UPLOAD_DIR, data.imageId), req.file.buffer);
  }
  res.json(data);
});

// ---- records ----
const fieldZ = z.object({ key: z.string().trim().min(1).max(80), value: z.string().trim().max(500), confidence: z.number().min(0).max(1).optional() });
const recZ = z.object({
  vendor: z.string().trim().max(120).default(''),
  fields: z.array(fieldZ).min(1).max(60),
  source: z.enum(['scan', 'upload', 'manual']).default('manual'),
  rawText: z.string().max(8000).optional(),
  imageId: z.string().regex(/^[\w-]+\.jpg$/).optional(),
});
function shape(b) {
  const seen = new Set();
  const fields = b.fields.map((f) => ({ ...f, norm: normKey(f.key) })).filter((f) => f.norm && !seen.has(f.norm) && seen.add(f.norm));
  return { vendor: b.vendor, fields, source: b.source, rawText: b.rawText, image: b.imageId };
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function filter(q) {
  const f = {};
  if (q.vendor) f.vendor = q.vendor;
  if (q.q) { const rx = new RegExp(esc(String(q.q).slice(0, 80)), 'i'); f.$or = [{ vendor: rx }, { 'fields.value': rx }]; }
  return f;
}

api.get('/records', async (req, res) => {
  const limit = Math.min(+req.query.limit || 50, 200);
  const f = filter(req.query);
  if (req.query.before) f._id = { $lt: req.query.before };
  const rows = await Record.find(f).sort({ _id: -1 }).limit(limit + 1).select('-rawText').lean();
  res.json({ items: rows.slice(0, limit), hasMore: rows.length > limit });
});
api.get('/vendors', async (_q, res) => res.json(await Record.distinct('vendor', { vendor: { $ne: '' } })));

api.post('/records', async (req, res) => {
  const doc = await Record.create({ ...shape(recZ.parse(req.body)), createdBy: req.user.id, createdByName: req.user.name });
  const out = doc.toObject(); delete out.rawText;
  emit('record:created', out);
  res.status(201).json(out);
});
api.patch('/records/:id', async (req, res) => {
  const doc = await Record.findByIdAndUpdate(req.params.id, shape(recZ.parse(req.body)), { new: true }).select('-rawText').lean();
  if (!doc) return res.status(404).json({ error: 'Record not found.' });
  emit('record:updated', doc);
  res.json(doc);
});
api.delete('/records/:id', requireAdmin, async (req, res) => {
  const doc = await Record.findByIdAndDelete(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Record not found.' });
  if (doc.image) fs.rm(path.join(UPLOAD_DIR, doc.image), { force: true }).catch(() => {});
  emit('record:deleted', { _id: req.params.id });
  res.status(204).end();
});
api.get('/records/:id/image', async (req, res) => {
  const doc = await Record.findById(req.params.id).select('image').lean();
  if (!doc?.image) return res.status(404).end();
  res.sendFile(path.resolve(UPLOAD_DIR, doc.image));
});

// ---- Excel export: streamed, dynamic columns = union of every vendor's keys ----
api.get('/export.xlsx', async (req, res) => {
  const match = filter(req.query);
  const cols = await Record.aggregate([{ $match: match }, { $unwind: '$fields' },
    { $group: { _id: '$fields.norm', label: { $first: '$fields.key' }, n: { $sum: 1 } } }, { $sort: { n: -1, _id: 1 } }]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="coildesk-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  const ws = wb.addWorksheet('Records', { views: [{ state: 'frozen', ySplit: 1, xSplit: 2 }] });
  ws.columns = [{ header: 'Date', key: '_d', width: 18 }, { header: 'Vendor', key: '_v', width: 24 },
    ...cols.map((c) => ({ header: c.label, key: c._id, width: Math.max(14, Math.min(34, c.label.length + 6)) })),
    { header: 'Entered by', key: '_u', width: 16 }, { header: 'Source', key: '_s', width: 10 }];
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4E89' } };
  head.alignment = { vertical: 'middle' }; head.height = 22; head.commit();
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length + 4 } };
  for await (const d of Record.find(match).sort({ _id: -1 }).lean().cursor()) {
    const row = { _d: d.createdAt, _v: d.vendor, _u: d.createdByName, _s: d.source };
    for (const f of d.fields) row[f.norm] = /^-?\d+(\.\d+)?$/.test(f.value) && f.value.length < 15 ? Number(f.value) : f.value;
    ws.addRow(row).commit();
  }
  ws.commit(); await wb.commit();
});
