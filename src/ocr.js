
import Ocr from '@gutenye/ocr-node';
import sharp from 'sharp';
import { closest, distance } from 'fastest-levenshtein';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// --------------------------------------------------
// OCR CONFIGURATION
// --------------------------------------------------

sharp.cache(false);
sharp.concurrency(1);

let enginePromise;

const engine = () => {
  if (!enginePromise) {
    enginePromise = Ocr.create().catch((error) => {
      enginePromise = null;
      throw error;
    });
  }

  return enginePromise;
};

// Only one OCR job at a time for low-memory instances.
const LIMIT = Math.max(
  1,
  Number.parseInt(process.env.OCR_CONCURRENCY || '1', 10) || 1
);

let active = 0;
const waiting = [];

async function gate(fn) {
  if (active >= LIMIT) {
    await new Promise((resolve) => waiting.push(resolve));
  }

  active++;

  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

// Second detection pass is disabled by default.
// Enable only after testing with sufficient RAM.
const SECOND_PASS =
  process.env.OCR_PRECISE_SECOND_PASS === 'true';

// --------------------------------------------------
// FIELD PARSING CONFIGURATION
// --------------------------------------------------

const PAIR =
  /([A-Za-z][A-Za-z0-9 .()\/&_-]{1,32}?)\s*[:;]\s*(.*?)(?=\s+[A-Za-z][A-Za-z0-9 .()\/&_-]{1,32}?\s*[:;]|$)/g;

const NUMERIC_KEY =
  /weight|wt|gsm|size|sheet|qty|quantity|\bnos?\b|date|batch|coil|heat|pkt|thick/i;

const CONFUSE = {
  O: '0',
  o: '0',
  I: '1',
  l: '1',
  '|': '1',
  S: '5',
  B: '8',
  Z: '2'
};

export const norm = (value) =>
  String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

const clean = (value) =>
  String(value)
    .replace(/^[\s:;*\\-]+|[\s*]+$/g, '')
    .trim();

const titleIfUpper = (key) =>
  key === key.toUpperCase()
    ? key.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
    : key;

const DEFAULT_KEYS = [
  'Customer Name',
  'Customer',
  'Batch No',
  'Coil No',
  'Mother Coil No',
  'Heat No',
  'Pkt No',
  'Product',
  'Grade',
  'Size',
  'Coating',
  'No of Sheets',
  'Net Weight',
  'Gross Weight',
  'Quality',
  'Date',
  'Inspected By',
  'Vendor',
  'Invoice No',
  'Quantity'
];

const escapeRegex = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const fuzzyPrefix = (key) => {
  const pattern = key
    .trim()
    .split(/\s+/)
    .map(escapeRegex)
    .join('[\\s.()\\-]*');

  return new RegExp(
    '^' + pattern + '[\\s:;.-]+(.+)$',
    'i'
  );
};

// --------------------------------------------------
// MEMORY LOGGING
// --------------------------------------------------

function logMemory(label) {
  const memory = process.memoryUsage();

  console.log(`[MEMORY] ${label}`, {
    rssMB: Math.round(memory.rss / 1024 / 1024),
    heapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
    externalMB: Math.round(memory.external / 1024 / 1024)
  });
}

// --------------------------------------------------
// IMAGE PREPROCESSING
// --------------------------------------------------

async function variant(buffer, kind) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Invalid or empty image buffer.');
  }

  // Resize to reduce image processing memory.
  // Do not enlarge small images.
  let image = sharp(buffer, {
    failOn: 'none',
    limitInputPixels: 30000000
  })
    .rotate()
    .grayscale();

  if (kind === 'live') {
    image = image
      .resize({
        width: 900,
        withoutEnlargement: true
      })
      .normalise();
  } else {
    image = image
      .resize({
        width: 1200,
        withoutEnlargement: true
      })
      .normalise();
  }

  return image
    .jpeg({ quality: 85 })
    .toBuffer();
}

// --------------------------------------------------
// OCR DETECTION
// --------------------------------------------------

async function read(buffer) {
  const file = path.join(
    os.tmpdir(),
    `ocr-${randomUUID()}.jpg`
  );

  try {
    logMemory('Before image write');

    await fs.writeFile(file, buffer);

    console.log('[OCR] Initializing OCR engine...');

    const ocr = await engine();

    console.log('[OCR] OCR engine ready.');

    logMemory('Before detection');

    console.log('[OCR] Running image detection...');

    const result = await ocr.detect(file);

    console.log('[OCR] Detection completed.');

    logMemory('After detection');

    if (!Array.isArray(result?.texts)) {
      throw new Error('OCR returned an invalid result.');
    }

    return result.texts.filter(
      (item) => item.text?.trim()
    );

  } catch (error) {
    console.error('[OCR] Detection failed:', error);
    console.error('[OCR] Stack:', error?.stack);

    throw error;

  } finally {
    await fs.rm(file, { force: true }).catch(() => { });
  }
}

// --------------------------------------------------
// TEXT PARSING
// --------------------------------------------------

function parse(lines, known) {
  const fields = [];
  const unlabeled = [];

  const prefixes = known.map((key) => [
    key,
    fuzzyPrefix(key)
  ]);

  for (const line of lines) {
    const text = line.text.normalize('NFKC').trim();
    const confidence = line.mean ?? 0.5;

    let pairs = [...text.matchAll(PAIR)]
      .map((match) => [
        match[1].trim(),
        clean(match[2])
      ])
      .filter(([, value]) => value);

    if (!pairs.length) {
      for (const [key, regex] of prefixes) {
        const match = text.match(regex);

        if (match && clean(match[1]).length >= 2) {
          pairs = [[key, clean(match[1])]];
          break;
        }
      }
    }

    if (pairs.length) {
      for (const [key, value] of pairs) {
        fields.push({
          key: titleIfUpper(key),
          value,
          confidence: +confidence.toFixed(3)
        });
      }
    } else if (/\d/.test(text) && text.length <= 40) {
      unlabeled.push({
        text,
        conf: confidence
      });
    }
  }

  return { fields, unlabeled };
}

// --------------------------------------------------
// OCR VALUE REPAIR
// --------------------------------------------------

function repair(field, known) {
  if (known.length) {
    const normalizedKnown = known.map(norm);
    const best = closest(norm(field.key), normalizedKnown);

    const index = normalizedKnown.indexOf(best);
    const diff = distance(norm(field.key), best);

    if (
      index >= 0 &&
      diff <= Math.max(1, Math.floor(best.length * 0.15))
    ) {
      field.key = known[index];
    }
  }

  if (NUMERIC_KEY.test(field.key)) {
    const alphanumeric = field.value.replace(
      /[^A-Za-z0-9]/g,
      ''
    );

    const digits = (field.value.match(/\d/g) || []).length;

    if (
      digits >= Math.max(2, alphanumeric.length * 0.6) &&
      !/[a-z]{3,}/.test(field.value)
    ) {
      const fixed = field.value
        .replace(
          /(?<=\d)[OolI|]|[OolI|](?=\d)/g,
          (character) => CONFUSE[character]
        )
        .replace(
          /^[OolI|](?=[.,]\d)/,
          (character) => CONFUSE[character]
        );

      if (fixed !== field.value) {
        field.value = fixed;
        field.confidence = +(
          field.confidence * 0.9
        ).toFixed(3);
      }
    }
  }

  return field;
}

// --------------------------------------------------
// MULTI-PASS MERGING
// --------------------------------------------------

function merge(passes) {
  const best = new Map();

  for (const fields of passes) {
    for (const field of fields) {
      const key = norm(field.key).replace(/ /g, '');
      const current = best.get(key);

      if (!current) {
        best.set(key, { ...field });
        continue;
      }

      const same =
        current.value.replace(/\W/g, '').toLowerCase() ===
        field.value.replace(/\W/g, '').toLowerCase();

      if (same) {
        current.confidence = +Math.min(
          0.99,
          Math.max(current.confidence, field.confidence) + 0.08
        ).toFixed(3);
      } else {
        if (field.confidence > current.confidence) {
          current.value = field.value;
          current.confidence = field.confidence;
        }

        current.confidence = +(
          current.confidence * 0.7
        ).toFixed(3);
      }
    }
  }

  return [...best.values()];
}

// --------------------------------------------------
// MAIN OCR FUNCTION
// --------------------------------------------------

export function extract(
  buffer,
  {
    precise = false,
    knownKeys = []
  } = {}
) {
  return gate(async () => {
    console.log('[OCR] Starting extraction...');

    logMemory('Extraction started');

    const vocab = [
      ...new Set([
        ...knownKeys,
        ...DEFAULT_KEYS
      ])
    ];

    // First pass
    const firstImage = await variant(
      buffer,
      precise ? 'precise' : 'live'
    );

    const firstLines = await read(firstImage);

    const firstParsed = parse(firstLines, vocab);

    let fields = firstParsed.fields;
    let unlabeled = firstParsed.unlabeled;

    let engineName = precise
      ? 'paddleocr-precise-single-pass'
      : 'paddleocr-fast';

    // Optional second pass.
    // Disabled by default to reduce memory usage.
    if (precise && SECOND_PASS) {
      console.log('[OCR] Starting optional second pass...');

      const secondImage = await variant(
        buffer,
        'precise'
      );

      const secondLines = await read(secondImage);

      const secondParsed = parse(secondLines, vocab);

      fields = merge([
        firstParsed.fields,
        secondParsed.fields
      ]);

      const normalizeText = (value) =>
        value.replace(/\W/g, '').toLowerCase();

      const near = (first, second) =>
        distance(
          normalizeText(first),
          normalizeText(second)
        ) <= Math.max(
          2,
          Math.floor(normalizeText(first).length * 0.3)
        );

      unlabeled = [
        ...firstParsed.unlabeled,
        ...secondParsed.unlabeled.filter(
          (item) =>
            !firstParsed.unlabeled.some(
              (existing) => near(item.text, existing.text)
            )
        )
      ];

      engineName = 'paddleocr-crosscheck';
    }

    fields = fields.map(
      (field) => repair(field, vocab)
    );

    const flat = (value) =>
      value
        .normalize('NFKC')
        .replace(/\W/g, '')
        .toLowerCase();

    const existingValues = fields
      .map((field) => flat(field.value))
      .filter((value) => value.length >= 4);

    unlabeled = unlabeled.filter(
      (item) =>
        !existingValues.some(
          (value) => flat(item.text).includes(value)
        )
    );

    // Preserve readable values whose labels were not identified.
    unlabeled.slice(0, 12).forEach((item, index) => {
      fields.push({
        key: `Unlabeled ${index + 1}`,
        value: item.text,
        confidence: Math.min(0.4, item.conf)
      });
    });

    const labeled = fields.filter(
      (field) => !field.key.startsWith('Unlabeled')
    );

    const averageConfidence = labeled.length
      ? labeled.reduce(
        (sum, field) => sum + field.confidence,
        0
      ) / labeled.length
      : 0;

    const response = {
      fields,
      vendor: null,
      rawText: firstLines
        .map((line) => line.text)
        .join('\n'),
      engine: engineName,
      complete:
        labeled.length >= 4 &&
        averageConfidence >= 0.55
    };

    logMemory('Extraction completed');

    console.log('[OCR] Extraction successful.');

    return response;
  });
}
