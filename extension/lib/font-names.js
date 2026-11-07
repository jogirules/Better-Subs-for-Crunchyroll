/**
 * lib/font-names.js — face names, weight and slant of a TrueType/OpenType file (fork).
 *
 * Fansub groups ship the fonts of each series next to the .ass ("Czcionki/",
 * "Fonty/").  An .ass names a font by family or full name ("Gandhi Sans",
 * "Gandhi Sans Bold"), while the file is called anything ("GandhiSans-Bold.otf"),
 * so the only reliable match is the font's own `name` table — the same names
 * libass matches on.
 *
 *   parseFontFaces(bytes) → [{ names: string[] (lower case), weight, italic }]
 *     One entry per face (a .ttc holds several).  names: family (1), full (4),
 *     PostScript (6) and typographic family (16).  [] when not a font.
 *   normFontName(s) → the lower-case key both sides are compared on.
 *
 * Pure: no fetch, no DOM.  Loaded in the service worker and tools/test-animesub.mjs.
 */
(function () {
  'use strict';

  const NS = (typeof self !== 'undefined' ? self : globalThis);
  NS.CRSubFix = NS.CRSubFix || {};

  // "@Font" is the vertical-writing variant of "Font" (same file).
  const normFontName = (s) => String(s || '').replace(/^@/, '').replace(/\s+/g, ' ').trim().toLowerCase();

  function utf16be(dv, off, len) {
    let s = '';
    for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode(dv.getUint16(off + i));
    return s;
  }
  function latin1(dv, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
    return s;
  }

  function parseFace(dv, base) {
    const numTables = dv.getUint16(base + 4);
    const tables = {};
    for (let i = 0; i < numTables; i++) {
      const r = base + 12 + i * 16;
      const tag = latin1(dv, r, 4);
      tables[tag] = { off: dv.getUint32(r + 8), len: dv.getUint32(r + 12) };
    }
    const names = new Set();
    const nt = tables.name;
    if (nt && nt.off + 6 <= dv.byteLength) {
      const count = dv.getUint16(nt.off + 2);
      const strOff = nt.off + dv.getUint16(nt.off + 4);
      for (let i = 0; i < count; i++) {
        const r = nt.off + 6 + i * 12;
        if (r + 12 > dv.byteLength) break;
        const platform = dv.getUint16(r), enc = dv.getUint16(r + 2), id = dv.getUint16(r + 6);
        const len = dv.getUint16(r + 8), off = strOff + dv.getUint16(r + 10);
        if (![1, 4, 6, 16].includes(id) || off + len > dv.byteLength) continue;
        let s = null;
        if (platform === 3 || platform === 0) s = utf16be(dv, off, len);
        else if (platform === 1 && enc === 0) s = latin1(dv, off, len);
        const n = normFontName(s);
        if (n) names.add(n);
      }
    }
    let weight = 400, italic = false;
    const os2 = tables['OS/2'];
    if (os2 && os2.off + 64 <= dv.byteLength) {
      weight = dv.getUint16(os2.off + 4) || 400;
      italic = !!(dv.getUint16(os2.off + 62) & 1);
    }
    return { names: [...names], weight: Math.min(900, Math.max(100, weight)), italic };
  }

  function parseFontFaces(bytes) {
    try {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      if (dv.byteLength < 12) return [];
      const tag = dv.getUint32(0);
      if (tag === 0x74746366) {                      // 'ttcf'
        const n = Math.min(dv.getUint32(8), 64);
        const out = [];
        for (let i = 0; i < n; i++) out.push(parseFace(dv, dv.getUint32(12 + i * 4)));
        return out.filter((f) => f.names.length);
      }
      if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return [];   // TTF, 'OTTO', 'true'
      const f = parseFace(dv, 0);
      return f.names.length ? [f] : [];
    } catch (_) {
      return [];
    }
  }

  NS.CRSubFix.fontNames = { parseFontFaces, normFontName };
})();
