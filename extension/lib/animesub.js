/**
 * lib/animesub.js — AnimeSub.info request shapes and search-page parser.
 *
 * AnimeSub has no API; this module knows the HTML.  Verified live 2026-11-07:
 *   - HTTP only (port 443 closed); pages are ISO-8859-2 (meta tag, no header).
 *   - Search:  GET /szukaj.php?szukane=<q>&pTitle=org|en|pl[&od=<page0>]
 *              30 results per page; "epNN" in the query narrows to an episode.
 *   - Each result carries hidden id + sh.  `sh` is regenerated on EVERY search
 *     response and only the latest one in the session is accepted — so `sh`
 *     must never be cached; a download re-runs the search first.
 *   - Download: POST /sciagnij.php  id, sh, single_file  → application/zip
 *     (an HTML page saying "Błąd zabezpieczeń" when sh/cookie is stale).
 *
 * Pure — no DOM (the MV3 service worker has no DOMParser), no fetch.  The SW
 * does the network calls and the ISO-8859-2 decode, then hands text here.
 *
 * Public surface:
 *   CRSubFix.animesub.BASE
 *   CRSubFix.animesub.TITLE_TYPES                 — ['org','en','pl']
 *   CRSubFix.animesub.searchUrl({ query, titleType, page })   → string
 *   CRSubFix.animesub.searchQueryParams(query)    → encoded query string piece
 *   CRSubFix.animesub.downloadBody(id, sh)        → x-www-form-urlencoded string
 *   CRSubFix.animesub.buildQuery(title, episode)  → "Title ep05"
 *   CRSubFix.animesub.parseSearch(html)           → { results, tokens, hasNext }
 *       results: [{ id, titleOrg, titleEn, titleAlt, episode, date, format,
 *                   uploader, size, comments, downloads, author, description }]
 *       tokens:  { [id]: sh }  — use immediately, never persist
 *   CRSubFix.animesub.isSecurityError(text)       → true for the stale-sh page
 *   CRSubFix.animesub.SUPPORTED_FORMATS           — formats we can render
 */
(function () {
  'use strict';

  const NS = (typeof self !== 'undefined' ? self : globalThis);
  NS.CRSubFix = NS.CRSubFix || {};

  const BASE = 'http://animesub.info';
  const TITLE_TYPES = ['org', 'en', 'pl'];

  // Names exactly as AnimeSub prints them in the "Format" column.  ASS/SSA/SRT
  // go straight to the Better Subs parser; TMPlayer/MicroDVD/MPL2 go through
  // lib/legacy-subs.js first.
  const SUPPORTED_FORMATS = ['Advanced SSA', 'SubStation Alpha', 'Subrip', 'TMPlayer', 'MicroDVD', 'MPL2'];

  // AnimeSub decodes the query as ISO-8859-2, so Polish letters must be
  // percent-encoded in that charset, not UTF-8.  Characters outside it
  // (e.g. Japanese) cannot be searched anyway — they are dropped.
  // Char → byte map for 0xA0–0xFF, derived from the platform decoder so there
  // is no hand-typed table to get wrong.
  let iso2Map = null;
  function iso2Byte(ch) {
    const c = ch.charCodeAt(0);
    if (c < 0x80) return c;
    if (!iso2Map) {
      iso2Map = new Map();
      const bytes = new Uint8Array(96).map((_, i) => 0xa0 + i);
      [...new TextDecoder('iso-8859-2').decode(bytes)].forEach((u, i) => iso2Map.set(u, 0xa0 + i));
    }
    return iso2Map.get(ch) ?? -1;
  }
  function searchQueryParams(query) {
    let out = '';
    for (const ch of String(query)) {
      const b = iso2Byte(ch);
      if (b < 0) continue;
      if (b === 0x20) out += '+';
      else if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || '-_.'.includes(ch)) out += ch;
      else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
  }

  function searchUrl({ query, titleType = 'org', page = 0 }) {
    const t = TITLE_TYPES.includes(titleType) ? titleType : 'org';
    let url = `${BASE}/szukaj.php?szukane=${searchQueryParams(query)}&pTitle=${t}`;
    if (page > 0) url += `&od=${page | 0}`;
    return url;
  }

  function downloadBody(id, sh) {
    return `id=${encodeURIComponent(id)}&sh=${encodeURIComponent(sh)}&single_file=Pobierz+napisy`;
  }

  function buildQuery(title, episode) {
    const t = String(title || '').trim();
    const n = parseInt(episode, 10);
    if (!Number.isFinite(n) || n <= 0) return t;
    return `${t} ep${String(n).padStart(2, '0')}`;
  }

  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
      }
      return ENT[e.toLowerCase()] ?? m;
    });
  }
  function textOf(html) {
    return decodeEntities(String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''))
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .trim();
  }

  function episodeOf(title) {
    const m = /\bep\s*0*(\d{1,4})(?:\s*-\s*0*(\d{1,4}))?\b/i.exec(title || '');
    if (!m) return null;
    return m[2] ? `${m[1]}-${m[2]}` : m[1];
  }

  // One result = one <table class="Napisy"> holding three "KNap" rows and a
  // "KKom" row.  Split on the class marker and read each chunk with targeted
  // patterns (row 2 nests a rating-bar table, so a generic cell splitter would
  // misalign).
  const RE_ROW1 = /<tr class="KNap">\s*<td align="left"[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>[\s\S]*?<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/;
  const RE_ROW2 = /<tr class="KNap">\s*<td align="left">([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>/g;
  const RE_SIZE = /<\/table><\/td><td>([^<]*)<\/td><\/tr>/;
  const RE_ROW3 = /<tr class="KNap"><td align="left">([\s\S]*?)<\/td><td>(?:<a[^>]*>\((\d+)\)<\/a>)?[\s\S]*?<\/td><td>[\s\S]*?<\/td><td>\s*(\d+)\s*razy/;
  const RE_TOKEN = /name="id" value="(\d+)"\s*>\s*<input type="hidden" name="sh" value="([0-9a-f]+)"/;
  const RE_COMMENT = /<td class=KNap align=left colspan=3>([\s\S]*?)<\/td><\/tr>/;

  function parseSearch(html) {
    const results = [];
    const tokens = {};
    const chunks = String(html).split('class="Napisy"').slice(1);
    for (const chunk of chunks) {
      const tok = RE_TOKEN.exec(chunk);
      if (!tok) continue;                       // the header table has no token
      const [, id, sh] = tok;
      tokens[id] = sh;
      const r1 = RE_ROW1.exec(chunk);
      RE_ROW2.lastIndex = 0;
      RE_ROW2.exec(chunk);                      // skip: row 1 also matches this shape
      const r2 = RE_ROW2.exec(chunk);
      const sz = RE_SIZE.exec(chunk);
      const r3 = RE_ROW3.exec(chunk);
      const cm = RE_COMMENT.exec(chunk);

      const lines = cm ? textOf(cm[1]).split('\n') : [];
      if (lines[0] && /^ID\s+\d+$/.test(lines[0])) lines.shift();
      let author = null;
      if (lines[0] && /^Autor:/i.test(lines[0])) author = lines.shift().replace(/^Autor:\s*/i, '') || null;

      const titleOrg = r1 ? textOf(r1[1]) : '';
      results.push({
        id,
        titleOrg,
        titleEn:     r2 ? textOf(r2[1]) : '',
        titleAlt:    r3 ? textOf(r3[1]) : '',
        episode:     episodeOf(titleOrg),
        date:        r1 ? textOf(r1[2]) : '',
        format:      r1 ? textOf(r1[3]) : '',
        uploader:    r2 ? textOf(r2[2]) : '',
        size:        sz ? textOf(sz[1]) : '',
        comments:    r3 && r3[2] ? parseInt(r3[2], 10) : 0,
        downloads:   r3 ? parseInt(r3[3], 10) : 0,
        author,
        description: lines.join('\n').trim(),
      });
    }
    const hasNext = /alt="Następne"/.test(html);
    return { results, tokens, hasNext };
  }

  function isSecurityError(text) { return /Błąd zabezpieczeń/.test(text || ''); }

  NS.CRSubFix.animesub = {
    BASE, TITLE_TYPES, SUPPORTED_FORMATS,
    searchUrl, searchQueryParams, downloadBody, buildQuery,
    parseSearch, isSecurityError,
  };
})();
