/**
 * A device whose files can be explored. Both kinds expose the same async interface:
 *   roots · list · stat · walk · openRead · reserve · receive · mkdir · search
 *
 *  • LocalDevice  — the host's own files, straight from disk.
 *  • RemoteDevice — a PC or phone that joined with `--join`. Commands travel over its
 *    WebSocket; file bytes travel over plain HTTP through the hub (POST /relay for reads,
 *    GET /pull for writes), so it works the same on the LAN and over Tailscale.
 */
import os from 'node:os';
import { execFile } from 'node:child_process';
import { searchWithStats } from './nameindex.js';
import { HttpError, rid } from './util.js';

export function osLabel() {
  if (process.env.PREFIX?.includes('com.termux')) return 'Android';
  switch (process.platform) {
    case 'win32': {
      const build = Number(os.release().split('.')[2] || 0);
      return build >= 22000 ? 'Windows 11' : 'Windows 10';
    }
    case 'darwin':
      return 'macOS';
    case 'android':
      return 'Android';
    default:
      return 'Linux';
  }
}

/** 'desktop' | 'laptop' | 'phone' — only used to pick an icon. */
export function detectKind() {
  if (osLabel() === 'Android') return Promise.resolve('phone');
  if (process.platform !== 'win32') return Promise.resolve(process.platform === 'darwin' ? 'laptop' : 'desktop');
  // Windows reports the chassis type; 8–14, 18, 21, 30–32 are portable form factors.
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_SystemEnclosure).ChassisTypes -join ","'],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve('desktop');
        const types = String(stdout).split(',').map(Number);
        resolve(types.some((t) => [8, 9, 10, 11, 12, 14, 18, 21, 30, 31, 32].includes(t)) ? 'laptop' : 'desktop');
      },
    );
  });
}

/** The operations a device answers, implemented on top of LocalFs + NameIndex. */
export function localOps(lfs, index) {
  return {
    roots: () => lfs.roots(),
    list: (p) => lfs.list(p),
    stat: (p) => lfs.stat(p),
    walk: (p) => lfs.walk(p),
    openRead: (p, start, end) => lfs.openRead(p, start, end),
    reserve: (dir, tops) => lfs.reserve(dir, tops),
    receive: (dir, rel, size, mtime, src, onBytes) => lfs.receive(dir, rel, size, mtime, src, onBytes),
    mkdir: (dir, name) => lfs.mkdir(dir, name),
    search: (q, opts) => searchWithStats(lfs, index, q, opts),
    indexStatus: () => index.status(),
  };
}

export class LocalDevice {
  constructor({ id, name, ops, kind = 'desktop' }) {
    this.id = id;
    this.name = name;
    this.ops = ops;
    this.role = 'host';
    this.ip = '127.0.0.1';
    this.os = osLabel();
    this.kind = kind;
    this.joinedAt = Date.now();
    this.rootsCache = [];
  }

  async refresh() {
    this.rootsCache = await this.ops.roots();
  }

  summary() {
    return {
      id: this.id, name: this.name, os: this.os, kind: this.kind, role: this.role, ip: this.ip, route: 'local',
      roots: this.rootsCache, index: this.ops.indexStatus(), joinedAt: this.joinedAt,
    };
  }

  list(p) { return this.ops.list(p); }
  stat(p) { return this.ops.stat(p); }
  walk(p) { return this.ops.walk(p); }
  openRead(p, start, end) { return this.ops.openRead(p, start, end); }
  reserve(dir, tops) { return this.ops.reserve(dir, tops); }
  receive(dir, rel, size, mtime, src, onBytes) { return this.ops.receive(dir, rel, size, mtime, src, onBytes); }
  mkdir(dir, name) { return this.ops.mkdir(dir, name); }
  search(q, opts) { return this.ops.search(q, opts); }
}

export class RemoteDevice {
  constructor({ hub, ws, hello, ip, route }) {
    this.hub = hub;
    this.ws = ws;
    this.id = hello.id;
    this.name = hello.name;
    this.os = hello.os || 'Unknown';
    this.kind = hello.kind || 'desktop';
    this.role = 'peer';
    this.ip = ip;
    this.route = route;
    this.version = hello.version;
    this.rootsCache = Array.isArray(hello.roots) ? hello.roots : [];
    this.indexCache = hello.index || { state: 'idle', count: 0 };
    this.joinedAt = Date.now();
    this.calls = new Map();
    this.closed = false;
  }

  summary() {
    return {
      id: this.id, name: this.name, os: this.os, kind: this.kind, role: this.role, ip: this.ip, route: this.route,
      roots: this.rootsCache, index: this.indexCache, joinedAt: this.joinedAt,
    };
  }

  onMessage(msg) {
    if (msg.t === 'res') {
      const call = this.calls.get(msg.id);
      if (!call) return;
      this.calls.delete(msg.id);
      clearTimeout(call.timer);
      if (msg.ok) call.resolve(msg.data);
      else call.reject(new HttpError(msg.status || 502, msg.error || `${this.name} couldn't do that.`));
    } else if (msg.t === 'status') {
      if (Array.isArray(msg.roots)) this.rootsCache = msg.roots;
      if (msg.index) this.indexCache = msg.index;
      this.hub.devicesChanged();
    } else if (msg.t === 'changed' && typeof msg.dir === 'string') {
      this.hub.folderChanged(this.id, msg.dir);
    }
  }

  close() {
    this.closed = true;
    for (const call of this.calls.values()) {
      clearTimeout(call.timer);
      call.reject(new HttpError(503, `${this.name} disconnected.`));
    }
    this.calls.clear();
  }

  call(op, args = {}, timeout = 20_000) {
    if (this.closed || this.ws.readyState !== 1) return Promise.reject(new HttpError(503, `${this.name} is offline.`));
    const id = rid(9);
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => {
        this.calls.delete(id);
        reject(new HttpError(504, `${this.name} didn't answer in time.`));
      }, timeout) : null;
      this.calls.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ t: 'rpc', id, op, args }));
    });
  }

  list(p) { return this.call('list', { path: p }, 30_000); }
  stat(p) { return this.call('stat', { path: p }); }
  walk(p) { return this.call('walk', { path: p }, 180_000); }
  reserve(dir, tops) { return this.call('reserve', { dir, tops }); }
  mkdir(dir, name) { return this.call('mkdir', { dir, name }); }
  search(q, opts) { return this.call('search', { q, opts }, 10_000); }

  async openRead(p, start = 0, end = null) {
    const token = rid();
    const arrival = this.hub.expectRelay(token, 30_000);
    let meta;
    try {
      meta = await this.call('read', { path: p, start, end, token });
    } catch (e) {
      this.hub.cancelRelay(token);
      throw e;
    }
    const { req, res } = await arrival;
    const reply = () => {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(204);
        res.end();
      }
    };
    req.once('end', reply);
    req.once('close', () => {
      if (!req.complete) res.destroy();
    });
    return { stream: req, size: meta.size, mtime: meta.mtime };
  }

  async receive(dir, rel, size, mtime, src, onBytes) {
    const token = rid();
    this.hub.offerPull(token, { src, size, onBytes });
    try {
      return await this.call('write', { dir, rel, size, mtime, token }, 0);
    } finally {
      this.hub.pulls.delete(token);
    }
  }
}
