/**
 * lib/zip-read.js — minimal read-only ZIP extractor for AnimeSub archives.
 *
 * AnimeSub.info repacks every upload into a ZIP, and the compression method
 * varies by upload age: 0 (stored), 8 (deflate) for older files, 14 (LZMA) for
 * newer ones.  Off-the-shelf small unzippers (fflate & co.) stop at deflate, so
 * this reads the central directory itself and dispatches per entry:
 *   0  → bytes as-is
 *   8  → native DecompressionStream('deflate-raw')  (Chrome ≥ 80, Node ≥ 18)
 *   14 → vendored LZMA-JS (lib/vendor/lzma-d.js → self.CRSubFixLZMA)
 *
 * Pure — no DOM, no fetch.  Works in the MV3 service worker and in Node tests.
 *
 * Public surface:
 *   CRSubFix.zipRead.listEntries(u8)        → Entry[]  (throws on non-ZIP)
 *   CRSubFix.zipRead.extract(u8, entry)     → Promise<Uint8Array>
 *   CRSubFix.zipRead.MAX_ENTRY_BYTES        — refuse larger entries (zip-bomb guard)
 * Entry = { name, method, flags, compSize, size, localOffset }
 */
(function () {
  'use strict';

  const NS = (typeof self !== 'undefined' ? self : globalThis);
  NS.CRSubFix = NS.CRSubFix || {};

  // Subtitle files are tens to hundreds of kB; 20 MB leaves room for .ass files
  // with embedded fonts while refusing a decompression bomb.
  const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
  const MAX_ENTRIES     = 200;

  const SIG_EOCD    = 0x06054b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_LOCAL   = 0x04034b50;

  function view(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }

  // File names: UTF-8 when flag bit 11 is set; otherwise legacy.  Polish
  // uploaders' archives were usually made on Windows, so fall back to CP1250.
  function decodeName(bytes, flags) {
    if (flags & 0x800) return new TextDecoder('utf-8').decode(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (_) { return new TextDecoder('windows-1250').decode(bytes); }
  }

  function findEocd(dv) {
    // EOCD is 22 bytes + an optional comment of up to 65535 bytes.
    const min = Math.max(0, dv.byteLength - 22 - 0xffff);
    for (let i = dv.byteLength - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === SIG_EOCD) return i;
    }
    return -1;
  }

  function listEntries(u8) {
    const dv = view(u8);
    const eocd = findEocd(dv);
    if (eocd < 0) throw new Error('not a ZIP archive');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    if (count > MAX_ENTRIES) throw new Error('too many ZIP entries');
    const out = [];
    for (let k = 0; k < count; k++) {
      if (p + 46 > dv.byteLength || dv.getUint32(p, true) !== SIG_CENTRAL) {
        throw new Error('corrupt ZIP central directory');
      }
      const flags    = dv.getUint16(p + 8, true);
      const method   = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const size     = dv.getUint32(p + 24, true);
      const nLen     = dv.getUint16(p + 28, true);
      const xLen     = dv.getUint16(p + 30, true);
      const cLen     = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = decodeName(u8.subarray(p + 46, p + 46 + nLen), flags);
      // Skip directories ("foo/") — they carry no data.
      if (!name.endsWith('/')) out.push({ name, method, flags, compSize, size, localOffset });
      p += 46 + nLen + xLen + cLen;
    }
    return out;
  }

  function entryData(u8, e) {
    const dv = view(u8);
    const p = e.localOffset;
    if (dv.getUint32(p, true) !== SIG_LOCAL) throw new Error('corrupt ZIP local header');
    // The local header's own name/extra lengths can differ from the central
    // directory's, so read them here rather than reusing the central values.
    const start = p + 30 + dv.getUint16(p + 26, true) + dv.getUint16(p + 28, true);
    return u8.subarray(start, start + e.compSize);
  }

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ZIP's LZMA entry = [ver major, ver minor, propsSize u16 LE, props(5), raw
  // stream].  LZMA-JS wants the ".lzma alone" layout instead: props(5) +
  // uncompressed size (u64 LE) + raw stream — so synthesize that header from
  // the ZIP entry's own size.
  function unlzma(bytes, size) {
    const LZMA = NS.CRSubFixLZMA;
    if (!LZMA) throw new Error('LZMA decoder not loaded');
    const propsSize = bytes[2] | (bytes[3] << 8);
    if (propsSize !== 5) throw new Error('unexpected LZMA props size ' + propsSize);
    const props = bytes.subarray(4, 9);
    const raw   = bytes.subarray(9);
    const alone = new Uint8Array(13 + raw.length);
    alone.set(props, 0);
    let s = size;
    for (let i = 0; i < 8; i++) { alone[5 + i] = s % 256; s = Math.floor(s / 256); }
    alone.set(raw, 13);
    const out = LZMA.decompress(alone);   // sync form → signed byte array
    return Uint8Array.from(out);
  }

  async function extract(u8, e) {
    if (e.size > MAX_ENTRY_BYTES) throw new Error('ZIP entry too large');
    if (e.flags & 0x1) throw new Error('encrypted ZIP entries are not supported');
    const data = entryData(u8, e);
    let out;
    if (e.method === 0)       out = data.slice();
    else if (e.method === 8)  out = await inflateRaw(data);
    else if (e.method === 14) out = unlzma(data, e.size);
    else throw new Error('unsupported ZIP compression method ' + e.method);
    if (out.length !== e.size) throw new Error(`ZIP size mismatch (${out.length} ≠ ${e.size})`);
    return out;
  }

  NS.CRSubFix.zipRead = { listEntries, extract, MAX_ENTRY_BYTES };
})();
