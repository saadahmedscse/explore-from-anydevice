/**
 * The hub: who is connected, what is moving, and the pipes between them.
 *
 *  • devices   — the host's LocalDevice plus every agent that joined (RemoteDevice)
 *  • clients   — browser tabs watching the session (any device, no install needed)
 *  • transfers — every download and send passing through, with live speed
 *  • relays / pulls — short-lived HTTP pipes that carry file bytes to and from agents
 */
import { RemoteDevice } from './device.js';
import { routeOf, normIp } from './net.js';
import { HttpError, cleanLabel, rid } from './util.js';
import { log, color } from './log.js';

const KEEP_FINISHED = 80;
const FINISHED_TTL = 6 * 60 * 60_000;

export class Hub {
  constructor({ accessInfo }) {
    this.accessInfo = accessInfo; // () => { links, ... } shown in the invite panel
    this.devices = new Map();
    this.clients = new Map();
    this.transfers = new Map();
    this.relays = new Map();
    this.pulls = new Map();
    this.batches = new Map();
    this.stateQueued = false;
    this.ticker = setInterval(() => this.tick(), 500);
    this.ticker.unref?.();
  }

  // ───────────── devices ─────────────

  addDevice(dev) {
    this.devices.set(dev.id, dev);
    this.devicesChanged();
  }

  device(id) {
    const d = this.devices.get(id);
    if (!d) throw new HttpError(404, 'That device has left the session.');
    return d;
  }

  /** An agent connected on /agent. It must say hello within a few seconds. */
  attachAgent(ws, rawIp) {
    const ip = normIp(rawIp);
    let dev = null;
    const helloTimer = setTimeout(() => ws.close(4000, 'hello expected'), 8000);
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (!dev) {
        if (msg.t !== 'hello' || typeof msg.id !== 'string' || !/^[\w-]{8,64}$/.test(msg.id)) return ws.close(4001, 'bad hello');
        clearTimeout(helloTimer);
        const existing = this.devices.get(msg.id);
        if (existing?.role === 'host') return ws.close(4002, 'id clash');
        if (existing) {
          existing.close();
          try {
            existing.ws.close(4003, 'replaced');
          } catch {}
        }
        dev = new RemoteDevice({
          hub: this,
          ws,
          ip,
          route: routeOf(ip),
          hello: { ...msg, name: cleanLabel(msg.name) || 'Device', os: cleanLabel(msg.os, 24), kind: ['desktop', 'laptop', 'phone', 'tablet'].includes(msg.kind) ? msg.kind : 'desktop' },
        });
        this.addDevice(dev);
        ws.send(JSON.stringify({ t: 'welcome', hub: this.hostName() }));
        log.info(`${color.green('+')} ${dev.name} joined ${color.dim(`(${dev.os}, ${dev.route === 'tailscale' ? 'Tailscale' : 'LAN'} ${ip})`)}`);
        return;
      }
      dev.onMessage(msg);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (dev && this.devices.get(dev.id) === dev) {
        this.devices.delete(dev.id);
        dev.close();
        this.devicesChanged();
        log.info(`${color.dim('-')} ${dev.name} left`);
      }
    });
    ws.on('error', () => {});
  }

  hostName() {
    for (const d of this.devices.values()) if (d.role === 'host') return d.name;
    return 'Host';
  }

  devicesChanged() {
    if (this.stateQueued) return;
    this.stateQueued = true;
    setTimeout(() => {
      this.stateQueued = false;
      this.broadcastState();
    }, 50);
  }

  folderChanged(devId, dir) {
    this.broadcast({ t: 'changed', dev: devId, dir });
  }

  // ───────────── browser clients ─────────────

  attachClient(ws, rawIp) {
    const ip = normIp(rawIp);
    const client = { id: null, name: 'Browser', ip, route: routeOf(ip), ws, ua: '' };
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.t === 'hello') {
        client.id = typeof msg.clientId === 'string' && /^[\w-]{8,64}$/.test(msg.clientId) ? msg.clientId : rid(12);
        client.name = cleanLabel(msg.name) || 'Browser';
        this.clients.set(ws, client);
        this.sendState(client);
        this.devicesChanged();
      } else if (msg.t === 'rename' && client.id) {
        client.name = cleanLabel(msg.name) || client.name;
        this.devicesChanged();
      }
    });
    ws.on('close', () => {
      if (this.clients.delete(ws)) this.devicesChanged();
    });
    ws.on('error', () => {});
  }

  /** The device a browser is running on, matched by address. */
  deviceFor(client) {
    for (const d of this.devices.values()) {
      if (d.role === 'host' ? client.route === 'local' : d.ip === client.ip) return d.id;
    }
    return null;
  }

  sendState(client) {
    if (client.ws.readyState !== 1) return;
    client.ws.send(
      JSON.stringify({
        t: 'state',
        you: { clientId: client.id, name: client.name, deviceId: this.deviceFor(client), route: client.route },
        devices: [...this.devices.values()].map((d) => d.summary()),
        viewers: [...this.clients.values()].map((c) => ({ id: c.id, name: c.name, route: c.route })),
        transfers: this.transferList(),
        access: this.accessInfo(),
      }),
    );
  }

  broadcastState() {
    for (const c of this.clients.values()) this.sendState(c);
  }

  broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const c of this.clients.values()) if (c.ws.readyState === 1) c.ws.send(text);
  }

  clientById(id) {
    for (const c of this.clients.values()) if (c.id === id) return c;
    return null;
  }

  heartbeat() {
    for (const set of [this.clients.keys(), [...this.devices.values()].filter((d) => d.ws).map((d) => d.ws)]) {
      for (const ws of set) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {}
      }
    }
  }

  // ───────────── transfers ─────────────

  /**
   * @param {{dir: 'down'|'up', kind: string, name: string, devId: string, path: string,
   *          clientId?: string, ip?: string, total: number, files?: number}} info
   */
  startTransfer(info) {
    const dev = this.devices.get(info.devId);
    const client = info.clientId ? this.clientById(info.clientId) : null;
    const t = {
      id: rid(9),
      dir: info.dir,
      kind: info.kind,
      name: info.name,
      devId: info.devId,
      devName: dev?.name || 'Device',
      path: info.path,
      clientId: client?.id || info.clientId || null,
      clientName: client?.name || 'A browser',
      route: dev && dev.role === 'peer' ? dev.route : routeOf(info.ip || ''),
      viaRoute: routeOf(info.ip || ''),
      total: info.total ?? null,
      bytes: 0,
      files: info.files ?? null,
      filesDone: 0,
      state: 'active',
      startedAt: Date.now(),
      endedAt: null,
      speed: 0,
      error: null,
      abort: null,
      lastBytes: 0,
      lastAt: Date.now(),
    };
    this.transfers.set(t.id, t);
    this.transfersDirty = true;
    return t;
  }

  endTransfer(t, state, error = null) {
    if (!t || t.state !== 'active') return;
    t.state = state;
    t.error = error;
    t.endedAt = Date.now();
    t.speed = 0;
    t.abort = null;
    this.transfersDirty = true;
    this.prune();
  }

  cancelTransfer(id) {
    const t = this.transfers.get(id);
    if (!t || t.state !== 'active') return false;
    t.cancelRequested = true;
    try {
      t.abort?.();
    } catch {}
    this.endTransfer(t, 'canceled');
    return true;
  }

  prune() {
    const done = [...this.transfers.values()].filter((t) => t.state !== 'active');
    const now = Date.now();
    done.sort((a, b) => b.endedAt - a.endedAt);
    done.forEach((t, i) => {
      if (i >= KEEP_FINISHED || now - t.endedAt > FINISHED_TTL) this.transfers.delete(t.id);
    });
  }

  transferList() {
    return [...this.transfers.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(({ abort, lastBytes, lastAt, cancelRequested, ...pub }) => pub);
  }

  tick() {
    const now = Date.now();
    let active = false;
    for (const t of this.transfers.values()) {
      if (t.state !== 'active') continue;
      active = true;
      const dt = (now - t.lastAt) / 1000;
      if (dt > 0) {
        const inst = (t.bytes - t.lastBytes) / dt;
        t.speed = t.speed ? t.speed * 0.6 + inst * 0.4 : inst;
      }
      t.lastBytes = t.bytes;
      t.lastAt = now;
    }
    for (const b of this.batches.values()) {
      if (now - b.touched > 15 * 60_000) this.finishBatch(b, 'failed', 'The sender stopped responding.');
    }
    if (active || this.transfersDirty) {
      this.transfersDirty = false;
      this.broadcast({ t: 'transfers', transfers: this.transferList() });
    }
  }

  // ───────────── upload batches ─────────────

  createBatch({ devId, dir, label, files, bytes, clientId, ip }) {
    const t = this.startTransfer({ dir: 'up', kind: 'batch', name: label, devId, path: dir, clientId, ip, total: bytes, files });
    const b = { id: rid(12), devId, dir, expected: files, done: 0, failed: 0, t, reqs: new Set(), touched: Date.now() };
    t.abort = () => {
      for (const r of b.reqs) r.destroy();
    };
    this.batches.set(b.id, b);
    return b;
  }

  finishBatch(b, state, error = null) {
    if (!this.batches.delete(b.id)) return;
    for (const r of b.reqs) r.destroy();
    this.endTransfer(b.t, state, error);
    this.folderChanged(b.devId, b.dir);
  }

  // ───────────── byte pipes to agents ─────────────

  /** Wait for an agent to POST /relay/<token> with the bytes it was asked for. */
  expectRelay(token, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.relays.delete(token);
        reject(new HttpError(504, 'The device did not start sending in time.'));
      }, timeout);
      this.relays.set(token, { resolve, reject, timer });
    });
  }

  cancelRelay(token) {
    const r = this.relays.get(token);
    if (!r) return;
    clearTimeout(r.timer);
    this.relays.delete(token);
  }

  acceptRelay(token, req, res) {
    const r = this.relays.get(token);
    if (!r) return false;
    clearTimeout(r.timer);
    this.relays.delete(token);
    r.resolve({ req, res });
    return true;
  }

  /** Bytes waiting for an agent to collect with GET /pull/<token>. */
  offerPull(token, pull) {
    this.pulls.set(token, pull);
  }
}
