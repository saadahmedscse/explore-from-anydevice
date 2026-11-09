import os from 'node:os';
import dgram from 'node:dgram';
import { execFile } from 'node:child_process';

// Adapters that are rarely reachable from a phone or laptop on the same Wi-Fi.
const VIRTUAL = /(vEthernet|VirtualBox|VMware|Hyper-V|WSL|Docker|vboxnet|vmnet|^br-|^veth|utun|Tailscale|ZeroTier|Loopback|Bluetooth|isatap|Teredo)/i;

export function normIp(addr) {
  if (!addr) return '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

/** Tailscale hands out addresses from the CGNAT range 100.64.0.0/10. */
export function isTailscaleIp(addr) {
  const m = /^100\.(\d{1,3})\./.exec(normIp(addr));
  return Boolean(m) && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

export function isLoopback(addr) {
  const ip = normIp(addr);
  return ip === '::1' || ip.startsWith('127.');
}

/** True when the address belongs to this machine (loopback or any of its own interfaces). */
export function isLocalAddress(addr) {
  const ip = normIp(addr);
  if (isLoopback(ip)) return true;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (normIp(a.address) === ip) return true;
  }
  return false;
}

/** How a peer reaches us: 'local' (same machine), 'tailscale' or 'lan'. */
export function routeOf(addr) {
  if (isLocalAddress(addr)) return 'local';
  if (isTailscaleIp(addr)) return 'tailscale';
  return 'lan';
}

let routeAddress = null;

/** The local address the OS would use for outbound traffic — almost always the Wi-Fi/LAN one. */
export function refreshRouteAddress() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const done = (value) => {
      try {
        sock.close();
      } catch {}
      if (value) routeAddress = value;
      resolve(routeAddress);
    };
    sock.on('error', () => done(null));
    try {
      // connect() on UDP sends nothing; it only asks the OS to pick a route.
      sock.connect(53, '8.8.8.8', () => {
        try {
          done(sock.address().address);
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });
}

function score(a) {
  let s = 0;
  if (a.address === routeAddress) s += 100;
  if (!VIRTUAL.test(a.name)) s += 20;
  if (a.address.startsWith('192.168.')) s += 10;
  else if (a.address.startsWith('10.')) s += 8;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) s += 6;
  if (a.address.startsWith('169.254.')) s -= 60;
  return s;
}

/** LAN addresses of this machine, best first (Tailscale excluded — see tailscaleAddress). */
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !isTailscaleIp(a.address)) {
        out.push({ name, address: a.address });
      }
    }
  }
  return out.sort((a, b) => score(b) - score(a)).map((a) => ({ ...a, virtual: VIRTUAL.test(a.name) }));
}

export function tailscaleAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && isTailscaleIp(a.address)) return a.address;
    }
  }
  return null;
}

/** The MagicDNS name of this machine, if the Tailscale CLI is around. Resolves null otherwise. */
export function tailscaleDnsName() {
  const candidates =
    process.platform === 'win32'
      ? ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']
      : process.platform === 'darwin'
        ? ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
        : ['tailscale'];
  const tryOne = (i) =>
    new Promise((resolve) => {
      if (i >= candidates.length) return resolve(null);
      execFile(candidates[i], ['status', '--json', '--self=true', '--peers=false'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(tryOne(i + 1));
        try {
          const name = JSON.parse(stdout)?.Self?.DNSName;
          resolve(typeof name === 'string' && name ? name.replace(/\.$/, '') : null);
        } catch {
          resolve(null);
        }
      });
    });
  return tryOne(0);
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * DNS-rebinding guard: only answer to IP literals, localhost, LAN-style names
 * (single-label hostnames, .local, .lan, .home, .internal) and Tailscale MagicDNS names.
 */
export function isAllowedHost(hostHeader) {
  if (!hostHeader) return true;
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) return true; // IPv6 literal
  host = host.replace(/:\d+$/, '');
  if (IPV4.test(host) || host === 'localhost') return true;
  if (!host.includes('.')) return true;
  return /\.(local|lan|home|internal|home\.arpa|localdomain|ts\.net|beta\.tailscale\.net)$/.test(host);
}
