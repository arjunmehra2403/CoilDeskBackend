// In-process OCR (PaddleOCR PP-OCR models via ONNX) - no Python, no external API.
// live  (precise=false): one pass            -> fast, drives the auto-scan loop
// final (precise=true) : 2 image variants cross-checked, labels snapped to known ones, digit repair.
import Ocr from '@gutenye/ocr-node';
import sharp from 'sharp';
import { closest, distance } from 'fastest-levenshtein';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

let enginePromise;
const engine = () => (enginePromise ??= Ocr.create());

// small concurrency gate so many users cannot exhaust CPU/RAM
const LIMIT = Number(process.env.OCR_CONCURRENCY || 2);
let active = 0; const waiting = [];
async function gate(fn) {
  if (active >= LIMIT) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

const PAIR = /([A-Za-z][A-Za-z0-9 .()\/&_-]{1,32}?)\s*[:;]\s*-?\s*(.*?)(?=\s+[A-Za-z][A-Za-z0-9 .()\/&_-]{1,32}?\s*[:;]|$)/g;
const NUMERIC_KEY = /weight|wt|gsm|size|sheet|qty|quantity|\bnos?\b|date|batch|coil|heat|pkt|thick/i;
const CONFUSE = { O: '0', o: '0', I: '1', l: '1', '|': '1', S: '5', B: '8', Z: '2' };
export const norm = (k) => String(k).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const clean = (v) => v.replace(/^[\s:;\-]+|\s+$/g, '');
const titleIfUpper = (k) => (k === k.toUpperCase() ? k.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : k);

const DEFAULT_KEYS = ['Customer Name', 'Customer', 'Batch No', 'Coil No', 'Mother Coil No', 'Heat No', 'Pkt No', 'Product', 'Grade',
  'Size', 'Coating', 'No of Sheets', 'Net Weight', 'Gross Weight', 'Quality', 'Date', 'Inspected By', 'Vendor', 'Invoice No', 'Quantity'];
const fuzzyPrefix = (key) => new RegExp('^' + [...key.replace(/[^A-Za-z0-9]/g, '')].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s.()\\-]*') + '[\\s:;.\\-]*(.+)$', 'i');

async function variant(buf, kind) {
  let img = sharp(buf, { failOn: 'none' }).rotate().grayscale();
  if (kind === 'live') img = img.resize({ width: 1100 }).normalise();
  else if (kind === 'a') img = img.resize({ width: 1600, withoutEnlargement: false }).clahe({ width: 32, height: 32, maxSlope: 3 });
  else img = img.resize({ width: 2400 }).normalise().sharpen({ sigma: 1.4 });
  return img.jpeg({ quality: 92 }).toBuffer();
}


async function read(buf) {
  const file = path.join(os.tmpdir(), `ocr-${randomUUID()}.jpg`);

  try {
    console.log('[OCR] Writing image:', file);
    await fs.writeFile(file, buf);

    console.log('[OCR] Initializing PaddleOCR engine...');
    const ocr = await engine();

    console.log('[OCR] Engine initialized. Running detection...');
    const result = await ocr.detect(file);

    console.log('[OCR] Detection completed.');
    return result.texts.filter((t) => t.text?.trim());
  } catch (error) {
    console.error('[OCR] FULL ERROR:', error);
    console.error('[OCR] STACK:', error?.stack);
    throw error;
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
  }
}


function parse(lines, known) {
  const fields = []; const unlabeled = [];
  const prefixes = known.map((k) => [k, fuzzyPrefix(k)]);
  for (const l of lines) {
    const text = l.text.normalize('NFKC').trim(); const conf = l.mean ?? 0.5;
    let pairs = [...text.matchAll(PAIR)].map((m) => [m[1].trim().replace(/^([^()]*\([^()]*)$/, '$1)'), clean(m[2])]).filter(([, v]) => v);
    if (!pairs.length) {  // no colon on the label: match the line start against labels we already know
      for (const [k, rx] of prefixes) { const m = text.match(rx); if (m && clean(m[1]).length >= 2) { pairs = [[k, clean(m[1])]]; break; } }
    }
    if (pairs.length) for (const [k, v] of pairs) fields.push({ key: titleIfUpper(k), value: v, confidence: +conf.toFixed(3) });
    else if (/\d/.test(text) && text.length <= 40) unlabeled.push({ text, conf });
  }
  return { fields, unlabeled };
}

function repair(f, known) {
  if (known.length) {
    const best = closest(norm(f.key), known.map(norm));
    const i = known.map(norm).indexOf(best);
    const d = distance(norm(f.key), best);
    if (i >= 0 && d <= Math.max(1, Math.floor(best.length * 0.15))) f.key = known[i];
  }
  if (NUMERIC_KEY.test(f.key)) {
    const alnum = f.value.replace(/[^A-Za-z0-9]/g, '');
    const digits = (f.value.match(/\d/g) || []).length;
    if (digits >= Math.max(2, alnum.length * 0.6) && !/[a-z]{3,}/.test(f.value)) {
      const fixed = f.value.replace(/(?<=\d)[OolI|]|[OolI|](?=\d)/g, (c) => CONFUSE[c]).replace(/^[OolI|](?=[.,]\d)/, (c) => CONFUSE[c]);
      if (fixed !== f.value) { f.value = fixed; f.confidence = +(f.confidence * 0.9).toFixed(3); }
    }
  }
  return f;
}

function merge(passes) {  // agreement boosts confidence, disagreement lowers it so a human verifies
  const best = new Map();
  for (const fields of passes) for (const f of fields) {
    const k = norm(f.key).replace(/ /g, ''); const cur = best.get(k);
    if (!cur) { best.set(k, { ...f }); continue; }
    const same = cur.value.replace(/\W/g, '').toLowerCase() === f.value.replace(/\W/g, '').toLowerCase();
    if (same) cur.confidence = +Math.min(0.99, Math.max(cur.confidence, f.confidence) + 0.08).toFixed(3);
    else { if (f.confidence > cur.confidence) { cur.value = f.value; cur.confidence = f.confidence; } cur.confidence = +(cur.confidence * 0.7).toFixed(3); }
  }
  return [...best.values()];
}

export function extract(buffer, { precise = false, knownKeys = [] } = {}) {
  return gate(async () => {
    const vocab = [...new Set([...knownKeys, ...DEFAULT_KEYS])];
    const a = await read(await variant(buffer, precise ? 'a' : 'live'));
    const pa = parse(a, vocab);
    let fields = pa.fields; let unlabeled = pa.unlabeled; let engineName = 'paddleocr-fast';
    if (precise) {
      const pb = parse(await read(await variant(buffer, 'b')), vocab);
      fields = merge([pa.fields, pb.fields]); engineName = 'paddleocr-crosscheck';
      const f = (t) => t.replace(/\W/g, '').toLowerCase();
      const near = (x, y) => distance(f(x), f(y)) <= Math.max(2, Math.floor(f(x).length * 0.3)) || f(x).includes(f(y)) || f(y).includes(f(x));
      unlabeled = [...pa.unlabeled, ...pb.unlabeled.filter((u) => !pa.unlabeled.some((v) => near(u.text, v.text)))];
    }
    fields = fields.map((f) => repair(f, vocab));
    const flat = (t) => t.normalize('NFKC').replace(/\W/g, '').toLowerCase();
    const have = fields.map((f) => flat(f.value)).filter((v) => v.length >= 4);
    unlabeled = unlabeled.filter((u) => !have.some((v) => flat(u.text).includes(v)));
    // values the engine could read but whose label it could not (blurry/small print): keep them, flagged amber
    unlabeled.slice(0, 12).forEach((u, i) => fields.push({ key: `Unlabeled ${i + 1}`, value: u.text, confidence: Math.min(0.4, u.conf) }));
    const labeled = fields.filter((f) => !f.key.startsWith('Unlabeled'));
    const avg = labeled.length ? labeled.reduce((s, f) => s + f.confidence, 0) / labeled.length : 0;
    return { fields, vendor: null, rawText: a.map((l) => l.text).join('\n'), engine: engineName, complete: labeled.length >= 4 && avg >= 0.55 };
  });
}
