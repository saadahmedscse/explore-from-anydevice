/**
 * This machine's whole file system, as the session sees it: every drive on Windows,
 * internal storage + SD card on Android, home + mounted volumes on macOS/Linux
 * (or only the folders given with --only). Addressed by virtual paths like
 * "C:/Work/Client Handoff" or "Internal storage/DCIM".
 * Every path is confined to its root — ".." and drive-relative tricks are refused.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, cleanName, cleanRelPath, safeFileName, mapLimit, rid } from './util.js';

const CHUNK = 1 << 20;
export const MAX_LIST = 50_000;
export const MAX_WALK_FILES = 250_000;

/** Clutter Windows keeps at the top of a drive. */
const HIDDEN_AT_ROOT = new Set([
  '$recycle.bin', 'system volume information', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys',
  'dumpstack.log', 'dumpstack.log.tmp', 'config.msi', 'recovery', '$windows.~bt', '$windows.~ws',
  '$winreagent', '$sysreset', 'documents and settings', '$getcurrent', '$av_asw',
]);
const HIDDEN_ANYWHERE = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);
export const PART_FILE = /^\.~es-[\w-]+\.part$/;

export function isHiddenName(name, atRoot) {
  const lower = name.toLowerCase();
  if (PART_FILE.test(name) || HIDDEN_ANYWHERE.has(lower)) return true;
  return atRoot && HIDDEN_AT_ROOT.has(lower);
}

function execFileText(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function probe(p, ms = 2500) {
  return Promise.race([
    fsp.readdir(p).then(() => true, () => false),
    new Promise((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

/** Fixed, removable and network drives that can actually be read right now. */
async function windowsDrives() {
  let info = [];
  try {
    const out = await execFileText(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,DriveType | ConvertTo-Json -Compress'],
      10_000,
    );
    const parsed = JSON.parse(out);
    info = (Array.isArray(parsed) ? parsed : [parsed]).filter((d) => d && /^[A-Z]:$/i.test(d.DeviceID));
  } catch {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') info.push({ DeviceID: `${letter}:`, VolumeName: '', DriveType: 3 });
  }
  const checked = await Promise.all(info.map(async (d) => ((await probe(`${d.DeviceID}\\`)) ? d : null)));
  return checked.filter(Boolean).map((d) => ({
    id: d.DeviceID.toUpperCase(),
    label: d.VolumeName || (d.DriveType === 2 ? 'Removable' : d.DriveType === 4 ? 'Network' : d.DriveType === 5 ? 'Disc' : 'Local Disk'),
    abs: `${d.DeviceID.toUpperCase()}\\`,
    kind: d.DriveType === 2 ? 'removable' : d.DriveType === 4 ? 'network' : 'drive',
  }));
}

function isTermux() {
  return (process.env.PREFIX || '').includes('com.termux');
}

function defaultLabelFor(abs) {
  const norm = abs.replace(/[\\/]+$/, '');
  if (/^[A-Z]:$/i.test(norm)) return norm.toUpperCase();
  if (/storage[\\/](shared|emulated[\\/]0)$/.test(norm) || norm === '/sdcard') return 'Internal storage';
  return path.basename(norm) || norm || 'Files';
}

export class LocalFs {
  /** @param {{shares?: string[]}} opts  explicit folders (--only); empty means the whole file system */
  constructor({ shares = [] } = {}) {
    this.requested = shares;
    this.rootList = [];
    this.byId = new Map();
  }

  async init() {
    let roots = [];
    if (this.requested.length) {
      for (const raw of this.requested) {
        const abs = path.resolve(raw);
        const st = await fsp.stat(abs).catch(() => null);
        if (!st?.isDirectory()) throw new Error(`Can't share "${raw}": not a folder.`);
        const drive = process.platform === 'win32' && path.parse(abs).root === abs;
        roots.push({ label: drive ? 'Local Disk' : defaultLabelFor(abs), idHint: defaultLabelFor(abs), abs, kind: drive ? 'drive' : 'folder' });
      }
    } else if (process.platform === 'win32') {
      roots = (await windowsDrives()).map((d) => ({ ...d, idHint: d.id }));
    } else if (isTermux()) {
      // Everything the phone's Files app shows: internal storage plus any SD card.
      const shared = path.join(os.homedir(), 'storage', 'shared');
      const abs = fs.existsSync(shared) ? shared : '/sdcard';
      roots.push({ label: 'Internal storage', idHint: 'Internal storage', abs, kind: 'drive' });
      const cards = await fsp.readdir('/storage').catch(() => []);
      for (const name of cards.filter((n) => /^[0-9A-F]{4}-[0-9A-F]{4}$/i.test(n))) {
        if (await probe(`/storage/${name}`)) roots.push({ label: 'SD card', idHint: cards.length > 1 ? `SD card ${name}` : 'SD card', abs: `/storage/${name}`, kind: 'removable' });
      }
    } else {
      roots.push({ label: 'Home', idHint: path.basename(os.homedir()) || 'Home', abs: os.homedir(), kind: 'folder' });
      // External and extra drives: /Volumes on macOS, /media and /mnt on Linux.
      const mountDirs = process.platform === 'darwin' ? ['/Volumes'] : [path.join('/media', os.userInfo().username), '/mnt'];
      for (const dir of mountDirs) {
        for (const name of await fsp.readdir(dir).catch(() => [])) {
          const abs = path.join(dir, name);
          if (name === 'Macintosh HD' || !(await probe(abs, 1500))) continue;
          roots.push({ label: name, idHint: name, abs, kind: 'removable' });
        }
      }
    }

    const used = new Set();
    this.rootList = roots.map((r) => {
      let id = cleanName(r.idHint, 'Files').replace(/[\\/]/g, '_');
      const base = id;
      for (let n = 2; used.has(id.toLowerCase()); n++) id = `${base} (${n})`;
      used.add(id.toLowerCase());
      return { id, label: r.label && r.label !== id ? r.label : '', abs: r.abs, kind: r.kind };
    });
    this.byId = new Map(this.rootList.map((r) => [r.id, r]));
    return this;
  }

  /** Roots with live capacity. */
  async roots() {
    return Promise.all(
      this.rootList.map(async (r) => {
        let total = null;
        let free = null;
        try {
          const s = await fsp.statfs(r.abs);
          total = s.blocks * s.bsize;
          free = s.bavail * s.bsize;
        } catch {}
        return { id: r.id, label: r.label, kind: r.kind, total, free };
      }),
    );
  }

  resolve(vpath) {
    const segs = String(vpath ?? '').split('/').filter(Boolean);
    if (!segs.length) throw new HttpError(400, 'Choose a drive or folder first.');
    const root = this.byId.get(segs[0]);
    if (!root) throw new HttpError(404, `There's no “${segs[0]}” on this device.`);
    const rest = segs.slice(1);
    for (const s of rest) {
      if (s === '.' || s === '..' || s.includes('\\') || s.includes('\0') || (process.platform === 'win32' && s.includes(':'))) {
        throw new HttpError(400, 'That path is not allowed.');
      }
    }
    const abs = rest.length ? path.join(root.abs, ...rest) : root.abs;
    const rel = path.relative(root.abs, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(400, 'That path is not allowed.');
    return { root, abs, rest, vpath: [root.id, ...rest].join('/') };
  }

  toVpath(root, abs) {
    const rel = path.relative(root.abs, abs).split(path.sep).filter(Boolean);
    return [root.id, ...rel].join('/');
  }

  async list(vpath) {
    const r = this.resolve(vpath);
    let dirents;
    try {
      dirents = await fsp.readdir(r.abs, { withFileTypes: true });
    } catch (e) {
      throw fsError(e, 'open this folder');
    }
    const atRoot = r.rest.length === 0;
    let visible = dirents.filter((d) => !isHiddenName(d.name, atRoot));
    const truncated = visible.length > MAX_LIST;
    if (truncated) visible = visible.slice(0, MAX_LIST);
    const countDirs = visible.filter((d) => d.isDirectory()).length <= 400;

    const entries = await mapLimit(visible, 48, async (d) => {
      const full = path.join(r.abs, d.name);
      let st = null;
      try {
        st = await fsp.stat(full);
      } catch {}
      const dir = st ? st.isDirectory() : d.isDirectory();
      if (!st && !dir && !d.isFile()) return null;
      const entry = { name: d.name, dir, size: dir ? null : st ? st.size : null, mtime: st ? Math.round(st.mtimeMs) : null };
      if (dir && countDirs) {
        try {
          entry.count = (await fsp.readdir(full)).filter((n) => !isHiddenName(n, false)).length;
        } catch {
          entry.count = null;
        }
      }
      return entry;
    });
    return { path: r.vpath, entries: entries.filter(Boolean), truncated };
  }

  async stat(vpath) {
    const r = this.resolve(vpath);
    let st;
    try {
      st = await fsp.stat(r.abs);
    } catch (e) {
      throw fsError(e, 'find that item');
    }
    return { path: r.vpath, name: r.rest.length ? r.rest[r.rest.length - 1] : r.root.id, dir: st.isDirectory(), size: st.isDirectory() ? null : st.size, mtime: Math.round(st.mtimeMs) };
  }

  /** Every file under a folder (or the file itself), with "/" relative paths. */
  async walk(vpath, limit = MAX_WALK_FILES) {
    const r = this.resolve(vpath);
    const st = await fsp.stat(r.abs).catch(() => null);
    if (!st) throw new HttpError(410, 'That item was moved or deleted.');
    if (st.isFile()) return { dir: false, files: [{ path: '', size: st.size, mtime: st.mtimeMs }], size: st.size };
    const files = [];
    const emptyDirs = [];
    let size = 0;
    const visit = async (dir, rel, atRoot) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      const subdirs = [];
      const candidates = [];
      for (const e of entries) {
        if (isHiddenName(e.name, atRoot)) continue;
        if (e.isDirectory()) subdirs.push(e);
        else if (e.isFile() || e.isSymbolicLink()) candidates.push(e);
      }
      if (!subdirs.length && !candidates.length && rel) emptyDirs.push(rel);
      for (let i = 0; i < candidates.length; i += 64) {
        const batch = candidates.slice(i, i + 64);
        const stats = await Promise.all(batch.map((e) => fsp.stat(path.join(dir, e.name)).catch(() => null)));
        for (let j = 0; j < batch.length; j++) {
          const s = stats[j];
          if (!s || !s.isFile()) continue;
          if (files.length >= limit) throw new HttpError(413, `That's more than ${limit.toLocaleString()} files — pick a smaller folder.`);
          files.push({ path: rel ? `${rel}/${batch[j].name}` : batch[j].name, size: s.size, mtime: s.mtimeMs });
          size += s.size;
        }
      }
      for (const d of subdirs) await visit(path.join(dir, d.name), rel ? `${rel}/${d.name}` : d.name, false);
    };
    await visit(r.abs, '', r.rest.length === 0);
    return { dir: true, files, emptyDirs, size };
  }

  /** A read stream for [start, end] (inclusive) of a file. */
  async openRead(vpath, start = 0, end = null) {
    const r = this.resolve(vpath);
    let st;
    try {
      st = await fsp.stat(r.abs);
    } catch (e) {
      throw fsError(e, 'read that file');
    }
    if (!st.isFile()) throw new HttpError(400, 'That is a folder, not a file.');
    const last = st.size === 0 ? 0 : Math.min(end ?? st.size - 1, st.size - 1);
    const stream = st.size === 0 ? fs.createReadStream(r.abs) : fs.createReadStream(r.abs, { start, end: last, highWaterMark: CHUNK });
    return { stream, size: st.size, mtime: st.mtimeMs };
  }

  /**
   * Reserve unique names for the top-level items of an incoming batch. Folders are
   * created right away so they show up as "arriving" and nobody else can take the name.
   * @param {{name: string, dir: boolean}[]} tops
   */
  async reserve(dirVpath, tops) {
    const r = this.resolve(dirVpath);
    await assertDir(r.abs);
    const taken = new Set();
    const names = [];
    for (const t of tops.slice(0, 10_000)) {
      const name = await uniqueName(r.abs, safeFileName(t.name), !t.dir, taken);
      taken.add(name.toLowerCase());
      if (t.dir) {
        try {
          await fsp.mkdir(path.join(r.abs, name));
        } catch (e) {
          throw fsError(e, 'create a folder here');
        }
      }
      names.push(name);
    }
    return names;
  }

  /**
   * Write an incoming file into a folder. `rel` may contain sub-folders ("Trip/Day 1/a.jpg").
   * Data goes to a hidden .part file first and is renamed when complete, so a cut-off
   * transfer never leaves a broken file behind. Existing files are never overwritten.
   */
  async receive(dirVpath, rel, size, mtime, src, onBytes) {
    const r = this.resolve(dirVpath);
    await assertDir(r.abs);
    const parts = cleanRelPath(rel).split('/').filter(Boolean).map((p) => safeFileName(p));
    if (!parts.length) throw new HttpError(400, 'Missing file name.');
    const fileName = parts.pop();
    const dir = parts.length ? path.join(r.abs, ...parts) : r.abs;
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (e) {
      throw fsError(e, 'create a folder here');
    }
    const tmp = path.join(dir, `.~es-${rid(6)}.part`);
    let n = 0;
    const count = new Transform({
      transform(chunk, _enc, cb) {
        n += chunk.length;
        if (size != null && n > size) return cb(new HttpError(400, 'Received more data than announced.'));
        onBytes?.(chunk.length);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(src, count, fs.createWriteStream(tmp, { flags: 'wx', highWaterMark: CHUNK }));
      if (size != null && n !== size) throw new HttpError(400, 'The transfer ended early.');
      const finalName = await uniqueName(dir, fileName, true);
      const finalPath = path.join(dir, finalName);
      await fsp.rename(tmp, finalPath);
      if (mtime) await fsp.utimes(finalPath, new Date(), new Date(mtime)).catch(() => {});
      return { name: finalName, path: this.toVpath(r.root, finalPath), size: n };
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      if (e instanceof HttpError) throw e;
      if (e.code) throw fsError(e, 'save that file here');
      throw e;
    }
  }

  async mkdir(dirVpath, name) {
    const r = this.resolve(dirVpath);
    await assertDir(r.abs);
    const clean = safeFileName(name, '');
    if (!clean) throw new HttpError(400, 'Give the folder a name.');
    try {
      await fsp.mkdir(path.join(r.abs, clean));
    } catch (e) {
      if (e.code === 'EEXIST') throw new HttpError(409, `“${clean}” already exists here.`);
      throw fsError(e, 'create a folder here');
    }
    return { name: clean, path: `${r.vpath}/${clean}` };
  }
}

async function assertDir(abs) {
  const st = await fsp.stat(abs).catch(() => null);
  if (!st?.isDirectory()) throw new HttpError(404, 'That folder no longer exists.');
}

async function exists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** "Report.pdf" → "Report (2).pdf" until the name is free. */
async function uniqueName(dir, name, isFile, taken = new Set()) {
  const ext = isFile ? path.extname(name) : '';
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()) || (await exists(path.join(dir, candidate))); n++) {
    candidate = `${stem} (${n})${ext}`;
  }
  return candidate;
}

export function fsError(e, action) {
  if (e instanceof HttpError) return e;
  switch (e.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new HttpError(404, `Couldn't ${action}: it was moved or deleted.`);
    case 'EACCES':
    case 'EPERM':
      return new HttpError(403, `Couldn't ${action}: permission denied.`);
    case 'EBUSY':
      return new HttpError(423, `Couldn't ${action}: it's in use by another program.`);
    case 'ENOSPC':
      return new HttpError(507, `Couldn't ${action}: the drive is full.`);
    case 'EEXIST':
      return new HttpError(409, `Couldn't ${action}: something with that name already exists.`);
    default:
      return new HttpError(500, `Couldn't ${action} (${e.code || e.message}).`);
  }
}
