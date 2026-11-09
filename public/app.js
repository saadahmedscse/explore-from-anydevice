/* Explorer Share — web app. No build step; plain modules served by the hub. */
import { icon, KIND_ICON, DEVICE_ICON } from '/icons.js';
import { kindOf, kindLabel, previewType } from '/kinds.js';

// ───────────────────────── helpers ─────────────────────────

const $ = (s, root = document) => root.querySelector(s);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ico = (name, size = 16, stroke = 1.75) => h('span', { class: 'ico', html: icon(name, size, stroke) });

function tile(kind, extra = '') {
  return h('span', { class: `tile ${kind === 'folder' ? 'folder' : ''} ${extra}` }, ico(KIND_ICON[kind] || 'file', 16));
}

const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < u.length - 1);
  return `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= today) return `Today, ${time}`;
  if (ms >= today - 86_400_000) return `Yesterday, ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return fmtDate(ms);
}

function fmtEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s left`;
  if (sec < 3600) return `${Math.round(sec / 60)} min left`;
  return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min left`;
}

const routeLabel = (r) => (r === 'tailscale' ? 'Tailscale' : r === 'local' ? 'This PC' : 'LAN');

/** "C:/Work/Finance" → "C:\Work\Finance"; other roots keep slashes. */
function displayPath(vpath) {
  const segs = String(vpath || '').split('/').filter(Boolean);
  if (!segs.length) return '';
  return /^[A-Z]:$/i.test(segs[0]) ? `${segs[0]}\\${segs.slice(1).join('\\')}` : segs.join('/');
}

const parentOf = (vpath) => {
  const i = vpath.lastIndexOf('/');
  return i === -1 ? '' : vpath.slice(0, i);
};
const baseOf = (vpath) => vpath.slice(vpath.lastIndexOf('/') + 1);
const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied', 'ok');
}

function guessName() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) {
    const m = /Android [\d.]+;\s*([^;)]+?)(?:\s+Build\/|\))/.exec(ua);
    const model = m?.[1]?.trim();
    return model && model !== 'K' && model.length > 1 ? model : 'Android phone';
  }
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad|Macintosh.*Mobile/.test(ua)) return 'iPad';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Mac OS X/.test(ua)) return 'Mac';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'Browser';
}

const isPhone = () => matchMedia('(max-width: 820px)').matches;

// ───────────────────────── state ─────────────────────────

const clientId = LS.get('es.clientId', null) || (() => {
  const id = randomId();
  LS.set('es.clientId', id);
  return id;
})();
const myName = () => LS.get('es.name', '') || guessName();

const S = {
  you: null,
  devices: [],
  viewers: [],
  transfers: [],
  access: null,
  online: false,
  everConnected: false,
  locked: false,
  ex: { dev: null, path: '', data: null, loading: false, error: null, sel: new Set(), focus: null, filter: '', limit: 400, reqId: 0, sort: LS.get('es.sort', { k: 'name', d: 1 }), anchor: null, detailsOpen: false },
  sr: { q: '', kind: 'any', dev: 'all', data: null, loading: false, error: null, reqId: 0 },
  uploads: new Map(), // server transfer id → { canceled, xhrs }
};
const listingCache = new Map();

const deviceById = (id) => S.devices.find((d) => d.id === id) || null;
const activeTransfers = () => S.transfers.filter((t) => t.state === 'active');

function deviceMeta(d) {
  const mine = S.you?.deviceId === d.id;
  if (d.role === 'host') return `Host · ${mine ? 'this device' : routeLabel(S.you?.route)}`;
  return `${routeLabel(d.route)}${mine ? ' · this device' : ''}`;
}

function storageOf(d) {
  let total = 0;
  let free = 0;
  for (const r of d.roots || []) {
    if (r.total != null) {
      total += r.total;
      free += r.free ?? 0;
    }
  }
  return { total, used: total - free, free };
}

// ───────────────────────── API ─────────────────────────

async function api(url, { method = 'GET', body } = {}) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json', 'x-es': '1' } : { 'x-es': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await r.json();
  } catch {}
  if (r.status === 401) {
    S.locked = true;
    render();
  }
  if (!r.ok) throw new Error(data?.error || `Request failed (${r.status}).`);
  return data;
}

function triggerDownload(url) {
  const a = h('a', { href: url, download: '', style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
}

function downloadFile(devId, path) {
  triggerDownload(`/api/file?${qs({ dev: devId, path, c: clientId })}`);
  toast(`Downloading ${baseOf(path)}…`);
}

async function downloadZip(devId, dir, names, name) {
  try {
    const r = await api('/api/zip', { method: 'POST', body: { dev: devId, dir, names, name } });
    triggerDownload(`${r.url}?${qs({ c: clientId })}`);
    toast(`Preparing ${names.length === 1 ? names[0] : `${names.length} items`} as a ZIP…`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ───────────────────────── live connection ─────────────────────────

let ws = null;
let backoff = 800;

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    backoff = 800;
    ws.send(JSON.stringify({ t: 'hello', clientId, name: myName() }));
  };
  ws.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    onMessage(m);
  };
  ws.onclose = async () => {
    const was = S.online;
    S.online = false;
    if (was) renderChrome();
    const r = await fetch('/api/whoami', { headers: { 'x-es': '1' } }).catch(() => null);
    if (r?.status === 401) {
      S.locked = true;
      return render();
    }
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 8000);
  };
}

function onMessage(m) {
  if (m.t === 'state') {
    const first = !S.everConnected;
    S.you = m.you;
    S.devices = m.devices;
    S.viewers = m.viewers;
    S.transfers = m.transfers;
    S.access = m.access;
    S.online = true;
    S.everConnected = true;
    S.locked = false;
    if (first) render();
    else {
      renderChrome();
      view?.onState?.();
    }
  } else if (m.t === 'transfers') {
    S.transfers = m.transfers;
    updateBadges();
    view?.onTransfers?.();
  } else if (m.t === 'changed') {
    listingCache.delete(`${m.dev}|${m.dir}`);
    view?.onChanged?.(m);
  }
}

// ───────────────────────── toasts & modals ─────────────────────────

function toast(text, kind = 'info', ms = 3800) {
  const el = h('div', { class: `toast ${kind}` }, ico(kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : 'transfers', 16), h('span', null, text));
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? ms + 3000 : ms);
}

function modal({ title, text, input, okLabel = 'OK', onOk }) {
  const field = input ? h('input', { type: 'text', value: input.value || '', placeholder: input.placeholder || '', 'aria-label': input.label || title }) : null;
  const close = () => back.remove();
  const ok = async () => {
    try {
      if ((await onOk?.(field ? field.value : undefined)) !== false) close();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  const back = h(
    'div',
    { class: 'modal-back', onclick: (e) => e.target === back && close() },
    h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', null, title),
      text ? h('p', null, text) : null,
      field ? h('label', { class: 'field' }, field) : null,
      h('div', { class: 'acts' }, h('button', { class: 'btn quiet', type: 'button', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', type: 'button', onclick: ok }, okLabel)),
    ),
  );
  back.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') ok();
  });
  document.body.append(back);
  (field || $('.btn.primary', back)).focus();
  field?.select();
}

function renameBrowser() {
  modal({
    title: 'Name this browser',
    text: 'Other devices see this name next to what you download and send.',
    input: { value: myName(), placeholder: 'e.g. Pixel 8', label: 'Name' },
    okLabel: 'Save',
    onOk: (v) => {
      const name = String(v || '').trim().slice(0, 40);
      LS.set('es.name', name);
      ws?.readyState === 1 && ws.send(JSON.stringify({ t: 'rename', name: name || guessName() }));
    },
  });
}

// ───────────────────────── routing ─────────────────────────

function parseRoute() {
  const raw = location.hash.slice(1) || '/';
  const qi = raw.indexOf('?');
  const segs = (qi === -1 ? raw : raw.slice(0, qi)).split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const params = new URLSearchParams(qi === -1 ? '' : raw.slice(qi + 1));
  if (segs[0] === 'browse') return { view: 'browse', dev: segs[1] || null, path: segs.slice(2).join('/'), focus: params.get('focus') };
  if (segs[0] === 'search') return { view: 'search', q: params.get('q') || '' };
  if (segs[0] === 'transfers') return { view: 'transfers' };
  return { view: 'devices' };
}

function browseHash(dev, path = '', focus = null) {
  const p = path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : '';
  return `#/browse/${encodeURIComponent(dev)}${p}${focus ? `?focus=${encodeURIComponent(focus)}` : ''}`;
}

let view = null;

function render() {
  if (S.locked) return renderLock();
  document.body.classList.remove('locked');
  renderChrome();
  if (!S.everConnected) {
    $('#main').replaceChildren(h('div', { class: 'page' }, h('div', { class: 'empty' }, h('b', null, 'Connecting to the host…'), h('span', null, 'One moment.'))));
    return;
  }
  const route = parseRoute();
  view?.destroy?.();
  view = route.view === 'browse' ? viewBrowse(route) : route.view === 'search' ? viewSearch(route) : route.view === 'transfers' ? viewTransfers() : viewDevices();
  if (!view) return;
  $('#main').replaceChildren(view.el);
  document.title = `${view.title} — Explorer Share`;
  view.mounted?.();
}

window.addEventListener('hashchange', render);

// ───────────────────────── chrome: sidebar, tab bar, banner ─────────────────────────

function navLink(href, label, name, current, extra) {
  return h('a', { href, 'aria-current': current ? 'page' : null }, h('span', { class: 'nav-ico' }, ico(name, 16)), label, extra || null);
}

function renderChrome() {
  const route = parseRoute();
  const active = activeTransfers().length;
  const badge = () => h('span', { class: 'badge', dataset: { badge: '1' }, hidden: !active }, String(active));

  const devItems = S.devices.map((d) => {
    const here = route.view === 'browse' && route.dev === d.id;
    const item = h(
      'a',
      { class: 'side-item side-dev', href: browseHash(d.id), 'aria-current': here ? 'true' : null },
      h('span', { class: 'dev-ico' }, ico(DEVICE_ICON[d.kind] || 'desktop', 15), h('span', { class: 'dot' })),
      h('span', { class: 'side-dev-text' }, h('span', { class: 'side-dev-name ellipsis' }, d.name), h('span', { class: 'side-dev-meta ellipsis' }, deviceMeta(d))),
      h('span', { class: 'muted', style: { display: 'flex' } }, ico(here ? 'chevronDown' : 'chevronRight', 14)),
    );
    if (!here) return item;
    const rootId = route.path.split('/')[0];
    return [
      item,
      h(
        'div',
        { class: 'side-roots' },
        (d.roots || []).map((r) =>
          h(
            'a',
            { class: 'side-item side-root', href: browseHash(d.id, r.id), 'aria-current': rootId === r.id ? 'true' : null },
            ico(r.kind === 'folder' ? 'folder' : 'drive', 14),
            h('span', { class: 'ellipsis' }, r.label ? `${r.id} ${r.label}` : r.id),
            r.free != null ? h('span', { class: 'mono' }, fmtBytes(r.free)) : null,
          ),
        ),
      ),
    ];
  });

  const me = deviceById(S.you?.deviceId);
  $('#sidebar').replaceChildren(
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark', html: icon('logo', 18, 2) }), h('span', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } }, h('span', { class: 'brand-name' }, 'Explorer Share'), h('span', { class: 'brand-sub ellipsis' }, S.devices.find((d) => d.role === 'host') ? `Hosted on ${S.devices.find((d) => d.role === 'host').name}` : 'Connecting…'))),
    h(
      'nav',
      { class: 'nav', 'aria-label': 'Main' },
      navLink('#/', 'Devices', 'devices', route.view === 'devices'),
      navLink(lastBrowseHash(), 'Explorer', 'folder', route.view === 'browse'),
      navLink('#/search', 'Search', 'search', route.view === 'search', h('span', { class: 'kbd' }, navigator.platform.startsWith('Mac') ? '⌘K' : 'Ctrl K')),
      navLink('#/transfers', 'Transfers', 'transfers', route.view === 'transfers', badge()),
    ),
    h(
      'div',
      { class: 'side-devices' },
      h('div', { class: 'side-label' }, h('span', null, 'In this session'), h('span', { class: 'mono' }, `${S.devices.length} online`)),
      devItems,
    ),
    h(
      'div',
      { class: 'you-card' },
      h('span', { class: `conn-dot ${S.online ? '' : 'off'}`, title: S.online ? 'Connected' : 'Reconnecting' }),
      h('div', { class: 't' }, h('b', { class: 'ellipsis' }, `You're on ${me ? me.name : myName()}`), me ? h('span', { class: 'ellipsis' }, me.role === 'host' ? 'Hosting · drives visible' : 'Your drives are visible') : h('a', { class: 'ellipsis', href: '#/', style: { fontSize: '12px', textDecoration: 'none' }, onclick: () => setTimeout(() => $('#add-device')?.scrollIntoView({ block: 'center' }), 60) }, `Browsing only · add this device`)),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Rename this browser', title: 'Rename this browser', onclick: renameBrowser }, ico('pencil', 15)),
    ),
  );

  const tab = (href, label, name, current, withBadge) =>
    h('a', { href, 'aria-current': current ? 'page' : null }, h('span', { class: 'pill' }, ico(name, 20)), label, withBadge ? badge() : null);
  $('#tabbar').replaceChildren(
    tab('#/', 'Devices', 'devices', route.view === 'devices'),
    tab(lastBrowseHash(), 'Browse', 'folder', route.view === 'browse'),
    tab('#/search', 'Search', 'search', route.view === 'search'),
    tab('#/transfers', 'Transfers', 'transfers', route.view === 'transfers', true),
  );

  let banner = $('#banner');
  if (S.everConnected && !S.online) {
    if (!banner) {
      banner = h('div', { class: 'banner', id: 'banner', role: 'status' }, ico('refresh', 15), 'Lost the connection to the host — reconnecting…');
      document.body.append(banner);
    }
  } else banner?.remove();
}

function updateBadges() {
  const n = activeTransfers().length;
  for (const b of document.querySelectorAll('[data-badge]')) {
    b.textContent = String(n);
    b.hidden = !n;
  }
}

function lastBrowseHash() {
  const last = LS.get('es.lastBrowse', null);
  if (last && deviceById(last.dev)) return browseHash(last.dev, last.path);
  const d = deviceById(S.you?.deviceId) || S.devices.find((x) => x.role === 'host') || S.devices[0];
  return d ? browseHash(d.id) : '#/browse';
}

// ───────────────────────── lock screen ─────────────────────────

function renderLock() {
  view?.destroy?.();
  view = null;
  document.body.classList.add('locked');
  $('#sidebar').replaceChildren();
  $('#tabbar').replaceChildren();
  const input = h('input', { type: 'text', placeholder: 'Paste the invite link or key', 'aria-label': 'Invite link or key' });
  const go = () => {
    const v = input.value.trim();
    if (!v) return input.focus();
    let key = v;
    try {
      const u = new URL(v);
      key = u.searchParams.get('key') || '';
    } catch {}
    location.href = `/?key=${encodeURIComponent(key)}`;
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  const invalid = new URLSearchParams(location.search).has('invalid');
  $('#main').replaceChildren(
    h(
      'div',
      { class: 'lock' },
      h(
        'div',
        { class: 'modal' },
        h('span', { class: 'tile lg clay' }, ico('lock', 20)),
        h('h2', null, 'This session is private'),
        h('p', null, invalid ? 'That key didn’t match. Copy the invite link again from the host PC — it may have changed.' : 'Open the invite link shown on the host PC, or scan its QR code. You can also paste the link here.'),
        h('label', { class: 'field' }, input),
        h('div', { class: 'acts' }, h('button', { class: 'btn primary', type: 'button', onclick: go }, 'Join session')),
      ),
    ),
  );
  input.focus();
}

// ───────────────────────── view: devices ─────────────────────────

function viewDevices() {
  const el = h('div', { class: 'page' });
  const feed = h('div');

  function deviceCard(d) {
    const mine = S.you?.deviceId === d.id;
    const st = storageOf(d);
    const pct = st.total ? Math.round((st.used / st.total) * 100) : 0;
    const shares = (d.roots || []).length;
    const ip = d.role === 'host' ? (S.access?.lan ? new URL(S.access.lan).hostname : 'this PC') : d.ip;
    return h(
      'article',
      { class: 'dev-card' },
      h(
        'div',
        { class: 'top' },
        h('span', { class: 'tile lg' }, ico(DEVICE_ICON[d.kind] || 'desktop', 20, 1.6)),
        h('div', { class: 'tags' }, d.role === 'host' ? h('span', { class: 'tag clay' }, 'Host') : null, mine ? h('span', { class: 'tag' }, 'You') : null, d.route === 'tailscale' ? h('span', { class: 'tag sky' }, 'Tailscale') : null),
      ),
      h('div', null, h('h3', { class: 'ellipsis' }, d.name), h('p', { class: 'os' }, `${d.os} · ${shares} ${(d.roots || []).every((r) => r.kind === 'folder') ? (shares === 1 ? 'folder' : 'folders') : shares === 1 ? 'drive' : 'drives'}`)),
      h('div', { class: 'conn' }, h('span', { class: 'conn-dot' }), h('span', { class: 'ellipsis' }, `${d.role === 'host' ? routeLabel(S.you?.route === 'local' ? 'lan' : S.you?.route) : routeLabel(d.route)} · ${ip}`)),
      st.total
        ? h('div', { class: 'cap' }, h('div', { class: 'l' }, h('span', { class: 'muted' }, 'Storage'), h('span', { class: 'dim' }, `${fmtBytes(st.used)} of ${fmtBytes(st.total)}`)), h('div', { class: 'bar' }, h('i', { style: { width: `${pct}%` } })))
        : null,
      h('a', { class: 'btn', href: browseHash(d.id) }, 'Browse files', ico('arrowRight', 15)),
    );
  }

  function addCard() {
    return h(
      'article',
      { class: 'dev-card add' },
      h('div', { class: 'top' }, h('span', { class: 'tile lg' }, ico('plus', 20, 1.6))),
      h('div', null, h('h3', null, 'Add a device'), h('p', { class: 'os', style: { lineHeight: '1.5' } }, 'Any browser can browse with the invite link. Add a PC or phone to the session and its whole file system shows up here — every drive, ready to browse, search, download and upload.')),
      h('button', { class: 'btn', type: 'button', onclick: () => $('#add-device')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, 'Add a device', ico('arrowRight', 15)),
    );
  }

  function renderFeed() {
    const list = [...S.transfers].sort((a, b) => b.startedAt - a.startedAt).slice(0, 6);
    feed.replaceChildren(
      ...(list.length
        ? list.map((t) => {
            const mine = t.clientId === clientId;
            const who = mine ? 'You' : t.clientName;
            const active = t.state === 'active';
            const verb = t.dir === 'down' ? (active ? (mine ? 'are downloading' : 'is downloading') : t.state === 'done' ? 'downloaded' : 'tried to download') : active ? (mine ? 'are sending' : 'is sending') : t.state === 'done' ? 'sent' : 'tried to send';
            const pct = t.total ? Math.min(100, Math.round((t.bytes / t.total) * 100)) : null;
            return h(
              'div',
              { class: 'feed-row' },
              h('span', { class: `tile ${active ? 'clay' : ''}` }, ico(t.dir === 'down' ? 'download' : 'upload', 15)),
              h(
                'div',
                { class: 't' },
                h('span', { class: 'ellipsis' }, h('b', null, who), ` ${verb} `, h('b', null, t.name), t.dir === 'down' ? ` from ${t.devName}` : ` into ${t.devName} › ${displayPath(t.path)}`),
                h('span', { class: 'm' }, active ? `${pct ?? '…'}% · ${fmtBytes(t.speed)}/s · ${routeLabel(t.route)}` : `${fmtBytes(t.total ?? t.bytes)} · ${routeLabel(t.route)}${t.state !== 'done' ? ` · ${t.state}` : ''}`),
              ),
              h('span', { class: `when ${active ? 'now' : ''}` }, active ? 'Now' : timeAgo(t.endedAt || t.startedAt)),
            );
          })
        : [h('div', { class: 'feed-row' }, h('span', { class: 'muted', style: { fontSize: '13px' } }, 'Nothing has moved yet. Downloads and sends from every device show up here.'))]),
    );
  }

  function invitePanel() {
    const a = S.access || {};
    const lan = a.lan || a.local;
    const line = (label, iconName, value) =>
      value
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, h('span', { class: 'code-label' }, ico(iconName, 13), label), h('div', { class: 'code-line' }, h('span', { class: 'mono' }, value), h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Copy: ${label}`, onclick: () => copyText(value) }, ico('copy', 15))))
        : null;
    return h(
      'section',
      { class: 'panel', id: 'invite', style: { flex: '2 1 340px', minWidth: 0 } },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, h('h2', null, 'Invite a device'), h('p', null, 'Open the link in any browser — phone, tablet or PC. No app or account needed.')),
      lan
        ? h('div', { class: 'qr-wrap' }, h('div', { class: 'qr' }, h('img', { src: `/qr.svg?${qs({ u: lan })}`, alt: 'QR code for the invite link' })), h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 } }, h('b', { style: { fontSize: '13.5px', fontWeight: 500 } }, 'Scan to join'), h('span', { class: 'muted', style: { fontSize: '12.5px', lineHeight: 1.5 } }, 'Point a phone camera at the code while it’s on the same Wi-Fi.')))
        : null,
      line('Same network', 'wifi', a.lan),
      line('Tailscale · from anywhere', 'globe', a.tailscale),
      addDeviceBlock(),
      h('div', { class: 'note' }, ico('shield', 15), h('span', null, a.key ? 'Anyone with this link can see, download and upload files on every device here. Keep it to your own devices.' : 'Open access is on: anyone who can reach this address can see, download and upload files.')),
    );
  }

  /** How to bring a device's own files into the session (a browser alone can't expose a file system). */
  function addDeviceBlock() {
    const a = S.access || {};
    // Whatever address this browser used to reach the host also works for a phone or PC next to it.
    const origin = S.you?.route === 'local' ? (a.lan ? new URL(a.lan).origin : location.origin) : location.origin;
    const termux = `cd ~ && pkg install -y nodejs unzip && termux-setup-storage; curl -fLo es.zip "${origin}/api/join-kit?${qs({ os: 'termux', key: a.key || '' })}" && unzip -oq es.zip && sh "Explorer Share/join.sh"`;
    return h(
      'div',
      { id: 'add-device', style: { display: 'flex', flexDirection: 'column', gap: '12px', paddingTop: '14px', borderTop: '1px solid var(--hair)' } },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, h('b', { style: { fontSize: '13.5px', fontWeight: 600 } }, 'Add a device’s files to the session'), h('span', { class: 'muted', style: { fontSize: '12.5px', lineHeight: 1.5 } }, 'Once a device is added, its whole file system is visible to everyone here. Nothing to pick.')),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
        h('span', { class: 'tile' }, ico('laptop', 15)),
        h('div', { style: { flex: '1 1 180px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' } }, h('span', { style: { fontSize: '13px', fontWeight: 500 } }, 'Windows PC'), h('span', { class: 'muted', style: { fontSize: '12px' } }, 'On that PC: download, unzip, double-click “Join session.bat”. No install.')),
        h('a', { class: 'btn sm soft', href: `/api/join-kit`, download: '' }, ico('download', 14, 2), 'Join kit'),
      ),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, h('span', { class: 'tile' }, ico('phone', 15)), h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } }, h('span', { style: { fontSize: '13px', fontWeight: 500 } }, 'Android phone or tablet'), h('span', { class: 'muted', style: { fontSize: '12px' } }, 'In Termux (from F-Droid), paste this and allow storage access:'))),
        h('div', { class: 'code-line' }, h('span', { class: 'mono' }, termux), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Copy the Android command', onclick: () => copyText(termux) }, ico('copy', 15))),
      ),
    );
  }

  function build() {
    const devs = S.devices;
    const total = devs.reduce((n, d) => n + storageOf(d).total, 0);
    const moving = activeTransfers().reduce((n, t) => n + (t.speed || 0), 0);
    el.replaceChildren(
      h(
        'div',
        { class: 'page-head' },
        h('div', { class: 't' }, h('span', { class: 'eyebrow' }, h('span', { class: 'conn-dot' }), `Live session · ${devs.length} ${devs.length === 1 ? 'device' : 'devices'} · ${S.viewers.length} ${S.viewers.length === 1 ? 'browser' : 'browsers'}`), h('h1', { class: 'display' }, 'Every device, one explorer.'), h('p', { class: 'lede' }, 'Browse, search, download or drop files into any folder on any device in this session. Files stream straight between devices — nothing is kept on the host.')),
        h('div', { class: 'stats' }, h('div', { class: 'stat' }, h('span', null, 'Online'), h('b', null, `${devs.length} ${devs.length === 1 ? 'device' : 'devices'}`)), h('div', { class: 'stat' }, h('span', null, 'Reachable storage'), h('b', null, total ? fmtBytes(total) : '—')), h('div', { class: 'stat' }, h('span', null, 'Moving now'), h('b', { class: 'clay', dataset: { moving: '1' } }, moving ? `${fmtBytes(moving)}/s` : 'Idle'))),
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, h('div', { class: 'section-head', style: { padding: 0 } }, h('h2', null, 'Connected devices'), h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Any device can open any other')), h('div', { class: 'dev-grid' }, devs.map(deviceCard), addCard())),
      h('div', { class: 'cols' }, h('section', { class: 'card', style: { flex: '3 1 420px', minWidth: 0, overflow: 'hidden' } }, h('div', { class: 'section-head' }, h('h2', null, 'Recent activity'), h('a', { href: '#/transfers', style: { fontSize: '13px', textDecoration: 'none' } }, 'All transfers')), feed), invitePanel()),
    );
    renderFeed();
  }

  build();
  return {
    el,
    title: 'Devices',
    onState: build,
    onTransfers() {
      renderFeed();
      const m = $('[data-moving]', el);
      const moving = activeTransfers().reduce((n, t) => n + (t.speed || 0), 0);
      if (m) m.textContent = moving ? `${fmtBytes(moving)}/s` : 'Idle';
    },
  };
}

// ───────────────────────── view: explorer ─────────────────────────

function viewBrowse(route) {
  const ex = S.ex;
  if (!route.dev || !deviceById(route.dev)) {
    const target = lastBrowseHash();
    if (route.dev && !deviceById(route.dev)) toast('That device has left the session.', 'err');
    if (target !== location.hash && target !== '#/browse') {
      location.replace(target);
      return null;
    }
    return { el: h('div', { class: 'page' }, h('div', { class: 'empty' }, h('b', null, 'No devices yet'), h('span', null, 'Waiting for a device to join.'))), title: 'Explorer' };
  }
  if (ex.dev !== route.dev || ex.path !== route.path) {
    ex.dev = route.dev;
    ex.path = route.path;
    ex.sel = new Set();
    ex.filter = '';
    ex.limit = 400;
    ex.anchor = null;
    ex.detailsOpen = false;
    ex.focus = route.focus || null;
    ex.data = listingCache.get(`${ex.dev}|${ex.path}`) || null;
    ex.error = null;
  } else if (route.focus) ex.focus = route.focus;
  LS.set('es.lastBrowse', { dev: ex.dev, path: ex.path });

  const dev = () => deviceById(ex.dev);
  const atDeviceRoot = () => !ex.path;
  const folderName = () => (ex.path ? baseOf(ex.path) : dev()?.name || 'Device');

  // DOM skeleton
  const listEl = h('div', { class: 'list', role: 'table', 'aria-label': 'Folder contents' });
  const footEl = h('div', { class: 'list-foot' });
  const overlay = h('div', { class: 'drop-over', hidden: true });
  const card = h('section', { class: 'list-card' }, h('div', { class: 'list-scroll' }, listEl), footEl, overlay);
  const details = h('aside', { class: 'panel details', 'aria-label': 'Details' });
  const headEl = h('div', { class: 'page-head' });
  const filterInput = h('input', { type: 'text', placeholder: 'Filter this folder', 'aria-label': 'Filter this folder', value: ex.filter });
  const devSwitch = h('div', { class: 'dev-switch', role: 'group', 'aria-label': 'Devices' });
  const crumbsEl = h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' });
  const dropStrip = h('div', { class: 'drop-strip' });
  const rows = new Map(); // name → row element

  filterInput.addEventListener('input', debounce(() => {
    ex.filter = filterInput.value;
    ex.limit = 400;
    renderList();
  }, 80));

  const upBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Up one folder', title: 'Up one folder (Alt+↑)', onclick: goUp }, ico('arrowUp', 16));
  const el = h(
    'div',
    null,
    h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'seg' }, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onclick: () => history.back() }, ico('chevronLeft', 16)), h('button', { class: 'icon-btn hide-m', type: 'button', 'aria-label': 'Forward', onclick: () => history.forward() }, ico('chevronRight', 16)), upBtn),
      crumbsEl,
      h('label', { class: 'field', style: { width: '230px' } }, ico('filter', 15), filterInput),
      h('button', { class: 'icon-btn hide-m', type: 'button', 'aria-label': 'Refresh', title: 'Refresh', onclick: () => load({ keep: true }) }, ico('refresh', 16)),
    ),
    h('div', { class: 'page' }, devSwitch, headEl, dropStrip, h('div', { class: 'cols' }, h('div', { class: 'col-main' }, card), h('div', { class: 'col-side' }, details))),
  );

  function goUp() {
    if (!ex.path) return;
    location.hash = browseHash(ex.dev, parentOf(ex.path), baseOf(ex.path));
  }

  function renderCrumbs() {
    const d = dev();
    const segs = ex.path ? ex.path.split('/') : [];
    const parts = [h('a', { class: 'crumb', href: browseHash(ex.dev), 'aria-current': segs.length ? null : 'page' }, ico(DEVICE_ICON[d?.kind] || 'desktop', 14), h('span', { class: 'ellipsis' }, d?.name || 'Device'))];
    segs.forEach((s, i) => {
      const p = segs.slice(0, i + 1).join('/');
      const root = i === 0 ? d?.roots?.find((r) => r.id === s) : null;
      parts.push(h('span', { class: 'crumb-sep' }, ico('chevronRight', 14)));
      parts.push(h('a', { class: 'crumb', href: browseHash(ex.dev, p), 'aria-current': i === segs.length - 1 ? 'page' : null }, h('span', { class: 'ellipsis' }, root?.label ? `${s} ${root.label}` : s)));
    });
    crumbsEl.replaceChildren(...parts);
    upBtn.disabled = !ex.path;
  }

  function renderDevSwitch() {
    devSwitch.replaceChildren(
      ...S.devices.map((d) => h('a', { class: 'chip', href: browseHash(d.id), 'aria-pressed': d.id === ex.dev ? 'true' : 'false' }, ico(DEVICE_ICON[d.kind] || 'desktop', 15), d.id === S.you?.deviceId ? 'This device' : d.name)),
    );
  }

  function renderHead() {
    const d = dev();
    const entries = ex.data?.entries || [];
    const files = entries.filter((e) => !e.dir);
    const size = files.reduce((n, e) => n + (e.size || 0), 0);
    const meta = atDeviceRoot()
      ? `${(d?.roots || []).length} ${(d?.roots || []).length === 1 ? 'drive' : 'drives'} · ${d?.os || ''} · ${deviceMeta(d || {})}`
      : ex.data
        ? `${entries.length} ${entries.length === 1 ? 'item' : 'items'}${files.length ? ` · ${fmtBytes(size)} in files` : ''} · on ${d?.name}`
        : ex.loading
          ? 'Loading…'
          : '';
    headEl.replaceChildren(
      h('div', { class: 't' }, h('h1', { class: 'title' }, folderName()), h('p', { class: 'sub' }, meta)),
      atDeviceRoot()
        ? ''
        : h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
            h('button', { class: 'btn', type: 'button', onclick: newFolder }, ico('folderPlus', 15), 'New folder'),
            h('button', { class: 'btn hide-m', type: 'button', onclick: () => pick(false) }, ico('upload', 15), 'Send files here'),
            ex.path.includes('/') ? h('button', { class: 'btn primary', type: 'button', onclick: () => downloadZip(ex.dev, parentOf(ex.path), [baseOf(ex.path)]) }, ico('download', 15, 2), 'Download folder as ZIP') : null,
          ),
    );
    dropStrip.hidden = atDeviceRoot();
    if (!atDeviceRoot()) {
      dropStrip.replaceChildren(
        h('span', { class: 'tile clay', style: { width: '38px', height: '38px', borderRadius: '10px' } }, ico('upload', 17)),
        h('div', { class: 't' }, h('b', null, 'Drop files or folders here to send them into this folder'), h('span', null, 'They land in ', h('span', { class: 'mono dim' }, displayPath(ex.path)), ` on ${d?.name}. Drop onto a folder row to send into that folder instead.`)),
        h('div', { style: { display: 'flex', gap: '8px' } }, h('button', { class: 'btn sm', type: 'button', onclick: () => pick(false) }, 'Choose files'), h('button', { class: 'btn sm', type: 'button', onclick: () => pick(true) }, 'Choose folder')),
      );
    }
  }

  // ── listing ──

  async function load({ keep = false } = {}) {
    const id = ++ex.reqId;
    if (atDeviceRoot()) {
      ex.data = { roots: true, entries: [] };
      ex.loading = false;
      renderAll();
      return;
    }
    ex.loading = true;
    if (!keep && !ex.data) renderAll();
    try {
      const data = await api(`/api/ls?${qs({ dev: ex.dev, path: ex.path })}`);
      if (id !== ex.reqId) return;
      ex.data = data;
      ex.error = null;
      listingCache.set(`${ex.dev}|${ex.path}`, data);
      if (listingCache.size > 40) listingCache.delete(listingCache.keys().next().value);
      const names = new Set(data.entries.map((e) => e.name));
      for (const n of ex.sel) if (!names.has(n)) ex.sel.delete(n);
    } catch (e) {
      if (id !== ex.reqId) return;
      ex.error = e.message;
      ex.data = null;
    }
    ex.loading = false;
    renderAll();
  }

  function sorted() {
    let list = ex.data?.entries || [];
    const f = ex.filter.trim().toLowerCase();
    if (f) list = list.filter((e) => e.name.toLowerCase().includes(f));
    const { k, d } = ex.sort;
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    const key = (a, b) => (k === 'size' ? (a.size ?? -1) - (b.size ?? -1) : k === 'date' ? (a.mtime ?? 0) - (b.mtime ?? 0) : k === 'kind' ? kindLabel(a.name, a.dir).localeCompare(kindLabel(b.name, b.dir)) : byName(a, b));
    return [...list].sort((a, b) => Number(b.dir) - Number(a.dir) || key(a, b) * d || byName(a, b));
  }

  function headRow() {
    const sortBtn = (k, label) => {
      const on = ex.sort.k === k;
      return h(
        'button',
        {
          type: 'button',
          'data-active': on ? '1' : null,
          onclick: () => {
            ex.sort = { k, d: on ? -ex.sort.d : 1 };
            LS.set('es.sort', ex.sort);
            renderList();
          },
        },
        label,
        on ? ico(ex.sort.d > 0 ? 'sortAsc' : 'sortDesc', 12, 2) : null,
      );
    };
    const all = h('input', { type: 'checkbox', 'aria-label': 'Select all', onclick: (e) => selectAll(e.target.checked) });
    all.dataset.all = '1';
    return h('div', { class: 'lrow head', role: 'row' }, h('div', null, atDeviceRoot() ? null : all), sortBtn('name', 'Name'), sortBtn('size', 'Size'), sortBtn('kind', 'Kind'), sortBtn('date', 'Modified'));
  }

  function metaLine(e) {
    if (e.dir) return e.count != null ? `${e.count} ${e.count === 1 ? 'item' : 'items'} · ${fmtDate(e.mtime)}` : fmtDate(e.mtime);
    return `${fmtBytes(e.size)} · ${fmtDate(e.mtime)}`;
  }

  function entryRow(e, index) {
    const k = kindOf(e.name, e.dir);
    const cb = h('input', { type: 'checkbox', 'aria-label': `Select ${e.name}` });
    cb.checked = ex.sel.has(e.name);
    cb.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggle(e.name, cb.checked, index, ev.shiftKey);
    });
    const nameBtn = h('button', { class: 'n ellipsis', type: 'button' }, e.name);
    const row = h(
      'div',
      { class: 'lrow', role: 'row', dataset: { name: e.name, dir: e.dir ? '1' : '' } },
      h('div', null, cb),
      h('div', { class: 'name' }, tile(k), h('div', { class: 'nm' }, nameBtn, h('span', { class: 'meta-m ellipsis' }, metaLine(e)))),
      h('span', { class: 'c-size' }, e.dir ? (e.count != null ? `${e.count} ${e.count === 1 ? 'item' : 'items'}` : '—') : fmtBytes(e.size)),
      h('span', { class: 'c-kind' }, kindLabel(e.name, e.dir)),
      h('span', { class: 'c-date' }, fmtDate(e.mtime)),
    );
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('input')) return;
      if (ev.ctrlKey || ev.metaKey) return toggle(e.name, !ex.sel.has(e.name), index, false);
      if (ev.shiftKey) return toggle(e.name, true, index, true);
      if (e.dir) location.hash = browseHash(ex.dev, joinPath(ex.path, e.name));
      else setFocus(e.name, true);
    });
    row.addEventListener('dblclick', () => !e.dir && downloadFile(ex.dev, joinPath(ex.path, e.name)));
    row._cb = cb;
    return row;
  }

  function rootRow(r) {
    const used = r.total != null ? r.total - (r.free ?? 0) : null;
    const pct = r.total ? Math.round((used / r.total) * 100) : 0;
    const row = h(
      'div',
      { class: 'lrow drive', role: 'row' },
      h('div'),
      h('div', { class: 'name' }, h('span', { class: 'tile folder' }, ico(r.kind === 'folder' ? 'folder' : 'drive', 16)), h('div', { class: 'nm' }, h('button', { class: 'n ellipsis', type: 'button' }, r.label ? `${r.id}  ${r.label}` : r.id), h('span', { class: 'meta-m' }, r.total ? `${fmtBytes(r.free)} free of ${fmtBytes(r.total)}` : 'Folder'))),
      h('span', { class: 'c-size' }, r.total ? [h('span', null, `${fmtBytes(r.free)} free`), h('div', { class: 'bar thin', style: { width: '96px' } }, h('i', { style: { width: `${pct}%` } }))] : '—'),
      h('span', { class: 'c-kind' }, r.kind === 'folder' ? 'Folder' : r.kind === 'removable' ? 'Removable drive' : r.kind === 'network' ? 'Network drive' : 'Drive'),
      h('span', { class: 'c-date' }, r.total ? fmtBytes(r.total) : ''),
    );
    row.addEventListener('click', () => (location.hash = browseHash(ex.dev, r.id)));
    return row;
  }

  function renderList() {
    rows.clear();
    if (ex.error) {
      listEl.replaceChildren(h('div', { class: 'empty', style: { margin: '16px', border: 0 } }, h('b', null, 'Couldn’t open this folder'), h('span', null, ex.error), h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, 'Try again')));
      renderFoot();
      return;
    }
    if (!ex.data) {
      listEl.replaceChildren(headRow(), h('div', { class: 'more-row muted' }, 'Loading…'));
      renderFoot();
      return;
    }
    if (atDeviceRoot()) {
      listEl.replaceChildren(headRow(), ...(dev()?.roots || []).map(rootRow));
      renderFoot();
      return;
    }
    const list = sorted();
    const shown = list.slice(0, ex.limit);
    const frag = [headRow(), h('div', { dataset: { arrivals: '1' } })];
    shown.forEach((e, i) => {
      const r = entryRow(e, i);
      rows.set(e.name, r);
      frag.push(r);
    });
    if (!list.length) frag.push(h('div', { class: 'empty', style: { margin: '16px', border: 0, padding: '40px 16px' } }, h('b', null, ex.filter ? 'Nothing matches the filter' : 'This folder is empty'), h('span', null, ex.filter ? 'Try another name.' : 'Drop files here to send them in.')));
    if (list.length > shown.length) {
      frag.push(h('div', { class: 'more-row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => { ex.limit += 1000; renderList(); } }, `Show more (${(list.length - shown.length).toLocaleString()} left)`)));
    }
    listEl.replaceChildren(...frag);
    updateSelection();
    renderArrivals();
    if (ex.focus && rows.has(ex.focus)) {
      const r = rows.get(ex.focus);
      r.classList.add('focus');
      requestAnimationFrame(() => r.scrollIntoView({ block: 'nearest' }));
    }
  }

  function renderArrivals() {
    const box = $('[data-arrivals]', listEl);
    if (!box) return;
    const incoming = S.transfers.filter((t) => t.state === 'active' && t.dir === 'up' && t.devId === ex.dev && t.path === ex.path);
    for (const r of rows.values()) r.classList.remove('arriving');
    const synth = [];
    for (const t of incoming) {
      const pct = t.total ? Math.min(100, Math.round((t.bytes / t.total) * 100)) : 0;
      const prog = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } }, h('span', { class: 'mono', style: { fontSize: '12px', color: 'var(--clay-text)' } }, `${pct}% · ${fmtBytes(t.bytes)}`), h('div', { class: 'bar thin', style: { width: '92px' } }, h('i', { style: { width: `${pct}%` } })));
      const existing = rows.get(t.name);
      if (existing) {
        existing.classList.add('arriving');
        existing.children[2].replaceChildren(prog);
        continue;
      }
      synth.push(
        h(
          'div',
          { class: 'lrow arriving', role: 'row' },
          h('div', { style: { color: 'var(--clay-text)', display: 'flex' } }, ico('arrowUp', 16)),
          h('div', { class: 'name' }, tile(t.files > 1 ? 'folder' : kindOf(t.name, false)), h('div', { class: 'nm' }, h('span', { class: 'n ellipsis' }, t.name), h('span', { class: 'meta-m' }, `Arriving · ${pct}%`)), h('span', { class: 'tag clay hide-m' }, 'Arriving')),
          h('span', { class: 'c-size' }, prog),
          h('span', { class: 'c-kind' }, `From ${t.clientId === clientId ? 'you' : t.clientName}`),
          h('span', { class: 'c-date' }, t.speed ? fmtEta((t.total - t.bytes) / t.speed) : ''),
        ),
      );
    }
    box.replaceChildren(...synth);
  }

  // ── selection ──

  function toggle(name, on, index, range) {
    const list = sorted().slice(0, ex.limit);
    if (range && ex.anchor != null) {
      const [a, b] = [Math.min(ex.anchor, index), Math.max(ex.anchor, index)];
      for (let i = a; i <= b; i++) on ? ex.sel.add(list[i].name) : ex.sel.delete(list[i].name);
    } else {
      on ? ex.sel.add(name) : ex.sel.delete(name);
      ex.anchor = index;
    }
    updateSelection();
  }

  function selectAll(on) {
    if (on) for (const e of sorted()) ex.sel.add(e.name);
    else ex.sel.clear();
    updateSelection();
  }

  function updateSelection() {
    for (const [name, row] of rows) {
      const on = ex.sel.has(name);
      row.classList.toggle('sel', on);
      if (row._cb.checked !== on) row._cb.checked = on;
    }
    const all = $('[data-all]', listEl);
    const total = sorted().length;
    if (all) {
      all.checked = total > 0 && ex.sel.size === total;
      all.indeterminate = ex.sel.size > 0 && ex.sel.size < total;
    }
    renderFoot();
  }

  function renderFoot() {
    document.body.classList.toggle('has-selbar', ex.sel.size > 0);
    if (atDeviceRoot()) {
      footEl.className = 'list-foot';
      footEl.replaceChildren(h('span', null, 'Pick a drive or folder to explore. Everything here can be searched from the Search page.'));
      return;
    }
    if (!ex.sel.size) {
      footEl.className = 'list-foot';
      const n = ex.data?.entries?.length ?? 0;
      footEl.replaceChildren(h('span', null, ex.data ? `${n.toLocaleString()} ${n === 1 ? 'item' : 'items'}${ex.data.truncated ? ' (first 50,000 shown)' : ''} · Select files or folders to download. Folders arrive as a .zip built while it streams.` : ''));
      return;
    }
    const entries = (ex.data?.entries || []).filter((e) => ex.sel.has(e.name));
    const files = entries.filter((e) => !e.dir);
    const folders = entries.length - files.length;
    const bytes = files.reduce((n, e) => n + (e.size || 0), 0);
    footEl.className = 'list-foot sel-bar';
    const single = entries.length === 1 && files.length === 1 ? files[0] : null;
    footEl.replaceChildren(
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, h('span', { class: 'count-pill' }, String(entries.length)), h('span', null, `selected · `, h('span', { class: 'mono', style: { color: 'var(--text)' } }, files.length ? fmtBytes(bytes) : ''), folders ? `${files.length ? ' + ' : ''}${folders} ${folders === 1 ? 'folder' : 'folders'}` : ''), h('button', { class: 'btn quiet sm', type: 'button', style: { marginLeft: 'auto' }, onclick: () => { ex.sel.clear(); updateSelection(); } }, 'Clear')),
      h(
        'div',
        { class: 'actions' },
        single
          ? h('button', { class: 'btn sm', type: 'button', onclick: () => downloadFile(ex.dev, joinPath(ex.path, single.name)) }, ico('download', 14), 'Download')
          : h('button', { class: 'btn sm', type: 'button', onclick: downloadSeparately, disabled: !files.length || files.length > 20 || folders > 0 ? true : null, title: 'Each file as its own download' }, ico('download', 14), 'Separately'),
        h('button', { class: 'btn primary sm', type: 'button', onclick: () => downloadZip(ex.dev, ex.path, entries.map((e) => e.name), entries.length === 1 ? entries[0].name : folderName()) }, ico('archive', 14, 2), 'Download as ZIP'),
      ),
    );
  }

  function downloadSeparately() {
    const files = (ex.data?.entries || []).filter((e) => ex.sel.has(e.name) && !e.dir);
    files.forEach((f, i) => setTimeout(() => triggerDownload(`/api/file?${qs({ dev: ex.dev, path: joinPath(ex.path, f.name), c: clientId })}`), i * 400));
    toast(`Downloading ${files.length} files — your browser may ask to allow multiple downloads.`);
  }

  // ── details ──

  function setFocus(name, open) {
    rows.get(ex.focus)?.classList.remove('focus');
    ex.focus = name;
    rows.get(name)?.classList.add('focus');
    ex.detailsOpen = Boolean(open);
    renderDetails();
  }

  function renderDetails() {
    const d = dev();
    const e = ex.focus ? (ex.data?.entries || []).find((x) => x.name === ex.focus) : null;
    details.classList.toggle('open', Boolean(e) && ex.detailsOpen && isPhone());
    const closeBtn = h('button', { class: 'icon-btn close', type: 'button', 'aria-label': 'Close details', onclick: () => { ex.detailsOpen = false; details.classList.remove('open'); } }, ico('x', 16));
    if (!e) {
      const entries = ex.data?.entries || [];
      const folders = entries.filter((x) => x.dir).length;
      details.replaceChildren(
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, h('span', { class: 'tile lg clay' }, ico(atDeviceRoot() ? DEVICE_ICON[d?.kind] || 'desktop' : 'folderOpen', 20)), h('div', { style: { minWidth: 0 } }, h('div', { class: 'name' }, folderName()), h('div', { class: 'muted', style: { fontSize: '13px' } }, atDeviceRoot() ? d?.os : `${folders} ${folders === 1 ? 'folder' : 'folders'} · ${entries.length - folders} ${entries.length - folders === 1 ? 'file' : 'files'}`))),
        h('dl', null, h('div', null, h('dt', null, 'Device'), h('dd', null, d?.name || '')), h('div', null, h('dt', null, 'Connection'), h('dd', null, deviceMeta(d || {}))), ex.path ? h('div', { class: 'stack' }, h('dt', null, 'Location'), h('dd', { class: 'mono' }, displayPath(ex.path))) : null),
        h('p', null, atDeviceRoot() ? 'Open a drive to start. Select items to download them, or drop files on a folder to send them there.' : 'Click a file to preview it here. Double-click to download.'),
      );
      return;
    }
    const path = joinPath(ex.path, e.name);
    const kind = kindOf(e.name, e.dir);
    const inlineUrl = `/api/file?${qs({ dev: ex.dev, path, inline: 1 })}`;
    const preview = h('div', { class: 'preview' });
    const type = e.dir ? null : previewType(e.name);
    if (e.dir) preview.append(h('span', { class: 'tile lg clay', style: { width: '64px', height: '64px', borderRadius: '16px' } }, ico('folder', 28, 1.5)));
    else if (type?.startsWith('image/') && e.size < 80 * 1024 * 1024) preview.append(h('img', { src: inlineUrl, alt: e.name, loading: 'lazy', onerror: (ev) => ev.target.replaceWith(ico('image', 32, 1.5)) }));
    else if (type?.startsWith('video/')) preview.append(h('video', { src: inlineUrl, controls: true, preload: 'metadata', playsinline: true }));
    else if (type?.startsWith('audio/')) preview.append(h('audio', { src: inlineUrl, controls: true, preload: 'metadata' }));
    else if (type?.startsWith('text/')) {
      const pre = h('pre', null, 'Loading…');
      preview.append(pre);
      fetch(inlineUrl, { headers: { range: 'bytes=0-32767' } })
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error())))
        .then((t) => (pre.textContent = t + (e.size > 32768 ? '\n…' : '')))
        .catch(() => (pre.textContent = 'Preview unavailable.'));
    } else preview.append(h('span', { class: 'tile lg', style: { width: '64px', height: '64px', borderRadius: '16px' } }, ico(KIND_ICON[kind] || 'file', 28, 1.5)));

    details.replaceChildren(
      closeBtn,
      preview,
      h('div', null, h('div', { class: 'name' }, e.name), h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '3px' } }, kindLabel(e.name, e.dir))),
      h(
        'dl',
        null,
        h('div', null, h('dt', null, 'Size'), h('dd', { class: 'mono', style: { textAlign: 'right' } }, e.dir ? (e.count != null ? `${e.count} items` : '—') : fmtBytes(e.size))),
        h('div', null, h('dt', null, 'Modified'), h('dd', null, e.mtime ? new Date(e.mtime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—')),
        h('div', null, h('dt', null, 'Device'), h('dd', null, d?.name || '')),
        h('div', { class: 'stack' }, h('dt', null, 'Location'), h('dd', { class: 'mono' }, displayPath(path))),
      ),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        e.dir
          ? [h('a', { class: 'btn primary', href: browseHash(ex.dev, path) }, ico('folderOpen', 15), 'Open folder'), h('button', { class: 'btn', type: 'button', onclick: () => downloadZip(ex.dev, ex.path, [e.name]) }, ico('archive', 15), 'Download as ZIP')]
          : [h('button', { class: 'btn primary', type: 'button', onclick: () => downloadFile(ex.dev, path) }, ico('download', 15, 2), 'Download'), type ? h('a', { class: 'btn', href: inlineUrl, target: '_blank', rel: 'noopener' }, ico('external', 15), 'Open in new tab') : null],
      ),
    );
  }

  // ── sending into folders ──

  function pick(folder) {
    const input = $(folder ? '#pickFolder' : '#pickFiles');
    input.value = '';
    input.onchange = () => {
      const files = [...input.files];
      if (!files.length) return;
      const items = files.map((f) => ({ file: f, rel: folder && f.webkitRelativePath ? f.webkitRelativePath : f.name }));
      sendItems(ex.dev, ex.path, items, []);
    };
    input.click();
  }

  function newFolder() {
    modal({
      title: 'New folder',
      text: `In ${displayPath(ex.path)} on ${dev()?.name}`,
      input: { value: 'New folder', label: 'Folder name' },
      okLabel: 'Create',
      onOk: async (name) => {
        const r = await api('/api/mkdir', { method: 'POST', body: { dev: ex.dev, dir: ex.path, name } });
        ex.focus = r.name;
        await load({ keep: true });
      },
    });
  }

  let dropTarget = null;
  function dropInfo(row) {
    const target = row?.dataset.dir ? joinPath(ex.path, row.dataset.name) : ex.path;
    return { target, label: row?.dataset.dir ? row.dataset.name : folderName() };
  }

  function onDragOver(ev) {
    if (atDeviceRoot() || !ev.dataTransfer?.types?.includes('Files')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    const row = ev.target.closest?.('.lrow[data-dir="1"]');
    if (row !== dropTarget) {
      dropTarget?.classList.remove('target');
      dropTarget = row || null;
      dropTarget?.classList.add('target');
    }
    const { label, target } = dropInfo(dropTarget);
    overlay.hidden = Boolean(dropTarget);
    if (!dropTarget) {
      overlay.replaceChildren(h('div', { class: 'in' }, h('span', { class: 'disc' }, ico('upload', 24, 2)), h('b', null, `Drop to send into ${label}`), h('span', { class: 'mono dim', style: { fontSize: '12.5px' } }, `${dev()?.name} · ${displayPath(target)}`), h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Folders keep their structure. If a name already exists, the new copy gets “(2)”.')));
    }
  }

  function clearDrag() {
    overlay.hidden = true;
    dropTarget?.classList.remove('target');
    dropTarget = null;
  }

  async function onDrop(ev) {
    if (atDeviceRoot() || !ev.dataTransfer?.types?.includes('Files')) return;
    ev.preventDefault();
    const { target } = dropInfo(dropTarget);
    clearDrag();
    const { items, emptyDirs } = await collectDrop(ev.dataTransfer);
    if (items.length || emptyDirs.length) sendItems(ex.dev, target, items, emptyDirs);
  }

  let dragDepth = 0;
  const onDragEnter = (ev) => {
    if (ev.dataTransfer?.types?.includes('Files')) dragDepth++;
  };
  const onDragLeave = () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) clearDrag();
  };
  const onDropDoc = () => {
    dragDepth = 0;
  };

  // ── keyboard ──

  function onKey(ev) {
    if (ev.target.closest('input, textarea, .modal')) return;
    if (ev.key === 'Escape') {
      if (ex.detailsOpen) {
        ex.detailsOpen = false;
        details.classList.remove('open');
      } else if (ex.sel.size) {
        ex.sel.clear();
        updateSelection();
      }
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a' && !atDeviceRoot()) {
      ev.preventDefault();
      selectAll(true);
    } else if ((ev.altKey && ev.key === 'ArrowUp') || ev.key === 'Backspace') {
      ev.preventDefault();
      goUp();
    }
  }

  function renderAll() {
    renderCrumbs();
    renderDevSwitch();
    renderHead();
    renderList();
    renderDetails();
  }

  renderAll();
  load({ keep: Boolean(ex.data) });

  const changed = debounce(() => load({ keep: true }), 250);
  return {
    el,
    title: folderName(),
    mounted() {
      document.addEventListener('dragover', onDragOver);
      document.addEventListener('dragenter', onDragEnter);
      document.addEventListener('dragleave', onDragLeave);
      document.addEventListener('drop', onDrop);
      document.addEventListener('drop', onDropDoc, true);
      document.addEventListener('keydown', onKey);
    },
    destroy() {
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
      document.removeEventListener('drop', onDropDoc, true);
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('has-selbar');
    },
    onState() {
      if (!deviceById(ex.dev)) {
        toast('That device left the session.', 'err');
        location.hash = '#/';
        return;
      }
      renderCrumbs();
      renderDevSwitch();
      if (atDeviceRoot()) renderList();
    },
    onTransfers: renderArrivals,
    onChanged(m) {
      if (m.dev === ex.dev && m.dir === ex.path) changed();
    },
  };
}

/** Read everything dropped, including whole folder trees. Must start synchronously in the drop handler. */
async function collectDrop(dt) {
  const entries = [...(dt.items || [])].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return { items: [...(dt.files || [])].map((f) => ({ file: f, rel: f.name })), emptyDirs: [] };
  const items = [];
  const emptyDirs = [];
  const readAll = (reader) =>
    new Promise((resolve) => {
      const out = [];
      const next = () =>
        reader.readEntries(
          (batch) => {
            if (!batch.length) return resolve(out);
            out.push(...batch);
            next();
          },
          () => resolve(out),
        );
      next();
    });
  async function walk(entry, prefix) {
    if (entry.isFile) {
      try {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        items.push({ file, rel: prefix + file.name });
      } catch {}
    } else if (entry.isDirectory) {
      const children = await readAll(entry.createReader());
      if (!children.length) emptyDirs.push(prefix + entry.name);
      for (const c of children) await walk(c, `${prefix}${entry.name}/`);
    }
  }
  for (const e of entries) await walk(e, '');
  return { items, emptyDirs };
}

async function sendItems(devId, dir, items, emptyDirs) {
  const dev = deviceById(devId);
  const tops = new Map();
  for (const it of items) {
    const [top, ...rest] = it.rel.split('/');
    tops.set(top, tops.get(top) || rest.length > 0);
  }
  for (const d of emptyDirs) tops.set(d.split('/')[0], true);
  const topList = [...tops].map(([name, isDir]) => ({ name, dir: isDir }));
  const bytes = items.reduce((n, it) => n + it.file.size, 0);
  const label = topList.length === 1 ? topList[0].name : `${topList.length} items`;
  let begin;
  try {
    begin = await api('/api/upload/begin', { method: 'POST', body: { dev: devId, dir, tops: topList, files: items.length, bytes, label, c: clientId } });
  } catch (e) {
    toast(`Couldn’t send to ${dev?.name || 'that device'}: ${e.message}`, 'err');
    return;
  }
  const rename = new Map(topList.map((t, i) => [t.name, begin.names[i]]));
  const up = { canceled: false, xhrs: new Set() };
  S.uploads.set(begin.transfer, up);
  toast(`Sending ${label} to ${dev?.name}`);
  const queue = items.map((it) => {
    const [top, ...rest] = it.rel.split('/');
    return { file: it.file, rel: [rename.get(top) || top, ...rest].join('/') };
  });
  let failed = 0;
  let lastErr = '';
  let next = 0;
  const worker = async () => {
    while (next < queue.length && !up.canceled) {
      const it = queue[next++];
      try {
        await putFile(up, begin.batch, it);
      } catch (e) {
        if (!up.canceled) {
          failed++;
          lastErr = e.message;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  await api('/api/upload/end', { method: 'POST', body: { batch: begin.batch, state: up.canceled ? 'canceled' : 'done' } }).catch(() => {});
  S.uploads.delete(begin.transfer);
  if (up.canceled) toast(`Stopped sending ${label}.`);
  else if (failed) toast(`${failed} of ${items.length} files couldn’t be sent: ${lastErr}`, 'err');
  else toast(`Sent ${label} to ${dev?.name}`, 'ok');
}

function putFile(up, batch, it) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const params = qs({ batch, rel: it.rel, size: it.file.size, mtime: it.file.lastModified || '' });
    xhr.open('PUT', `/api/upload?${params}`);
    const done = () => up.xhrs.delete(xhr);
    xhr.onload = () => {
      done();
      if (xhr.status === 200) return resolve();
      let msg = `HTTP ${xhr.status}`;
      try {
        msg = JSON.parse(xhr.responseText).error || msg;
      } catch {}
      reject(new Error(msg));
    };
    xhr.onerror = () => {
      done();
      reject(new Error('Connection lost.'));
    };
    xhr.onabort = () => {
      done();
      reject(new Error('Canceled.'));
    };
    up.xhrs.add(xhr);
    xhr.send(it.file);
  });
}

// ───────────────────────── view: search ─────────────────────────

const TYPE_TABS = [
  ['any', 'Any type'],
  ['doc', 'Documents'],
  ['image', 'Images'],
  ['video', 'Video'],
  ['audio', 'Audio'],
  ['archive', 'Archives'],
  ['folder', 'Folders'],
];

/** "invoice on:pixel in:finance ext:pdf" → server terms + client-side filters. */
function parseQuery(raw) {
  const terms = [];
  let on = null;
  let inside = null;
  for (const tok of String(raw).trim().split(/\s+/).filter(Boolean)) {
    const m = /^(on|in|ext):(.+)$/i.exec(tok);
    if (!m) terms.push(tok);
    else if (m[1].toLowerCase() === 'on') on = m[2].toLowerCase();
    else if (m[1].toLowerCase() === 'in') inside = m[2].toLowerCase();
    else terms.push(`.${m[2].replace(/^\./, '')}`);
  }
  return { terms, on, inside };
}

function viewSearch(route) {
  const sr = S.sr;
  if (route.q && route.q !== sr.q) sr.q = route.q;
  const input = h('input', { type: 'text', value: sr.q, placeholder: 'Search file and folder names on every device', 'aria-label': 'Search across all devices', autocomplete: 'off', spellcheck: 'false' });
  const chips = h('div', { role: 'group', 'aria-label': 'Filter by device', style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } });
  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Filter by type' });
  const meta = h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', padding: '0 2px' } });
  const results = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
  const indexPanel = h('section', { class: 'panel' });

  const run = debounce(runSearch, 140);
  input.addEventListener('input', () => {
    sr.q = input.value;
    history.replaceState(null, '', sr.q ? `#/search?q=${encodeURIComponent(sr.q)}` : '#/search');
    run();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      sr.q = '';
      runSearch();
    }
  });

  async function runSearch() {
    const { terms } = parseQuery(sr.q);
    const id = ++sr.reqId;
    if (!terms.length) {
      sr.data = null;
      sr.loading = false;
      renderResults();
      return;
    }
    sr.loading = true;
    renderMeta();
    try {
      const key = `${sr.q}|${sr.kind}`;
      const data = await api(`/api/search?${qs({ q: terms.join(' '), kind: sr.kind, limit: 80 })}`);
      if (id !== sr.reqId) return;
      sr.data = data;
      sr.dataKey = key;
      sr.error = null;
    } catch (e) {
      if (id !== sr.reqId) return;
      sr.error = e.message;
      sr.data = null;
    }
    sr.loading = false;
    renderResults();
  }

  function filtered() {
    const { on, inside } = parseQuery(sr.q);
    const groups = [];
    for (const d of S.devices) {
      const r = sr.data?.results?.find((x) => x.dev === d.id);
      if (!r) continue;
      if (on && !d.name.toLowerCase().includes(on)) continue;
      let items = r.items;
      if (inside) items = items.filter((i) => parentOf(i.path).toLowerCase().includes(inside));
      groups.push({ dev: d, items, error: r.error });
    }
    return groups;
  }

  function highlight(name) {
    const { terms } = parseQuery(sr.q);
    const lower = name.toLowerCase();
    const term = terms.map((t) => t.toLowerCase()).sort((a, b) => b.length - a.length).find((t) => lower.includes(t));
    if (!term) return [name];
    const i = lower.indexOf(term);
    return [name.slice(0, i), h('mark', null, name.slice(i, i + term.length)), name.slice(i + term.length)];
  }

  function resultRow(d, it) {
    const kind = kindOf(it.name, it.dir);
    const parent = parentOf(it.path);
    const openHref = it.dir ? browseHash(d.id, it.path) : browseHash(d.id, parent, it.name);
    return h(
      'div',
      { class: 'rrow' },
      h('a', { class: 'name', href: openHref, style: { color: 'inherit', textDecoration: 'none' } }, tile(kind), h('div', { class: 'nt' }, h('span', { class: 'n ellipsis' }, highlight(it.name)), h('span', { class: 'p ellipsis' }, displayPath(parent) || d.name))),
      h('span', { class: 'c-size mono dim', style: { fontSize: '12.5px' } }, it.dir ? 'Folder' : fmtBytes(it.size)),
      h('span', { class: 'c-date muted', style: { fontSize: '13px' } }, fmtDate(it.mtime)),
      h(
        'div',
        { class: 'acts' },
        h('a', { class: 'icon-btn', href: browseHash(d.id, parent, it.name), 'aria-label': `Show ${it.name} in its folder`, title: 'Show in folder' }, ico('folderOpen', 16)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Download ${it.name}`, title: it.dir ? 'Download as ZIP' : 'Download', onclick: () => (it.dir ? downloadZip(d.id, parent, [it.name]) : downloadFile(d.id, it.path)) }, ico('download', 16)),
      ),
    );
  }

  function renderMeta() {
    const groups = filtered();
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    const shown = groups.filter((g) => sr.dev === 'all' || g.dev.id === sr.dev);
    const shownTotal = shown.reduce((n, g) => n + g.items.length, 0);
    const withHits = shown.filter((g) => g.items.length).length;
    meta.replaceChildren(
      h('span', { style: { fontSize: '14px' } }, sr.loading && !sr.data ? 'Searching…' : sr.data ? [h('b', { style: { fontWeight: 600 } }, `${shownTotal} ${shownTotal === 1 ? 'result' : 'results'}`), h('span', { class: 'muted' }, ` ${withHits === 1 ? 'on 1 device' : `across ${withHits} devices`}`)] : h('span', { class: 'muted' }, 'Type to search every device at once.')),
      sr.data ? h('span', { class: 'mono muted', style: { fontSize: '12px' } }, `${sr.data.results.length} ${sr.data.results.length === 1 ? 'index' : 'indexes'} searched in parallel · ${sr.data.ms} ms`) : '',
    );
    chips.replaceChildren(
      ...[{ id: 'all', name: 'All devices', n: total }, ...S.devices.map((d) => ({ id: d.id, name: d.name, n: groups.find((g) => g.dev.id === d.id)?.items.length ?? 0 }))].map((c) =>
        h('button', { class: 'chip', type: 'button', 'aria-pressed': sr.dev === c.id ? 'true' : 'false', onclick: () => { sr.dev = c.id; renderResults(); } }, c.name, sr.data ? h('span', { class: 'mono' }, String(c.n)) : null),
      ),
    );
    tabs.replaceChildren(
      ...TYPE_TABS.map(([k, label]) => h('button', { type: 'button', 'aria-pressed': sr.kind === k ? 'true' : 'false', onclick: () => { sr.kind = k; renderMeta(); runSearch(); } }, label)),
    );
  }

  function renderResults() {
    renderMeta();
    if (sr.error) return results.replaceChildren(h('div', { class: 'empty' }, h('b', null, 'Search failed'), h('span', null, sr.error)));
    if (!sr.data) return results.replaceChildren();
    const groups = filtered().filter((g) => (sr.dev === 'all' || g.dev.id === sr.dev) && (g.items.length || g.error));
    if (!groups.length) return results.replaceChildren(h('div', { class: 'empty' }, h('b', null, 'Nothing matches on any device'), h('span', null, 'Try part of the name, or another type filter.')));
    results.replaceChildren(
      ...groups.map(({ dev: d, items, error }) =>
        h(
          'section',
          { class: 'res-group' },
          h('div', { class: 'res-head' }, h('span', { class: 'tile' }, ico(DEVICE_ICON[d.kind] || 'desktop', 15)), h('div', { class: 'nm' }, h('b', null, d.name), h('span', null, deviceMeta(d))), h('span', { class: 'mono muted', style: { fontSize: '12px' } }, error ? error : `${items.length}${items.length >= 80 ? '+' : ''} ${items.length === 1 ? 'result' : 'results'}`)),
          h('div', { style: { overflowX: 'auto' } }, items.map((it) => resultRow(d, it))),
        ),
      ),
    );
  }

  function renderIndex() {
    indexPanel.replaceChildren(
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, h('h2', null, 'Why it’s instant'), h('p', null, 'Each device keeps its own index of file names and updates it as files change. A search asks all of them at once, so answers arrive as fast as the slowest link.')),
      h(
        'div',
        null,
        S.devices.map((d) => {
          const ix = d.index || {};
          const state = ix.state === 'ready' ? (ix.watching ? 'Live · updates as files change' : `Refreshed ${timeAgo(ix.builtAt)}`) : ix.state === 'building' ? 'Building the index…' : ix.state === 'refreshing' ? 'Refreshing…' : 'Waiting';
          return h('div', { class: 'idx-row' }, h('span', { class: 'conn-dot', style: { background: ix.state === 'ready' ? 'var(--sage)' : 'var(--text-3)' } }), h('div', { class: 't' }, h('b', null, d.name), h('span', null, state)), h('span', { class: 'mono dim', style: { fontSize: '12px' } }, (ix.count || 0).toLocaleString()));
        }),
      ),
    );
  }

  const el = h(
    'div',
    { class: 'page' },
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } }, h('label', { class: 'field big' }, ico('search', 20), input, h('span', { class: 'kbd hide-m' }, 'Esc to clear')), chips, h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } }, tabs)),
    h(
      'div',
      { class: 'cols' },
      h('div', { class: 'col-main' }, meta, results),
      h(
        'div',
        { class: 'col-side' },
        indexPanel,
        h(
          'section',
          { class: 'panel' },
          h('h2', null, 'Narrow it down'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, h('div', { class: 'tip' }, h('code', null, 'lisbon jpg'), h('span', null, 'all words must match')), h('div', { class: 'tip' }, h('code', null, 'ext:pdf'), h('span', null, 'by extension')), h('div', { class: 'tip' }, h('code', null, 'on:pixel'), h('span', null, 'one device')), h('div', { class: 'tip' }, h('code', null, 'in:finance'), h('span', null, 'inside a folder'))),
        ),
      ),
    ),
  );

  renderIndex();
  renderResults();
  if (sr.q && sr.dataKey !== `${sr.q}|${sr.kind}`) runSearch();
  return {
    el,
    title: 'Search',
    mounted() {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
    onState() {
      renderIndex();
      renderMeta();
    },
  };
}

// ───────────────────────── view: transfers ─────────────────────────

function viewTransfers() {
  const activeBox = h('div');
  const doneBox = h('div');
  const statsEl = h('div', { class: 'stats' });
  const routesPanel = h('section', { class: 'panel' });
  const activeRows = new Map();

  function cancel(t) {
    const up = S.uploads.get(t.id);
    if (up) {
      up.canceled = true;
      for (const x of up.xhrs) x.abort();
    }
    api('/api/cancel', { method: 'POST', body: { id: t.id } }).catch((e) => toast(e.message, 'err'));
  }

  function describe(t) {
    const mine = t.clientId === clientId;
    if (t.dir === 'down') {
      const base = mine ? `Downloading from ${t.devName}` : `${t.clientName} is downloading from ${t.devName}`;
      return t.kind === 'zip' ? `${base} · zipped while it streams${t.files ? ` · ${t.filesDone}/${t.files} files` : ''}` : base;
    }
    const base = mine ? `Sending to ${t.devName}` : `${t.clientName} is sending to ${t.devName}`;
    return `${base} › ${displayPath(t.path)}${t.files ? ` · ${t.filesDone} of ${t.files} files` : ''}`;
  }

  function activeRow(t) {
    const bar = h('i');
    const name = h('span', { class: 'ellipsis' });
    const routeTag = h('span', { class: 'tag square' });
    const sub = h('span', { class: 's ellipsis' });
    const speed = h('b');
    const eta = h('span');
    const left = h('span');
    const pct = h('span', { class: 'dim' });
    const el = h(
      'div',
      { class: 'trow' },
      h(
        'div',
        { class: 'line' },
        h('span', { class: `tile ${t.dir === 'up' ? 'solid' : 'clay'}`, style: { width: '38px', height: '38px', borderRadius: '10px' } }, ico(t.dir === 'up' ? 'arrowUp' : 'arrowDown', 17, 2)),
        h('div', { class: 't' }, h('div', { class: 'n' }, name, routeTag), sub),
        h('div', { class: 'rate' }, speed, eta),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Cancel ${t.name}`, title: 'Cancel', onclick: () => cancel(t) }, ico('x', 15)),
      ),
      h('div', { class: 'prog' }, h('div', { class: 'bar' }, bar), h('div', { class: 'l' }, left, pct)),
    );
    const update = (t) => {
      const p = t.total ? Math.min(100, (t.bytes / t.total) * 100) : 0;
      bar.style.width = `${p}%`;
      name.textContent = t.name;
      routeTag.textContent = routeLabel(t.route);
      routeTag.className = `tag square ${t.route === 'tailscale' ? 'sky' : ''}`;
      sub.textContent = describe(t);
      speed.textContent = `${fmtBytes(t.speed || 0)}/s`;
      eta.textContent = t.speed > 0 && t.total ? fmtEta((t.total - t.bytes) / t.speed) : 'starting…';
      left.textContent = t.total ? `${fmtBytes(t.bytes)} of ${fmtBytes(t.total)}` : fmtBytes(t.bytes);
      pct.textContent = t.total ? `${Math.floor(p)}%` : '';
    };
    update(t);
    return { el, update };
  }

  function doneRow(t) {
    const icons = { done: ['check', 'st-done'], failed: ['alert', 'st-failed'], canceled: ['x', 'st-canceled'] };
    const [ic, cls] = icons[t.state] || icons.done;
    const mine = t.clientId === clientId;
    const where = t.dir === 'down' ? `from ${t.devName}` : `to ${t.devName} › ${displayPath(t.path)}`;
    const what = t.state === 'done' ? `${mine ? (t.dir === 'down' ? 'Downloaded' : 'Sent') : `${t.clientName} ${t.dir === 'down' ? 'downloaded' : 'sent'}`} ${where}` : `${t.dir === 'down' ? 'Download' : 'Send'} ${where}`;
    const folder = t.dir === 'up' ? t.path : t.kind === 'zip' ? t.path : parentOf(t.path);
    return h(
      'div',
      { class: 'drow' },
      h('span', { class: cls, style: { display: 'flex' } }, ico(ic, 16, 2)),
      h('div', { class: 't' }, h('b', { class: 'ellipsis' }, t.name), h('span', { class: 'ellipsis' }, t.state === 'failed' ? `Failed — ${t.error || 'connection lost'}` : t.state === 'canceled' ? `Canceled · ${what}` : what)),
      h('span', { class: 'mono dim', style: { fontSize: '12.5px' } }, fmtBytes(t.state === 'done' ? t.total ?? t.bytes : t.bytes)),
      h('span', { class: 'muted c-when', style: { fontSize: '12.5px' } }, new Date(t.endedAt || t.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
      deviceById(t.devId) && folder ? h('a', { class: 'icon-btn', href: browseHash(t.devId, folder), 'aria-label': `Open the folder of ${t.name}`, title: 'Open folder' }, ico('folderOpen', 15)) : h('span'),
    );
  }

  let doneSig = '';
  function update() {
    const active = activeTransfers().sort((a, b) => (b.clientId === clientId) - (a.clientId === clientId) || a.startedAt - b.startedAt);
    const seen = new Set();
    for (const t of active) {
      seen.add(t.id);
      let r = activeRows.get(t.id);
      if (!r) {
        r = activeRow(t);
        activeRows.set(t.id, r);
      } else r.update(t);
    }
    for (const [id, r] of activeRows) if (!seen.has(id)) {
      r.el.remove();
      activeRows.delete(id);
    }
    if (active.length) {
      const order = active.map((t) => activeRows.get(t.id).el);
      if (order.some((n, i) => activeBox.children[i] !== n) || activeBox.children.length !== order.length) activeBox.replaceChildren(...order);
    } else activeBox.replaceChildren(h('div', { class: 'trow' }, h('span', { class: 'muted', style: { fontSize: '13px' } }, 'Nothing is moving right now. Downloads and sends from every device in the session show up here.')));

    const done = S.transfers.filter((t) => t.state !== 'active').sort((a, b) => b.endedAt - a.endedAt);
    const sig = done.map((t) => t.id + t.state).join(',');
    if (sig !== doneSig) {
      doneSig = sig;
      doneBox.replaceChildren(...(done.length ? done.map(doneRow) : [h('div', { class: 'trow' }, h('span', { class: 'muted', style: { fontSize: '13px' } }, 'Finished transfers from the last few hours appear here.'))]));
    }

    const moving = active.reduce((n, t) => n + (t.speed || 0), 0);
    const today = new Date().setHours(0, 0, 0, 0);
    const moved = S.transfers.filter((t) => t.startedAt >= today).reduce((n, t) => n + (t.bytes || 0), 0);
    statsEl.replaceChildren(h('div', { class: 'stat' }, h('span', null, 'Moving now'), h('b', { class: 'clay' }, moving ? `${fmtBytes(moving)}/s` : 'Idle')), h('div', { class: 'stat' }, h('span', null, 'Active'), h('b', null, String(active.length))), h('div', { class: 'stat' }, h('span', null, 'Moved today'), h('b', null, fmtBytes(moved))));
  }

  function renderRoutes() {
    routesPanel.replaceChildren(
      h('h2', null, 'Routes'),
      h(
        'div',
        null,
        S.devices.map((d) => {
          const r = d.role === 'host' ? S.you?.route : d.route;
          return h('div', { class: 'route-row' }, h('span', { style: { display: 'flex', color: r === 'tailscale' ? 'var(--sky)' : 'var(--text-2)' } }, ico(r === 'tailscale' ? 'globe' : r === 'local' ? 'desktop' : 'wifi', 15)), h('div', { class: 't' }, h('b', null, d.name), h('span', null, d.role === 'host' ? `Host · ${routeLabel(r)} from this browser` : `${routeLabel(r)} · relayed by the host`)), h('span', { class: 'mono dim', style: { fontSize: '12px' } }, d.role === 'host' ? '' : d.ip));
        }),
      ),
      h('p', null, 'Downloads land in this browser’s download folder. Files you send are written straight into the folder you chose, and never overwrite anything already there.'),
    );
  }

  const el = h(
    'div',
    { class: 'page' },
    h('div', { class: 'page-head' }, h('div', { class: 't' }, h('h1', { class: 'title' }, 'Transfers'), h('p', { class: 'lede', style: { fontSize: '14px' } }, 'Everything moving between devices in this session. A single file picks up where it stopped if the connection drops.')), statsEl),
    h(
      'div',
      { class: 'cols' },
      h('div', { class: 'col-main', style: { gap: '16px' } }, h('section', { class: 'card', style: { overflow: 'hidden' } }, h('div', { class: 'section-head' }, h('h2', null, 'In progress')), activeBox), h('section', { class: 'card', style: { overflow: 'hidden' } }, h('div', { class: 'section-head' }, h('h2', null, 'Finished')), h('div', { style: { overflowX: 'auto' } }, doneBox))),
      h('div', { class: 'col-side' }, routesPanel, h('section', { class: 'panel' }, h('h2', null, 'This browser'), h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { style: { fontSize: '13.5px', fontWeight: 500 } }, myName()), h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Shown to others next to your transfers')), h('button', { class: 'btn sm', type: 'button', onclick: renameBrowser }, 'Rename')))),
    ),
  );
  update();
  renderRoutes();
  return { el, title: 'Transfers', onTransfers: update, onState: () => (update(), renderRoutes()) };
}

// ───────────────────────── global keys & boot ─────────────────────────

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (parseRoute().view !== 'search') location.hash = '#/search';
    else $('.field.big input')?.focus();
  }
});

// Never let a stray drop navigate the tab away to the file.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (parseRoute().view !== 'browse' || !S.ex.path) toast('Open a folder first, then drop files onto it to send them there.');
});

window.addEventListener('resize', debounce(() => view?.onResize?.(), 150));

render();
connect();
