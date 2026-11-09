/**
 * HTTP: the web app, the JSON API, downloads (files with resume, folders as streaming ZIPs),
 * uploads into any folder on any device, and the byte pipes agents use.
 *
 * Access: every API call and WebSocket needs the session key (cookie set by the invite
 * link, or the x-es-key header). Requests from the host machine itself are always allowed.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform, pipeline } from 'node:stream';
import QRCode from 'qrcode';
import { planZip, writeZip } from './zip.js';
import { previewType } from './kinds.js';
import { isAllowedHost, isLocalAddress, normIp } from './net.js';
import { HttpError, contentDisposition, cleanName, cleanLabel, readJson, safeInt, rid, withTimeout } from './util.js';
import { log } from './log.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "frame-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Inline previews run in a sandbox so a shared .svg or .html can never script this page. */
const PREVIEW_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; object-src 'self'";

const ZIP_TTL = 30 * 60_000;

export function createHandler({ hub, root, key }) {
  const publicDir = path.join(root, 'public');
  const font = (pkg, file) => path.join(root, 'node_modules', '@fontsource-variable', pkg, 'files', file);
  const FONTS = {
    'inter.woff2': font('inter', 'inter-latin-wght-normal.woff2'),
    'inter-ext.woff2': font('inter', 'inter-latin-ext-wght-normal.woff2'),
    'space-grotesk.woff2': font('space-grotesk', 'space-grotesk-latin-wght-normal.woff2'),
    'jetbrains-mono.woff2': font('jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2'),
  };
  const STATIC = {
    '/': path.join(publicDir, 'index.html'),
    '/index.html': path.join(publicDir, 'index.html'),
    '/styles.css': path.join(publicDir, 'styles.css'),
    '/app.js': path.join(publicDir, 'app.js'),
    '/icons.js': path.join(publicDir, 'icons.js'),
    '/favicon.svg': path.join(publicDir, 'favicon.svg'),
    '/manifest.webmanifest': path.join(publicDir, 'manifest.webmanifest'),
    '/kinds.js': path.join(root, 'server', 'kinds.js'),
  };
  const zips = new Map();
  const qrCache = new Map();
  const keyBuf = key ? Buffer.from(key) : null;

  // ───────────── access ─────────────

  function keyMatches(candidate) {
    if (!keyBuf || typeof candidate !== 'string') return false;
    const c = Buffer.from(candidate);
    return c.length === keyBuf.length && crypto.timingSafeEqual(c, keyBuf);
  }

  function cookieKey(req) {
    const m = /(?:^|;\s*)es_key=([^;]+)/.exec(req.headers.cookie || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  /** Shared with the WebSocket upgrade handlers in index.js. */
  function authorized(req, url) {
    if (!keyBuf) return true;
    if (isLocalAddress(req.socket.remoteAddress)) return true;
    return keyMatches(cookieKey(req)) || keyMatches(req.headers['x-es-key']) || keyMatches(url?.searchParams.get('key'));
  }

  // ───────────── helpers ─────────────

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function notFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  async function serveFile(req, res, file, { cache = 'no-cache', csp = false } = {}) {
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      return notFound(res);
    }
    const etag = `"${st.size.toString(36)}-${Math.trunc(st.mtimeMs).toString(36)}"`;
    const headers = {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': cache,
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (csp) headers['Content-Security-Policy'] = CSP;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    headers['Content-Length'] = String(st.size);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  const ipOf = (req) => normIp(req.socket.remoteAddress);

  function joinV(dir, name) {
    return `${String(dir).replace(/\/+$/, '')}/${name}`;
  }

  /** Counts bytes into a transfer and enforces the exact expected length. */
  function counter(t, expected) {
    let seen = 0;
    return new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (expected != null && seen > expected) return cb(new Error('Source sent more data than expected.'));
        if (t) t.bytes += chunk.length;
        cb(null, chunk);
      },
      flush(cb) {
        cb(expected == null || seen === expected ? null : new Error('Source ended early.'));
      },
    });
  }

  function parseRange(req, size, etag, mtimeMs) {
    const header = req.headers.range;
    if (!header || size === 0) return null;
    const ifRange = req.headers['if-range'];
    if (ifRange) {
      if (ifRange.startsWith('"') || ifRange.startsWith('W/')) {
        if (ifRange !== etag) return null;
      } else if (!(Date.parse(ifRange) >= Math.floor(mtimeMs / 1000) * 1000)) {
        return null;
      }
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m) return null;
    let start;
    let end;
    if (m[1] === '') {
      if (m[2] === '') return null;
      const n = Number(m[2]);
      if (n === 0) return 'invalid';
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    if (start > end || start >= size) return 'invalid';
    return { start, end };
  }

  // ───────────── downloads ─────────────

  /** GET /api/file?dev=&path=&c=[&inline=1] — one file, resumable. */
  async function sendFile(req, res, url) {
    const dev = hub.device(url.searchParams.get('dev'));
    const p = url.searchParams.get('path') || '';
    const inline = url.searchParams.get('inline') === '1';
    const st = await dev.stat(p);
    if (st.dir) throw new HttpError(400, 'That is a folder — download it as a ZIP.');
    const etag = `"${st.size.toString(36)}-${Math.trunc(st.mtime).toString(36)}"`;
    const range = parseRange(req, st.size, etag, st.mtime);
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : Math.max(0, st.size - 1);
    const length = st.size === 0 ? 0 : end - start + 1;
    const type = inline ? previewType(st.name) : null;
    const headers = {
      'Content-Type': type || 'application/octet-stream',
      'Content-Length': String(length),
      'Content-Disposition': contentDisposition(st.name, inline && Boolean(type)),
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': new Date(st.mtime).toUTCString(),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (inline) headers['Content-Security-Policy'] = PREVIEW_CSP;
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    const status = range ? 206 : 200;
    if (req.method === 'HEAD') {
      res.writeHead(status, headers);
      return res.end();
    }
    const { stream } = await dev.openRead(p, start, end);
    res.writeHead(status, headers);
    const t = inline
      ? null
      : hub.startTransfer({ dir: 'down', kind: 'file', name: st.name, devId: dev.id, path: p, clientId: url.searchParams.get('c'), ip: ipOf(req), total: length });
    if (t) {
      t.resumedFrom = range ? start : 0;
      t.abort = () => {
        stream.destroy();
        res.destroy();
      };
    }
    pipeline(stream, counter(t, length), res, (err) => {
      if (!t) return;
      if (err) hub.endTransfer(t, t.cancelRequested || res.destroyed ? 'canceled' : 'failed', err.message);
      else hub.endTransfer(t, 'done');
    });
  }

  /** POST /api/zip {dev, dir, names, name} → a short-lived link that streams them as one ZIP. */
  async function prepareZip(req, res) {
    const body = await readJson(req);
    hub.device(body.dev);
    const names = (Array.isArray(body.names) ? body.names : []).map((n) => cleanName(n, '')).filter(Boolean).slice(0, 20_000);
    if (!names.length) throw new HttpError(400, 'Select something to download.');
    const dir = String(body.dir || '');
    if (!dir) throw new HttpError(400, 'Missing folder.');
    const token = rid();
    const fallback = names.length === 1 ? names[0] : dir.split('/').filter(Boolean).pop() || 'Files';
    const zipName = `${cleanName(body.name || fallback, 'Files').replace(/\.zip$/i, '')}.zip`;
    zips.set(token, { dev: body.dev, dir, names, zipName, created: Date.now() });
    for (const [k, v] of zips) if (Date.now() - v.created > ZIP_TTL) zips.delete(k);
    json(res, 200, { url: `/api/zip/${token}/${encodeURIComponent(zipName)}` });
  }

  /** GET /api/zip/<token>/<name>?c= — sizes are known up front, so the browser shows real progress. */
  async function sendZip(req, res, token, url) {
    const job = zips.get(token);
    if (!job) throw new HttpError(410, 'That download link expired — select the items again.');
    const dev = hub.device(job.dev);
    const entries = [];
    for (const n of job.names) {
      const vp = joinV(job.dir, n);
      const w = await dev.walk(vp);
      if (!w.dir) {
        entries.push({ name: n, size: w.files[0].size, mtime: w.files[0].mtime, path: vp });
        continue;
      }
      if (!w.files.length && !(w.emptyDirs || []).length) entries.push({ name: `${n}/`, size: 0, mtime: Date.now(), dirEntry: true });
      for (const f of w.files) entries.push({ name: `${n}/${f.path}`, size: f.size, mtime: f.mtime, path: `${vp}/${f.path}` });
      for (const d of w.emptyDirs || []) entries.push({ name: `${n}/${d}/`, size: 0, mtime: Date.now(), dirEntry: true });
    }
    const plan = planZip(entries);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': String(plan.total),
      'Content-Disposition': contentDisposition(job.zipName),
      'Accept-Ranges': 'none',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    const t = hub.startTransfer({
      dir: 'down', kind: 'zip', name: job.zipName, devId: dev.id, path: job.dir,
      clientId: url.searchParams.get('c'), ip: ipOf(req), total: plan.total, files: entries.filter((e) => !e.dirEntry).length,
    });
    let current = null;
    t.abort = () => {
      current?.destroy();
      res.destroy();
    };
    res.once('close', () => {
      if (!res.writableFinished) current?.destroy();
    });
    try {
      await writeZip(
        res,
        plan,
        async (_rec, i) => {
          const e = entries[i];
          if (e.dirEntry) return [];
          const { stream } = await dev.openRead(e.path, 0, null);
          current = stream;
          stream.once('end', () => {
            t.filesDone++;
          });
          return stream;
        },
        (n) => (t.bytes += n),
      );
      res.end();
      hub.endTransfer(t, 'done');
    } catch (e) {
      res.destroy();
      hub.endTransfer(t, t.cancelRequested ? 'canceled' : 'failed', e.message);
      if (!/closed the connection/.test(e.message)) log.warn(`ZIP “${job.zipName}” stopped:`, e.message);
    }
  }

  // ───────────── uploads ─────────────

  /** POST /api/upload/begin {dev, dir, tops: [{name, dir}], files, bytes, c} */
  async function beginUpload(req, res) {
    const body = await readJson(req);
    const dev = hub.device(body.dev);
    const dir = String(body.dir || '');
    const tops = (Array.isArray(body.tops) ? body.tops : [])
      .map((t) => ({ name: typeof t?.name === 'string' ? t.name : '', dir: Boolean(t?.dir) }))
      .filter((t) => t.name);
    if (!dir || !tops.length) throw new HttpError(400, 'Nothing to send.');
    const names = await dev.reserve(dir, tops);
    const label = tops.length === 1 ? names[0] : cleanLabel(body.label, 80) || `${tops.length} items`;
    const b = hub.createBatch({ devId: dev.id, dir, label, files: safeInt(body.files) ?? tops.length, bytes: safeInt(body.bytes), clientId: body.c, ip: ipOf(req) });
    if (tops.some((t) => t.dir)) hub.folderChanged(dev.id, dir);
    json(res, 200, { batch: b.id, names, transfer: b.t.id });
  }

  /** PUT /api/upload?batch=&rel=&size=&mtime= — the raw file bytes are the body. */
  async function putUpload(req, res, url) {
    const b = hub.batches.get(url.searchParams.get('batch') || '');
    if (!b) {
      req.resume();
      throw new HttpError(410, 'This send was canceled or has finished.');
    }
    const dev = hub.device(b.devId);
    const rel = url.searchParams.get('rel') || '';
    const size = safeInt(url.searchParams.get('size'));
    const mtime = safeInt(url.searchParams.get('mtime'));
    b.reqs.add(req);
    b.touched = Date.now();
    try {
      const result = await dev.receive(b.dir, rel, size, mtime, req, (n) => {
        b.t.bytes += n;
        b.touched = Date.now();
      });
      b.done++;
      b.t.filesDone = b.done;
      json(res, 200, result);
    } catch (e) {
      b.failed++;
      b.lastError = e.message;
      throw e;
    } finally {
      b.reqs.delete(req);
      if (hub.batches.has(b.id) && b.done + b.failed >= b.expected) {
        hub.finishBatch(b, b.failed ? 'failed' : 'done', b.failed ? `${b.failed} of ${b.expected} files couldn't be saved: ${b.lastError}` : null);
      }
    }
  }

  /** POST /api/upload/end {batch, state: 'canceled' | 'done'} */
  async function endUpload(req, res) {
    const body = await readJson(req);
    const b = hub.batches.get(body.batch);
    if (b) hub.finishBatch(b, body.state === 'canceled' ? 'canceled' : b.failed ? 'failed' : 'done', b.failed ? b.lastError : null);
    json(res, 200, { ok: true });
  }

  // ───────────── join kit ─────────────

  /**
   * GET /api/join-kit[?os=termux] — everything another device needs to put its files in this
   * session, as one ZIP: the app, its modules, a launcher with the invite link filled in, and
   * (for Windows, when the host runs Windows) a portable node.exe so nothing has to be installed.
   */
  async function joinKit(req, res, url) {
    const termux = url.searchParams.get('os') === 'termux';
    const access = hub.accessInfo();
    const q = key ? `/?key=${key}` : '/';
    // The address that reached us is the one that works from that device (LAN, Tailscale IP or MagicDNS).
    const link = isLocalAddress(req.socket.remoteAddress) || !req.headers.host ? access.lan || `${access.local}${q}` : `http://${req.headers.host}${q}`;
    const hostName = hub.hostName();
    const top = 'Explorer Share';
    const entries = [];
    const skip = new Set(['.git', '.cache', '.vscode', 'scratch']);
    const add = async (abs, rel) => {
      const st = await fsp.stat(abs).catch(() => null);
      if (!st) return;
      if (st.isFile()) return entries.push({ name: rel, size: st.size, mtime: st.mtimeMs, abs });
      for (const e of await fsp.readdir(abs, { withFileTypes: true })) {
        if (e.isDirectory() && !skip.has(e.name)) await add(path.join(abs, e.name), `${rel}/${e.name}`);
        else if (e.isFile() && !e.name.endsWith('.log')) await add(path.join(abs, e.name), `${rel}/${e.name}`);
      }
    };
    for (const part of ['server', 'public', 'node_modules', 'package.json', 'README.md']) await add(path.join(root, part), `${top}/${part}`);
    const text = (name, body) => {
      const buf = Buffer.from(termux ? body : body.replace(/\r?\n/g, '\r\n'), 'utf8');
      entries.push({ name: `${top}/${name}`, size: buf.length, mtime: Date.now(), buf });
    };
    const safeHost = hostName.replace(/[^\w .-]/g, '');
    if (termux) {
      text('join.sh', `#!/bin/sh\n# Puts this phone's storage in the Explorer Share session on ${safeHost}.\ncd "$(dirname "$0")" || exit 1\nexec node server/index.js --join "${link}" "$@"\n`);
    } else {
      if (process.platform === 'win32') {
        const st = await fsp.stat(process.execPath).catch(() => null);
        if (st) entries.push({ name: `${top}/node/node.exe`, size: st.size, mtime: st.mtimeMs, abs: process.execPath });
      }
      text(
        'Join session.bat',
        [
          '@echo off',
          'setlocal',
          `title Explorer Share - this PC is in the session on ${safeHost} (close this window to leave)`,
          'cd /d "%~dp0"',
          'chcp 65001 >nul',
          'set "NODE=%~dp0node\\node.exe"',
          'if not exist "%NODE%" set "NODE=node"',
          'if "%NODE%"=="node" (',
          '  where node >nul 2>nul',
          '  if errorlevel 1 (',
          '    echo.',
          '    echo   Node.js was not found. Install it from https://nodejs.org and run this again.',
          '    pause',
          '    exit /b 1',
          '  )',
          ')',
          `"%NODE%" server\\index.js --join "${link}" %*`,
          'echo.',
          'echo   This PC left the session. Press any key to close this window.',
          'pause >nul',
          '',
        ].join('\n'),
      );
    }
    text(
      'READ ME FIRST.txt',
      termux
        ? `Explorer Share — join kit for Android (Termux)\n\nRun:  sh "Explorer Share/join.sh"\n\nWhile it runs, everyone in the session on ${safeHost} can see this phone's internal storage (and SD card),\nsearch it, download from it and upload into it. Press Ctrl+C in Termux to leave.\n`
        : `Explorer Share — join kit\n\nDouble-click "Join session.bat".\n\nWhile its window is open, everyone in the session on ${safeHost} can see every drive on this PC,\nsearch it, download from it and upload into it. Close the window to leave the session.\n\nIf other devices can't reach this PC's files, allow Node.js on Private networks when Windows Firewall asks.\n`,
    );

    const plan = planZip(entries);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': String(plan.total),
      'Content-Disposition': contentDisposition(termux ? 'explorer-share.zip' : `Explorer Share - join ${safeHost || 'session'}.zip`),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    try {
      await writeZip(res, plan, async (_rec, i) => (entries[i].buf ? [entries[i].buf] : fs.createReadStream(entries[i].abs, { highWaterMark: 1 << 20 })));
      res.end();
    } catch {
      res.destroy();
    }
  }

  // ───────────── everything else ─────────────

  async function search(req, res, url) {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
    const kind = url.searchParams.get('kind') || 'any';
    const only = url.searchParams.get('dev');
    const limit = Math.min(safeInt(url.searchParams.get('limit')) || 60, 300);
    if (!q) return json(res, 200, { q, results: [] });
    const devs = [...hub.devices.values()].filter((d) => !only || only === 'all' || d.id === only);
    const t0 = performance.now();
    const results = await Promise.all(
      devs.map(async (d) => {
        try {
          const r = await withTimeout(d.search(q, { limit, kind }), 9000, `${d.name} didn't answer in time.`);
          return { dev: d.id, items: r.items || [], ms: r.ms, index: r.index };
        } catch (e) {
          return { dev: d.id, items: [], error: e.message };
        }
      }),
    );
    json(res, 200, { q, results, ms: Math.round(performance.now() - t0) });
  }

  async function qr(req, res, url) {
    const text = url.searchParams.get('u') || '';
    if (!/^https?:\/\/[^\s]{1,300}$/.test(text)) return notFound(res);
    let svg = qrCache.get(text);
    if (!svg) {
      svg = await QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#141413ff', light: '#00000000' } });
      if (qrCache.size > 32) qrCache.clear();
      qrCache.set(text, svg);
    }
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(svg);
  }

  /** GET /pull/<token> — an agent collects bytes a browser is sending to it. */
  function pull(req, res, token) {
    const p = hub.pulls.get(token);
    if (!p) return notFound(res);
    hub.pulls.delete(token);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', ...(p.size != null ? { 'Content-Length': String(p.size) } : {}) });
    const count = new Transform({
      transform(chunk, _enc, cb) {
        p.onBytes?.(chunk.length);
        cb(null, chunk);
      },
    });
    pipeline(p.src, count, res, () => {});
  }

  function requireApiHeader(req) {
    if (req.headers['x-es'] !== '1') throw new HttpError(403, 'Missing header.');
  }

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://explorer-share.local');
    } catch {
      return notFound(res);
    }
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Open Explorer Share with the address shown on the host PC.');
    }
    const p = url.pathname;
    try {
      // Agents move bytes with unguessable one-time tokens.
      if (p.startsWith('/relay/') && req.method === 'POST') {
        if (!hub.acceptRelay(p.slice(7), req, res)) {
          req.resume();
          return notFound(res);
        }
        return;
      }
      if (p.startsWith('/pull/') && req.method === 'GET') return pull(req, res, p.slice(6));

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (p === '/' && url.searchParams.has('key')) {
          if (!keyMatches(url.searchParams.get('key'))) {
            res.writeHead(302, { Location: '/?invalid=1' });
            return res.end();
          }
          res.writeHead(302, {
            Location: '/',
            'Set-Cookie': `es_key=${encodeURIComponent(key)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
          });
          return res.end();
        }
        if (STATIC[p]) return await serveFile(req, res, STATIC[p], { csp: p === '/' || p === '/index.html' });
        if (p.startsWith('/fonts/') && FONTS[p.slice(7)]) {
          return await serveFile(req, res, FONTS[p.slice(7)], { cache: 'public, max-age=31536000, immutable' });
        }
      }

      if (!p.startsWith('/api/') && p !== '/qr.svg') return notFound(res);
      // The join kit may carry the key in its URL so a phone can fetch it with curl.
      if (!authorized(req, p === '/api/join-kit' ? url : null)) throw new HttpError(401, 'This session needs its invite link. Open the link or scan the QR code shown on the host PC.');

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (p === '/api/whoami') return json(res, 200, { ok: true });
        if (p === '/api/join-kit') return await joinKit(req, res, url);
        if (p === '/api/ls') return json(res, 200, await hub.device(url.searchParams.get('dev')).list(url.searchParams.get('path') || ''));
        if (p === '/api/search') return await search(req, res, url);
        if (p === '/api/file') return await sendFile(req, res, url);
        if (p.startsWith('/api/zip/')) return await sendZip(req, res, p.slice(9).split('/')[0], url);
        if (p === '/qr.svg') return await qr(req, res, url);
      } else if (req.method === 'PUT' && p === '/api/upload') {
        return await putUpload(req, res, url);
      } else if (req.method === 'POST') {
        requireApiHeader(req);
        if (p === '/api/zip') return await prepareZip(req, res);
        if (p === '/api/upload/begin') return await beginUpload(req, res);
        if (p === '/api/upload/end') return await endUpload(req, res);
        if (p === '/api/mkdir') {
          const body = await readJson(req);
          const dev = hub.device(body.dev);
          const result = await dev.mkdir(String(body.dir || ''), String(body.name || ''));
          hub.folderChanged(dev.id, String(body.dir || ''));
          return json(res, 200, result);
        }
        if (p === '/api/cancel') {
          const body = await readJson(req);
          return json(res, 200, { ok: hub.cancelTransfer(String(body.id || '')) });
        }
      }
      notFound(res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) log.warn('Request failed:', p, e.message);
      if (!res.headersSent && !res.destroyed) json(res, status, { error: e instanceof HttpError ? e.message : 'Something went wrong on the host.' });
      else res.destroy();
    }
  }

  return { handle, authorized };
}
