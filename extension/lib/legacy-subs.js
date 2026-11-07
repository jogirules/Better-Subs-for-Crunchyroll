/**
 * lib/legacy-subs.js — convert old Polish subtitle formats to SRT text.
 *
 * AnimeSub's older uploads are TMPlayer, MicroDVD or MPL2 — line-based formats
 * the Better Subs parser does not read.  Rather than teach the parser three
 * more formats (and couple them to the Cue shape), convert to SRT text and let
 * the existing parseSubtitles() / makeLocalSource() handle it unchanged.
 *
 *   TMPlayer:  "0:00:05:Tekst|druga linia"   (also "00:00:05=" and "00:00:05,1=")
 *              no end time → next line's start, capped by a reading-speed limit
 *   MicroDVD:  "{120}{180}Tekst|druga"        frames; "{1}{1}23.976" sets fps
 *   MPL2:      "[50][80]Tekst|druga"          deciseconds; "/" prefix = italic
 *
 * Pure — no DOM.
 *
 * Public surface:
 *   CRSubFix.legacySubs.detect(text)          → 'tmplayer'|'microdvd'|'mpl2'|null
 *   CRSubFix.legacySubs.toSrt(text, { fps })  → { srt, format, fps? } | null
 *   CRSubFix.legacySubs.DEFAULT_FPS           — 23.976 (Japanese TV/BD masters)
 */
(function () {
  'use strict';

  const NS = (typeof self !== 'undefined' ? self : globalThis);
  NS.CRSubFix = NS.CRSubFix || {};

  const DEFAULT_FPS = 23.976;

  const RE_TMP  = /^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d))?[:=](.*)$/;
  const RE_MDVD = /^\{(\d+)\}\{(\d*)\}(.*)$/;
  const RE_MPL2 = /^\[(\d+)\]\[(\d*)\](.*)$/;

  function lines(text) {
    return String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean);
  }

  function detect(text) {
    const ls = lines(text).slice(0, 40);
    if (!ls.length) return null;
    const score = (re) => ls.filter(l => re.test(l)).length / ls.length;
    const s = { microdvd: score(RE_MDVD), mpl2: score(RE_MPL2), tmplayer: score(RE_TMP) };
    const best = Object.keys(s).reduce((a, b) => (s[b] > s[a] ? b : a));
    return s[best] >= 0.6 ? best : null;
  }

  // Strip MicroDVD/MPL2 inline styling, keep line breaks.
  function cleanText(t) {
    return t
      .replace(/\{[^}]*\}/g, '')          // {y:i} {c:$0000ff} …
      .split('|')
      .map(s => s.replace(/^\s*\//, '').trim())   // MPL2 "/" italic marker
      .filter(Boolean)
      .join('\n');
  }

  // A line with no end time stays up until the next one, but not forever:
  // ~15 chars/s reading speed, clamped to 1.5–7 s.
  function readingCap(text) {
    return Math.min(7, Math.max(1.5, text.replace(/\s+/g, '').length / 15 + 0.5));
  }

  function srtTime(sec) {
    const ms = Math.max(0, Math.round(sec * 1000));
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60;
    const s = Math.floor(ms / 1000) % 60, r = ms % 1000;
    const p = (n, w) => String(n).padStart(w, '0');
    return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(r, 3)}`;
  }

  // items: [{ start, end|null, text }] sorted by start → SRT text.
  function finish(items) {
    items.sort((a, b) => a.start - b.start);
    const out = [];
    let n = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.text) continue;                     // blank TMPlayer line = "clear"
      let end = it.end;
      if (end == null || end <= it.start) {
        const next = items[i + 1] ? items[i + 1].start : Infinity;
        end = Math.min(next, it.start + readingCap(it.text));
      }
      if (end <= it.start) continue;
      out.push(`${++n}\n${srtTime(it.start)} --> ${srtTime(end)}\n${it.text}\n`);
    }
    return n ? out.join('\n') : null;
  }

  function fromTmplayer(ls) {
    const items = [];
    for (const l of ls) {
      const m = RE_TMP.exec(l);
      if (!m) continue;
      const start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? (+m[4]) / 10 : 0);
      items.push({ start, end: null, text: cleanText(m[5]) });
    }
    return items;
  }

  function fromMicroDvd(ls, fpsOpt) {
    let fps = fpsOpt > 0 ? fpsOpt : DEFAULT_FPS;
    const items = [];
    for (const l of ls) {
      const m = RE_MDVD.exec(l);
      if (!m) continue;
      // Convention: "{1}{1}23.976" as the first cue declares the frame rate.
      if (!items.length && m[1] === '1' && m[2] === '1' && /^\d+(?:[.,]\d+)?$/.test(m[3].trim())) {
        if (!(fpsOpt > 0)) fps = parseFloat(m[3].replace(',', '.'));
        continue;
      }
      items.push({ start: (+m[1]) / fps, end: m[2] ? (+m[2]) / fps : null, text: cleanText(m[3]) });
    }
    return { items, fps };
  }

  function fromMpl2(ls) {
    const items = [];
    for (const l of ls) {
      const m = RE_MPL2.exec(l);
      if (!m) continue;
      items.push({ start: (+m[1]) / 10, end: m[2] ? (+m[2]) / 10 : null, text: cleanText(m[3]) });
    }
    return items;
  }

  function toSrt(text, opts = {}) {
    const format = detect(text);
    if (!format) return null;
    const ls = lines(text);
    if (format === 'tmplayer') { const srt = finish(fromTmplayer(ls)); return srt ? { srt, format } : null; }
    if (format === 'mpl2')     { const srt = finish(fromMpl2(ls));     return srt ? { srt, format } : null; }
    const { items, fps } = fromMicroDvd(ls, opts.fps);
    const srt = finish(items);
    return srt ? { srt, format, fps } : null;
  }

  NS.CRSubFix.legacySubs = { detect, toSrt, DEFAULT_FPS };
})();
