/**
 * A fast file-name index for one device.
 *
 * How it stays fast:
 *  • Building only reads directories (no per-file stat), with several directories in flight.
 *  • Lower-cased names are packed into large "\n"-joined text blocks; a query is a native
 *    String#indexOf scan over those blocks, so a million names search in milliseconds.
 *  • A recursive file watcher (Windows/macOS) feeds an overlay of added and removed paths,
 *    so new files are findable within seconds; the full index is rebuilt in the background
 *    when the overlay grows or on a timer.
 *  • Sizes and dates are fetched only for the hits that are actually returned.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { kindOf } from './kinds.js';
import { isHiddenName } from './localfs.js';
import { mapLimit } from './util.js';
import { log } from './log.js';

const BLOCK = 65_536;
const MAX_ENTRIES = 4_000_000;
const PARALLEL_DIRS = 12;
const OVERLAY_LIMIT = 25_000;
const REBUILD_EVERY = 30 * 60_000; // with a watcher: refresh twice an hour if anything changed
const REBUILD_NO_WATCH = 10 * 60_000; // without one (Linux/Android): every 10 minutes

/** Folders that are huge, churn constantly and are almost never what you're looking for. */
const SKIP_ANYWHERE = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information', 'appdata', '.cache', '__pycache__', '.gradle', '.npm']);
const SKIP_AT_DRIVE_ROOT = new Set(['windows', '$windows.~bt', '$windows.~ws', '$winreagent', 'recovery', 'config.msi', 'msocache']);

function skipDir(name, depth, root) {
  const lower = name.toLowerCase();
  if (SKIP_ANYWHERE.has(lower)) return true;
  return depth === 0 && root.kind === 'drive' && SKIP_AT_DRIVE_ROOT.has(lower);
}

class Builder {
  constructor() {
    this.blocks = [];
    this.dirs = [];
    this.count = 0;
    this.reset();
  }
  reset() {
    this.names = [];
    this.lower = [];
    this.dirIdx = [];
    this.isDir = [];
  }
  addDir(vpath) {
    this.dirs.push(vpath);
    return this.dirs.length - 1;
  }
  add(name, dirIndex, isDir) {
    this.names.push(name);
    this.lower.push(name.toLowerCase());
    this.dirIdx.push(dirIndex);
    this.isDir.push(isDir ? 1 : 0);
    this.count++;
    if (this.names.length >= BLOCK) this.flush();
  }
  flush() {
    const n = this.names.length;
    if (!n) return;
    const starts = new Int32Array(n + 1);
    let pos = 0;
    for (let i = 0; i < n; i++) {
      starts[i] = pos;
      pos += this.lower[i].length + 1;
    }
    starts[n] = pos;
    this.blocks.push({
      text: this.lower.join('\n') + '\n',
      starts,
      names: this.names,
      dirIdx: Int32Array.from(this.dirIdx),
      isDir: Uint8Array.from(this.isDir),
    });
    this.reset();
  }
}

/** Index of the entry whose text range contains `offset`. */
function entryAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function rank(lowerName, q) {
  if (lowerName === q) return 0;
  if (lowerName.startsWith(q)) return 1;
  const i = lowerName.indexOf(q);
  if (i > 0 && /[\s._\-()[\]]/.test(lowerName[i - 1])) return 2;
  return 3;
}

export class NameIndex {
  constructor(localfs) {
    this.fs = localfs;
    this.blocks = [];
    this.dirs = [];
    this.count = 0;
    this.state = 'idle';
    this.builtAt = 0;
    this.buildMs = 0;
    this.added = new Map(); // vpath → {name, dir}
    this.removed = new Set(); // vpaths gone since the last build
    this.dirty = false;
    this.watchers = [];
    this.pending = new Set();
    this.building = null;
    this.watching = false;
  }

  status() {
    return { state: this.state, count: this.count + this.added.size, builtAt: this.builtAt, watching: this.watching };
  }

  start() {
    this.build();
    this.watch();
    const every = this.watching ? REBUILD_EVERY : REBUILD_NO_WATCH;
    this.timer = setInterval(() => {
      if (!this.watching || this.dirty) this.build();
    }, every);
    this.timer.unref?.();
    this.flushTimer = setInterval(() => this.applyPending(), 1500);
    this.flushTimer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.flushTimer);
    for (const w of this.watchers) w.close();
  }

  build() {
    if (this.building) return this.building;
    const t0 = Date.now();
    this.state = this.count ? 'refreshing' : 'building';
    this.building = (async () => {
      const b = new Builder();
      for (const root of this.fs.rootList) await this.walkRoot(root, b);
      b.flush();
      this.blocks = b.blocks;
      this.dirs = b.dirs;
      this.count = b.count;
      this.added.clear();
      this.removed.clear();
      this.dirty = false;
      this.builtAt = Date.now();
      this.buildMs = this.builtAt - t0;
      this.state = 'ready';
    })()
      .catch((e) => {
        log.warn('Indexing failed:', e.message);
        this.state = this.count ? 'ready' : 'error';
      })
      .finally(() => {
        this.building = null;
      });
    return this.building;
  }

  walkRoot(root, b) {
    return new Promise((resolve) => {
      const queue = [{ abs: root.abs, vpath: root.id, depth: 0 }];
      let active = 0;
      const pump = () => {
        if (!queue.length && !active) return resolve();
        while (active < PARALLEL_DIRS && queue.length) {
          const job = queue.pop();
          active++;
          fsp
            .readdir(job.abs, { withFileTypes: true })
            .then((entries) => {
              const di = b.addDir(job.vpath);
              for (const e of entries) {
                if (isHiddenName(e.name, job.depth === 0)) continue;
                const isDir = e.isDirectory();
                if (!isDir && !e.isFile() && !e.isSymbolicLink()) continue;
                if (isDir && skipDir(e.name, job.depth, root)) continue;
                if (b.count >= MAX_ENTRIES) break;
                b.add(e.name, di, isDir);
                if (isDir) queue.push({ abs: path.join(job.abs, e.name), vpath: `${job.vpath}/${e.name}`, depth: job.depth + 1 });
              }
            })
            .catch(() => {})
            .finally(() => {
              active--;
              setImmediate(pump);
            });
        }
      };
      pump();
    });
  }

  watch() {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return;
    for (const root of this.fs.rootList) {
      try {
        const w = fs.watch(root.abs, { recursive: true, persistent: false }, (_evt, filename) => {
          if (!filename) return;
          const rel = String(filename).split(/[\\/]+/).filter(Boolean);
          if (!rel.length) return;
          for (let i = 0; i < rel.length - 1; i++) if (skipDir(rel[i], i, root)) return;
          if (this.pending.size < 50_000) this.pending.add(`${root.id}/${rel.join('/')}`);
        });
        w.on('error', () => {});
        this.watchers.push(w);
        this.watching = true;
      } catch {}
    }
  }

  async applyPending() {
    if (!this.pending.size || this.applying) return;
    this.applying = true;
    const batch = [...this.pending].slice(0, 4000);
    for (const p of batch) this.pending.delete(p);
    try {
      await mapLimit(batch, 32, async (vpath) => {
        let st = null;
        try {
          st = await fsp.stat(this.fs.resolve(vpath).abs);
        } catch {}
        const name = vpath.slice(vpath.lastIndexOf('/') + 1);
        if (isHiddenName(name, false)) return;
        if (st) {
          this.added.set(vpath, { name, dir: st.isDirectory() });
          this.removed.delete(vpath);
        } else {
          this.added.delete(vpath);
          this.removed.add(vpath);
        }
      });
      this.dirty = true;
      if (this.added.size + this.removed.size > OVERLAY_LIMIT) this.build();
    } finally {
      this.applying = false;
    }
  }

  /**
   * @returns {{path: string, name: string, dir: boolean, score: number}[]}
   */
  search(query, { limit = 100, kind = 'any' } = {}) {
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const full = terms.join(' ');
    const first = terms.reduce((a, b) => (b.length > a.length ? b : a));
    const others = terms.filter((t) => t !== first);
    const cap = Math.max(limit * 8, 400);
    const hits = [];

    const consider = (lowerName, name, vpath, dir) => {
      if (others.length && !others.every((t) => lowerName.includes(t))) return;
      if (kind !== 'any' && kindOf(name, dir) !== kind) return;
      if (this.removed.size && this.removed.has(vpath)) return;
      hits.push({ path: vpath, name, dir, score: rank(lowerName, full.includes(' ') ? first : full) });
    };

    outer: for (const blk of this.blocks) {
      let from = 0;
      for (;;) {
        const at = blk.text.indexOf(first, from);
        if (at === -1) break;
        const i = entryAt(blk.starts, at);
        from = blk.starts[i + 1];
        const name = blk.names[i];
        const vpath = `${this.dirs[blk.dirIdx[i]]}/${name}`;
        if (this.added.has(vpath)) continue; // the overlay has the fresher copy
        consider(blk.text.slice(blk.starts[i], blk.starts[i + 1] - 1), name, vpath, blk.isDir[i] === 1);
        if (hits.length >= cap) break outer;
      }
    }
    for (const [vpath, e] of this.added) {
      const lower = e.name.toLowerCase();
      if (lower.includes(first)) consider(lower, e.name, vpath, e.dir);
    }

    hits.sort((a, b) => a.score - b.score || Number(b.dir) - Number(a.dir) || a.name.length - b.name.length || a.path.length - b.path.length);
    return hits.slice(0, limit);
  }
}

/** Search, then attach size and modified time to each hit (dropping ones that vanished). */
export async function searchWithStats(localfs, index, query, opts = {}) {
  const t0 = performance.now();
  const hits = index.search(query, opts);
  const withStats = await mapLimit(hits, 32, async (h) => {
    try {
      const st = await fsp.stat(localfs.resolve(h.path).abs);
      return { path: h.path, name: h.name, dir: st.isDirectory(), size: st.isDirectory() ? null : st.size, mtime: Math.round(st.mtimeMs) };
    } catch {
      return null;
    }
  });
  return { items: withStats.filter(Boolean), ms: Math.round(performance.now() - t0), index: index.status() };
}
