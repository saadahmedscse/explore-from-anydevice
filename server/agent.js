/**
 * Agent mode: this machine joins a hub (`--join <invite link>`) and lets every device in that
 * session explore, search, download from and send into its drives.
 *
 * The hub sends commands over one WebSocket. File bytes go over plain HTTP:
 *   read  → this agent POSTs the bytes to  <hub>/relay/<token>
 *   write → this agent GETs the bytes from <hub>/pull/<token> and saves them
 */
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';
import WebSocket from 'ws';
import { HttpError } from './util.js';
import { log, color } from './log.js';

const VERSION = '0.1.0';

export function parseInvite(link) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(link) ? link : `http://${link}`);
  } catch {
    throw new Error(`"${link}" is not an address. Use the invite link shown on the host, e.g. http://192.168.1.24:8080/?key=…`);
  }
  const key = url.searchParams.get('key') || '';
  url.search = '';
  url.hash = '';
  url.pathname = '/';
  return { base: url.toString().replace(/\/$/, ''), key };
}

export function runAgent({ invite, id, name, os, kind, ops, onStatus }) {
  const { base, key } = parseInvite(invite);
  const wsUrl = `${base.replace(/^http/i, 'ws')}/agent`;
  const lib = base.startsWith('https:') ? https : http;
  const headers = key ? { 'x-es-key': key } : {};
  let ws = null;
  let backoff = 1000;
  let statusTimer = null;
  let announced = false;

  async function status() {
    return { roots: await ops.roots().catch(() => []), index: ops.indexStatus() };
  }

  function send(msg) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  async function handle(msg) {
    const { id: callId, op, args = {} } = msg;
    const reply = (data) => send({ t: 'res', id: callId, ok: true, data });
    const fail = (e) => send({ t: 'res', id: callId, ok: false, status: e instanceof HttpError ? e.status : 500, error: e.message });
    try {
      switch (op) {
        case 'list':
          return reply(await ops.list(args.path));
        case 'stat':
          return reply(await ops.stat(args.path));
        case 'walk':
          return reply(await ops.walk(args.path));
        case 'search':
          return reply(await ops.search(String(args.q || ''), args.opts || {}));
        case 'reserve':
          return reply(await ops.reserve(args.dir, args.tops || []));
        case 'mkdir':
          return reply(await ops.mkdir(args.dir, args.name));
        case 'read': {
          const start = Number.isSafeInteger(args.start) ? args.start : 0;
          const end = Number.isSafeInteger(args.end) ? args.end : null;
          const { stream, size, mtime } = await ops.openRead(args.path, start, end);
          reply({ size, mtime });
          const req = lib.request(`${base}/relay/${encodeURIComponent(args.token)}`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/octet-stream' },
          });
          req.on('response', (res) => res.resume());
          pipeline(stream, req, () => stream.destroy());
          return;
        }
        case 'write': {
          const res = await new Promise((resolve, reject) => {
            const req = lib.get(`${base}/pull/${encodeURIComponent(args.token)}`, { headers }, resolve);
            req.on('error', reject);
          });
          if (res.statusCode !== 200) {
            res.resume();
            throw new HttpError(410, 'The sender is gone.');
          }
          const result = await ops.receive(args.dir, args.rel, args.size ?? null, args.mtime ?? null, res);
          reply(result);
          send({ t: 'changed', dir: args.dir });
          return;
        }
        default:
          throw new HttpError(400, `Unknown command “${op}”.`);
      }
    } catch (e) {
      fail(e);
    }
  }

  function connect() {
    ws = new WebSocket(wsUrl, { headers, perMessageDeflate: false, handshakeTimeout: 10_000 });
    ws.on('open', async () => {
      backoff = 1000;
      send({ t: 'hello', id, name, os, kind, version: VERSION, ...(await status()) });
      statusTimer = setInterval(async () => send({ t: 'status', ...(await status()) }), 15_000);
    });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        log.info(`${color.green('●')} Connected to ${color.bold(msg.hub)} at ${base}${announced ? '' : ' — your drives are now visible to the session.'}`);
        announced = true;
        onStatus?.('connected');
      } else if (msg.t === 'rpc') {
        handle(msg);
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401) log.warn('The hub refused the key. Copy the full invite link (with ?key=…) from the host.');
      else log.warn(`The hub answered ${res.statusCode}.`);
    });
    ws.on('close', (code) => {
      clearInterval(statusTimer);
      onStatus?.('disconnected');
      if (code === 4003) log.warn('Another copy of this device connected; this one stepped aside.');
      const wait = backoff;
      backoff = Math.min(backoff * 2, 15_000);
      setTimeout(connect, wait);
    });
    ws.on('error', (e) => {
      if (backoff <= 2000) log.warn(`Can't reach ${base} (${e.code || e.message}). Retrying…`);
    });
  }

  connect();
  return {
    stop() {
      clearInterval(statusTimer);
      ws?.removeAllListeners('close');
      ws?.close();
    },
  };
}
