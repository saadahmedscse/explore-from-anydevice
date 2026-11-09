#!/usr/bin/env node
/**
 * Explorer Share — every device's files in one explorer, over your LAN or Tailscale.
 *
 * Host (the PC everyone connects to):
 *   node server/index.js [--port 8080] [--name "Desktop-PC"] [--no-open] [--open-access] [--new-key]
 *
 * Join from another PC or an Android phone (Termux):
 *   node server/index.js --join "http://192.168.1.24:8080/?key=…" [--name "ThinkPad"]
 *
 * There is nothing to pick: a device that is in the session shows its whole file system —
 * every drive on Windows, internal storage + SD card on Android, home + volumes on macOS/Linux.
 * Everyone in the session can browse it, search it, download from it and upload into it.
 * (--only <folder> limits a device to specific folders, if you ever want that.)
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { LocalFs } from './localfs.js';
import { NameIndex } from './nameindex.js';
import { LocalDevice, localOps, osLabel, detectKind } from './device.js';
import { Hub } from './hub.js';
import { createHandler } from './routes.js';
import { runAgent } from './agent.js';
import { lanAddresses, refreshRouteAddress, tailscaleAddress, tailscaleDnsName, isAllowedHost } from './net.js';
import { rid, cleanLabel } from './util.js';
import { log, color } from './log.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = process.env.ES_CONFIG || path.join(os.homedir(), '.explorer-share.json');

function parseArgs(argv) {
  const opts = { port: Number(process.env.PORT) || 8080, name: '', open: true, share: [], join: '', openAccess: false, newKey: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (flag) => (a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : argv[++i] || '');
    if (a === '--port' || a.startsWith('--port=') || a === '-p') opts.port = Number(val('--port'));
    else if (a === '--name' || a.startsWith('--name=')) opts.name = val('--name');
    else if (a === '--only' || a.startsWith('--only=')) opts.share.push(val('--only'));
    else if (a === '--share' || a.startsWith('--share=')) opts.share.push(val('--share'));
    else if (a === '--join' || a.startsWith('--join=')) opts.join = val('--join');
    else if (a === '--no-open') opts.open = false;
    else if (a === '--open-access') opts.openAccess = true;
    else if (a === '--new-key') opts.newKey = true;
    else if (a === '--help' || a === '-h') {
      console.log(`
  Explorer Share

  Host:  node server/index.js [--port 8080] [--name "Desktop-PC"] [--no-open] [--open-access] [--new-key]
  Join:  node server/index.js --join "<invite link>" [--name "ThinkPad"]

  Every device in the session shows its whole file system to everyone in the session
  (all drives on Windows, internal storage + SD card on Android) — browse, search,
  download and upload.

  --only <folder>    show only this folder instead of the whole device (repeatable)
  --open-access      no key: anyone who can reach the address gets in (trusted networks only)
  --new-key          make a new invite key; old links and joined devices must use the new one
`);
      process.exit(0);
    } else if (!a.startsWith('--')) opts.share.push(a);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) opts.port = 8080;
  opts.share = opts.share.filter(Boolean);
  return opts;
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  } catch (e) {
    log.warn(`Couldn't save ${CONFIG}: ${e.message}`);
  }
}

function defaultName() {
  const host = os.hostname();
  if (osLabel() === 'Android' || !host || host === 'localhost') return 'Android device';
  return host;
}

const opts = parseArgs(process.argv.slice(2));
const config = loadConfig();
if (!config.id) config.id = rid(12);
if (!opts.join && (!config.key || opts.newKey)) config.key = rid(12);
saveConfig(config);

const name = cleanLabel(opts.name) || defaultName();

let lfs;
try {
  lfs = await new LocalFs({ shares: opts.share }).init();
} catch (e) {
  console.error(`\n  ${e.message}\n`);
  process.exit(1);
}
if (!lfs.rootList.length) log.warn('No drives could be read on this device.');
const index = new NameIndex(lfs);
index.start();
const ops = localOps(lfs, index);
const kind = await detectKind();
const sharedList = lfs.rootList.map((r) => (r.label ? `${r.id} ${color.dim(r.label)}` : r.id)).join(', ');

if (opts.join) startAgent();
else startHost();

// ───────────── agent ─────────────

function startAgent() {
  console.log();
  console.log(`  ${color.orange('■')} ${color.bold('Explorer Share')} ${color.dim('— joining a session')}`);
  console.log();
  console.log(`  This device:  ${color.bold(name)} ${color.dim(`(${osLabel()})`)}`);
  console.log(`  Visible:      ${sharedList || color.dim('nothing readable')}`);
  console.log(color.dim('  Everyone in the session can browse, search, download from and upload to these.'));
  console.log(color.dim('  Building a search index in the background. Close this window or press Ctrl+C to leave.'));
  console.log();
  const agent = runAgent({ invite: opts.join, id: config.id, name, os: osLabel(), kind, ops });
  const stop = () => {
    agent.stop();
    index.stop();
    log.info('Left the session.');
    setTimeout(() => process.exit(0), 100);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
}

// ───────────── host ─────────────

function startHost() {
  let port = opts.port;
  const key = opts.openAccess ? null : config.key;
  let tsName = null;

  function accessInfo() {
    const lan = lanAddresses();
    const real = lan.filter((a) => !a.virtual);
    const urls = (real.length ? real : lan).map((a) => `http://${a.address}:${port}`);
    const tsIp = tailscaleAddress();
    const q = key ? `/?key=${key}` : '/';
    return {
      key,
      lan: urls[0] ? `${urls[0]}${q}` : null,
      lanExtra: urls.slice(1).map((u) => `${u}${q}`),
      tailscale: tsName ? `http://${tsName}:${port}${q}` : tsIp ? `http://${tsIp}:${port}${q}` : null,
      tailscaleIp: tsIp ? `http://${tsIp}:${port}${q}` : null,
      local: `http://localhost:${port}`,
    };
  }

  const hub = new Hub({ accessInfo });
  const host = new LocalDevice({ id: config.id, name, ops, kind });
  hub.addDevice(host);

  let lastIndex = '';
  const refresh = async () => {
    await host.refresh().catch(() => {});
    const s = JSON.stringify(index.status());
    if (s !== lastIndex) lastIndex = s;
    hub.devicesChanged();
  };
  refresh();
  setInterval(refresh, 15_000);
  // Index progress shows on the Search page; nudge clients while it is building.
  const indexWatch = setInterval(() => {
    const s = JSON.stringify(index.status());
    if (s !== lastIndex) {
      lastIndex = s;
      hub.devicesChanged();
    }
  }, 3000);
  indexWatch.unref();

  const { handle, authorized } = createHandler({ hub, root: ROOT, key });
  const server = http.createServer({ requestTimeout: 0, headersTimeout: 60_000, keepAliveTimeout: 10_000 }, handle);
  server.timeout = 0;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
  const refuse = (socket, code, text) => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://explorer-share.local');
    } catch {
      return socket.destroy();
    }
    if (!isAllowedHost(req.headers.host)) return refuse(socket, 403, 'Forbidden');
    if (url.pathname === '/ws') {
      // Browser tabs: the page must come from this server.
      const origin = req.headers.origin;
      let sameOrigin = true;
      if (origin) {
        try {
          sameOrigin = new URL(origin).host === req.headers.host;
        } catch {
          sameOrigin = false;
        }
      }
      if (!sameOrigin) return refuse(socket, 403, 'Forbidden');
      if (!authorized(req, null)) return refuse(socket, 401, 'Unauthorized');
      return wss.handleUpgrade(req, socket, head, (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => (ws.isAlive = true));
        hub.attachClient(ws, req.socket.remoteAddress);
      });
    }
    if (url.pathname === '/agent') {
      if (!authorized(req, url)) return refuse(socket, 401, 'Unauthorized');
      return wss.handleUpgrade(req, socket, head, (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => (ws.isAlive = true));
        hub.attachAgent(ws, req.socket.remoteAddress);
      });
    }
    socket.destroy();
  });

  const heartbeat = setInterval(() => hub.heartbeat(), 20_000);

  function listen(tries = 0) {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && tries < 20) {
        port += 1;
        listen(tries + 1);
      } else {
        console.error(`Could not start Explorer Share: ${err.message}`);
        process.exit(1);
      }
    });
    server.listen(port, '0.0.0.0', onListening);
  }

  async function onListening() {
    await refreshRouteAddress();
    tsName = await tailscaleDnsName();
    const info = accessInfo();

    console.log();
    console.log(`  ${color.orange('■')} ${color.bold('Explorer Share')} ${color.dim('— every device, one explorer')}`);
    console.log();
    console.log(`  Host:     ${color.bold(name)} ${color.dim(`(${osLabel()})`)}`);
    console.log(`  Visible:  ${sharedList || color.dim('nothing readable')}`);
    console.log();
    if (info.lan) {
      console.log(`  Invite link — open it on any device on this network:`);
      console.log(`    ${color.orange('→')} ${color.bold(info.lan)}`);
      for (const extra of info.lanExtra) console.log(`      ${color.dim(extra)}`);
    } else {
      console.log(`  ${color.orange('!')} No network connection found — only this PC can open Explorer Share right now.`);
    }
    if (info.tailscale) {
      console.log();
      console.log(`  From anywhere on your tailnet:`);
      console.log(`    ${color.orange('→')} ${color.bold(info.tailscale)}`);
    }
    if (info.lan && process.stdout.isTTY) {
      try {
        const qr = await QRCode.toString(info.lan, { type: 'terminal', small: true, margin: 1 });
        console.log('\n' + qr.replace(/^/gm, '    '));
      } catch {}
    } else {
      console.log();
    }
    console.log(`  On this PC: ${color.bold(info.local)}`);
    console.log();
    console.log(`  To bring another PC's or phone's files into the session, open the invite link on it`);
    console.log(`  and use ${color.bold('Add this device')} on the Devices page (Windows: one download, no install).`);
    if (key) console.log(color.dim('  Keep the invite link private: anyone with it can see, download and upload files on every device here.'));
    else console.log(color.orange('  Open access is on: anyone who can reach this address can browse and add files.'));
    if (process.platform === 'win32') {
      console.log(color.dim('  If other devices can’t connect, allow Node.js on Private networks in Windows Firewall.'));
    }
    console.log(color.dim('  Close this window or press Ctrl+C to stop.'));
    console.log();
    if (opts.open) openBrowser(info.local);
  }

  function openBrowser(url) {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try {
      spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch {}
  }

  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    console.log();
    log.info('Stopping Explorer Share.');
    clearInterval(heartbeat);
    index.stop();
    for (const ws of wss.clients) ws.close(1001, 'host stopping');
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);

  listen();
}
