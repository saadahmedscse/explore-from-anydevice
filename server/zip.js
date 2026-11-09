/**
 * Streaming ZIP writer (store / no compression) with full ZIP64 support.
 *
 * Every entry's size is known before streaming starts, so the total archive length
 * is computed up front and sent as Content-Length — the browser shows real progress
 * and an ETA even for a 100 GB folder. CRC-32 is computed on the fly and written in a
 * data descriptor after each entry, so nothing is ever buffered or read twice.
 */
import zlib from 'node:zlib';

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const FLAGS = 0x0808; // bit 3: sizes/CRC in data descriptor · bit 11: UTF-8 names

const crc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : jsCrc32;

let table;
function jsCrc32(buf, prev = 0) {
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
  }
  let c = (prev ^ MAX32) >>> 0;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ MAX32) >>> 0;
}

function dosDateTime(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  let year = d.getFullYear();
  if (year < 1980) return { time: 0, date: (0 << 9) | (1 << 5) | 1 };
  if (year > 2107) year = 2107;
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Lay out the archive without writing it.
 * @param {{name: string, size: number, mtime?: number}[]} entries
 */
export function planZip(entries) {
  let offset = 0;
  const recs = entries.map((e) => {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const zip64 = e.size >= MAX32;
    const { time, date } = dosDateTime(e.mtime);
    const rec = { name: e.name, size: e.size, nameBuf, zip64, offset, time, date, crc: 0, localExtraLen: zip64 ? 20 : 0 };
    offset += 30 + nameBuf.length + rec.localExtraLen + e.size + (zip64 ? 24 : 16);
    return rec;
  });
  const cdOffset = offset;
  let cdSize = 0;
  for (const r of recs) {
    r.offset64 = r.offset >= MAX32;
    const extra = (r.zip64 ? 16 : 0) + (r.offset64 ? 8 : 0);
    r.cdExtraLen = extra ? extra + 4 : 0;
    cdSize += 46 + r.nameBuf.length + r.cdExtraLen;
  }
  const zip64End =
    recs.length >= MAX16 || cdOffset >= MAX32 || cdSize >= MAX32 || recs.some((r) => r.zip64 || r.offset64);
  const total = cdOffset + cdSize + (zip64End ? 56 + 20 : 0) + 22;
  return { recs, cdOffset, cdSize, zip64End, total };
}

function localHeader(r) {
  const b = Buffer.alloc(30 + r.nameBuf.length + r.localExtraLen);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(r.zip64 ? 45 : 20, 4);
  b.writeUInt16LE(FLAGS, 6);
  b.writeUInt16LE(0, 8); // method: store
  b.writeUInt16LE(r.time, 10);
  b.writeUInt16LE(r.date, 12);
  b.writeUInt32LE(0, 14); // crc → data descriptor
  b.writeUInt32LE(r.zip64 ? MAX32 : 0, 18);
  b.writeUInt32LE(r.zip64 ? MAX32 : 0, 22);
  b.writeUInt16LE(r.nameBuf.length, 26);
  b.writeUInt16LE(r.localExtraLen, 28);
  r.nameBuf.copy(b, 30);
  if (r.zip64) {
    const o = 30 + r.nameBuf.length;
    b.writeUInt16LE(0x0001, o); // ZIP64 extended information; sizes follow in the descriptor
    b.writeUInt16LE(16, o + 2);
  }
  return b;
}

function dataDescriptor(r) {
  if (r.zip64) {
    const b = Buffer.alloc(24);
    b.writeUInt32LE(0x08074b50, 0);
    b.writeUInt32LE(r.crc, 4);
    b.writeBigUInt64LE(BigInt(r.size), 8);
    b.writeBigUInt64LE(BigInt(r.size), 16);
    return b;
  }
  const b = Buffer.alloc(16);
  b.writeUInt32LE(0x08074b50, 0);
  b.writeUInt32LE(r.crc, 4);
  b.writeUInt32LE(r.size, 8);
  b.writeUInt32LE(r.size, 12);
  return b;
}

function centralHeader(r) {
  const b = Buffer.alloc(46 + r.nameBuf.length + r.cdExtraLen);
  const version = r.zip64 || r.offset64 ? 45 : 20;
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(version, 4); // made by: MS-DOS host, spec version
  b.writeUInt16LE(version, 6); // needed to extract
  b.writeUInt16LE(FLAGS, 8);
  b.writeUInt16LE(0, 10);
  b.writeUInt16LE(r.time, 12);
  b.writeUInt16LE(r.date, 14);
  b.writeUInt32LE(r.crc, 16);
  b.writeUInt32LE(r.zip64 ? MAX32 : r.size, 20);
  b.writeUInt32LE(r.zip64 ? MAX32 : r.size, 24);
  b.writeUInt16LE(r.nameBuf.length, 28);
  b.writeUInt16LE(r.cdExtraLen, 30);
  b.writeUInt16LE(0, 32); // comment length
  b.writeUInt16LE(0, 34); // disk number start
  b.writeUInt16LE(0, 36); // internal attributes
  b.writeUInt32LE(0, 38); // external attributes
  b.writeUInt32LE(r.offset64 ? MAX32 : r.offset, 42);
  r.nameBuf.copy(b, 46);
  if (r.cdExtraLen) {
    let o = 46 + r.nameBuf.length;
    b.writeUInt16LE(0x0001, o);
    b.writeUInt16LE(r.cdExtraLen - 4, o + 2);
    o += 4;
    if (r.zip64) {
      b.writeBigUInt64LE(BigInt(r.size), o);
      b.writeBigUInt64LE(BigInt(r.size), o + 8);
      o += 16;
    }
    if (r.offset64) b.writeBigUInt64LE(BigInt(r.offset), o);
  }
  return b;
}

function endRecords(plan) {
  const n = plan.recs.length;
  const parts = [];
  if (plan.zip64End) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(45, 12);
    z.writeUInt16LE(45, 14);
    z.writeUInt32LE(0, 16);
    z.writeUInt32LE(0, 20);
    z.writeBigUInt64LE(BigInt(n), 24);
    z.writeBigUInt64LE(BigInt(n), 32);
    z.writeBigUInt64LE(BigInt(plan.cdSize), 40);
    z.writeBigUInt64LE(BigInt(plan.cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(plan.cdOffset + plan.cdSize), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(z, loc);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(Math.min(n, MAX16), 8);
  e.writeUInt16LE(Math.min(n, MAX16), 10);
  e.writeUInt32LE(Math.min(plan.cdSize, MAX32), 12);
  e.writeUInt32LE(Math.min(plan.cdOffset, MAX32), 16);
  parts.push(e);
  return Buffer.concat(parts);
}

function waitDrain(out) {
  return new Promise((resolve, reject) => {
    const done = (err) => {
      out.off('drain', onDrain);
      out.off('close', onClose);
      out.off('error', onClose);
      err ? reject(err) : resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(new Error('Receiver closed the connection.'));
    out.on('drain', onDrain);
    out.on('close', onClose);
    out.on('error', onClose);
  });
}

/**
 * Stream the archive described by `plan` into `out`, respecting backpressure.
 * @param {import('node:stream').Writable} out
 * @param {(rec: object, index: number) => Promise<AsyncIterable<Buffer>>} open  source for entry i
 * @param {(bytes: number) => void} [onBytes]
 */
export async function writeZip(out, plan, open, onBytes) {
  const put = async (buf) => {
    if (out.destroyed || out.writableEnded) throw new Error('Receiver closed the connection.');
    onBytes?.(buf.length);
    if (!out.write(buf)) await waitDrain(out);
  };

  for (let i = 0; i < plan.recs.length; i++) {
    const rec = plan.recs[i];
    await put(localHeader(rec));
    const src = await open(rec, i);
    let crc = 0;
    let n = 0;
    for await (const chunk of src) {
      n += chunk.length;
      if (n > rec.size) throw new Error(`“${rec.name}” grew while it was being sent.`);
      crc = crc32(chunk, crc);
      await put(chunk);
    }
    if (n !== rec.size) throw new Error(`“${rec.name}” changed size while it was being sent.`);
    rec.crc = crc >>> 0;
    await put(dataDescriptor(rec));
  }

  // Central directory, flushed in batches so huge folders don't build one giant buffer.
  let batch = [];
  let batchLen = 0;
  for (const rec of plan.recs) {
    const h = centralHeader(rec);
    batch.push(h);
    batchLen += h.length;
    if (batchLen > 256 * 1024) {
      await put(Buffer.concat(batch));
      batch = [];
      batchLen = 0;
    }
  }
  if (batch.length) await put(Buffer.concat(batch));
  await put(endRecords(plan));
}
