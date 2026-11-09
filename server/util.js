import crypto from 'node:crypto';

/** URL-safe random id. 16 bytes ≈ 128 bits — unguessable, used as capability tokens. */
export const rid = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** A single file or folder name: no path separators, no control characters. */
export function cleanName(value, fallback = 'file') {
  let s = typeof value === 'string' ? value : '';
  s = s.replace(CONTROL, '').replace(/[\\/]/g, '_').trim();
  if (s === '.' || s === '..') s = '';
  if (s.length > 255) s = s.slice(0, 255);
  return s || fallback;
}

/**
 * A relative path, always with "/" separators.
 * Drops empty, "." and ".." segments so nothing can ever land outside its folder.
 */
export function cleanRelPath(value) {
  if (typeof value !== 'string') return '';
  return value
    .split(/[\\/]+/)
    .map((seg) => seg.replace(CONTROL, '').trim().slice(0, 255))
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Make a name valid on Windows (and harmless elsewhere): no <>:"|?*, no trailing dots or spaces. */
export function safeFileName(value, fallback = 'file') {
  let s = cleanName(value, fallback).replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '');
  if (WIN_RESERVED.test(s)) s = `_${s}`;
  return s || fallback;
}

/** A short human label (device names, notices). */
export function cleanLabel(value, max = 40) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function safeInt(value) {
  const n = typeof value === 'string' && value !== '' ? Number(value) : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

const rfc5987 = (s) =>
  encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Content-Disposition that survives non-ASCII names in every browser. */
export function contentDisposition(name, inline = false) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${rfc5987(name)}`;
}

export async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson(req, limit = 1024 * 1024) {
  const text = await readBody(req, limit);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

/** Run `fn` over `items` with at most `limit` in flight; keeps order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function withTimeout(promise, ms, message = 'Timed out.') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new HttpError(504, message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
