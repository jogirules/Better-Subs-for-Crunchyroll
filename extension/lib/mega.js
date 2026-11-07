/**
 * lib/mega.js — read-only access to public MEGA folders of fansub groups (fork).
 *
 * Polish fansub groups announce releases on Discord but keep the subtitle
 * files in public MEGA folders (checked 2026-11-07: FrixySubs ~2000 .ass,
 * FujiSubs ~900 .ass).  A public folder link carries its own key after '#',
 * so no account or token is involved:
 *
 *   1. POST g.api.mega.co.nz/cs?n=<folder>  [{a:'f', c:1, ca:1, r:1}]
 *      → every node: handle h, parent p, type t (0 file / 1 folder), size s,
 *        attributes a (AES-CBC, zero IV) and its key k (AES-ECB under the
 *        folder key; "owner:key" pairs, several separated by '/').
 *   2. POST …  [{a:'g', g:1, ssl:1, n:<file handle>}] → a download URL.
 *   3. GET that URL → file bytes, AES-CTR encrypted with the node key.
 *
 * Pure crypto/index/search helpers here (aes-js for ECB/CBC; the caller uses
 * WebCrypto AES-CTR for file bodies).  Network calls live in background.js.
 */
(function () {
  'use strict';

  const NS = (typeof self !== 'undefined' ? self : globalThis);
  NS.CRSubFix = NS.CRSubFix || {};
  const aesjs = NS.aesjs;

  const API = 'https://g.api.mega.co.nz/cs';

  // Group folders shipped by default — the "all subtitles" folders the groups
  // themselves link from their Discord/website.  More can be added by the user.
  // Order = tie-break order in results (the user's favourite group first).
  const DEFAULT_FOLDERS = [
    // Shisha Subs: "Suby" folder pinned on their Discord (#ogólny), 2026-11-07.
    { group: 'Shisha',    link: 'https://mega.nz/folder/JOBiUJKZ#RuIjBCN-Ha6vxksbKkCf0w' },
    { group: 'FrixySubs', link: 'https://mega.nz/folder/KQ00iCLb#0jW1zZcli8N-EUtbZszXYw' },
    { group: 'FujiSubs',  link: 'https://mega.nz/folder/U3ZBTZoZ#wJZumsXp5bzLXc6Hef5PXQ' },
    // Groups without an "all subtitles" folder: one folder per series, listed
    // only when the searched title matches `titles` (see seriesMatches).
    // Max-Subs, from #wydawane-anime on their Discord (2026-11-07; the other
    // three Max folders were empty or deleted).  BD-timed releases.
    { group: 'Max-Subs', titles: ['Isekai Nonbiri Nouka'],
      link: 'https://mega.nz/folder/5sxWQRiZ#nbCQve5zrGAKbEmSqXHeOg' },
    { group: 'Max-Subs', titles: ['Akuyaku Reijou Level 99'],
      link: 'https://mega.nz/folder/wh5lmC6a#wAoYUBqux-9BgTGfMN6x1Q' },
  ];

  const SUB_EXT = /\.(ass|ssa|srt|vtt|txt|sub|mpl|zip)$/i;

  // https://mega.nz/folder/<handle>#<key>  (also the legacy #F!<handle>!<key>)
  function parseFolderLink(link) {
    const s = String(link || '').trim();
    let m = /mega\.nz\/folder\/([A-Za-z0-9_-]{8})#([A-Za-z0-9_-]{22})/.exec(s)
         || /mega\.nz\/#F!([A-Za-z0-9_-]{8})!([A-Za-z0-9_-]{22})/.exec(s);
    if (!m) return null;
    return { handle: m[1], keyB64: m[2] };
  }

  function b64urlDecode(s) {
    const t = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/,/g, '');
    const pad = t + '==='.slice((t.length + 3) % 4);
    const bin = atob(pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function b64Encode(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }

  const ecbDecrypt = (key, data) => new aesjs.ModeOfOperation.ecb(key).decrypt(data);
  const cbcDecryptZeroIv = (key, data) => new aesjs.ModeOfOperation.cbc(key, new Uint8Array(16)).decrypt(data);

  // A file's 32-byte node key folds into a 16-byte AES key; the next 8 bytes
  // are the CTR nonce.  Folder keys are already 16 bytes.
  function fileAesKey(k32) {
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = k32[i] ^ k32[16 + i];
    return out;
  }
  function fileCtrIv(k32) {
    const iv = new Uint8Array(16);
    iv.set(k32.subarray(16, 24), 0);
    return iv;
  }

  function decodeAttr(aesKey, aB64) {
    const raw = b64urlDecode(aB64);
    if (!raw.length || raw.length % 16) return null;
    const txt = new TextDecoder().decode(cbcDecryptZeroIv(aesKey, raw)).replace(/\0+$/, '');
    if (!txt.startsWith('MEGA{')) return null;
    try { return JSON.parse(txt.slice(4)); } catch (_) { return null; }
  }

  // API listing → [{ h, p, t, s, name, k }] (k: the decrypted node key; nodes
  // whose key or name can't be recovered are dropped).
  function decryptListing(listing, folderKeyB64) {
    const fk = b64urlDecode(folderKeyB64);
    const out = [];
    for (const n of (listing && listing.f) || []) {
      const want = n.t === 0 ? 32 : 16;
      for (const part of String(n.k || '').split('/')) {
        const enc = b64urlDecode(part.slice(part.indexOf(':') + 1));
        if (enc.length !== want) continue;
        const k = ecbDecrypt(fk, enc);
        const attr = decodeAttr(n.t === 0 ? fileAesKey(k) : k, n.a);
        if (attr && typeof attr.n === 'string') { out.push({ h: n.h, p: n.p, t: n.t, s: n.s || 0, name: attr.n, k }); break; }
      }
    }
    return out;
  }

  // Subtitle files with their full path — what the SW caches and searches.
  function buildIndex(nodes) {
    const byH = new Map(nodes.map((n) => [n.h, n]));
    const pathOf = (n) => {
      const parts = [];
      for (let x = byH.get(n.p), guard = 0; x && guard < 64; x = byH.get(x.p), guard++) parts.unshift(x.name);
      return parts.join('/');
    };
    return nodes
      .filter((n) => n.t === 0 && SUB_EXT.test(n.name))
      .map((n) => ({ h: n.h, dir: pathOf(n), name: n.name, size: n.s, k: b64Encode(n.k) }));
  }

  // ── Search ────────────────────────────────────────────────────────────────
  // Season spellings fold to "season N" (same idea as title-map's resultsMatch).
  function words(s) {
    return String(s || '').toLowerCase()
      .replace(/[×✕]/g, ' x ')
      .replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/g, 'season $1')
      .replace(/\bs(\d{1,2})(?=e\d|\b)/g, ' season $1 ')
      .replace(/\bseason\s*0*(\d+)/g, 'season $1')
      .split(/[^a-z0-9]+/).filter(Boolean)
      // Roman season numerals ("Mushoku Tensei III", Shisha's folders).  Not
      // "x"/"v"/"i": those are words too ("Spy x Family").
      .flatMap((w) => ROMAN[w] ? ['season', String(ROMAN[w])] : [w]);
  }
  const ROMAN = { ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9 };
  function seasonOf(ws) {
    const i = ws.indexOf('season');
    return i >= 0 && /^\d+$/.test(ws[i + 1] || '') ? +ws[i + 1] : null;
  }
  // Numbers in a file name that can be an episode (not 1080/720/x265/years).
  function episodeNumbers(name) {
    const base = name.replace(/\.[^.]+$/, '');
    const out = new Set();
    const se = /s\d{1,2}e(\d{1,4})/ig;
    for (let m; (m = se.exec(base));) out.add(+m[1]);
    for (const m of base.matchAll(/(?:^|[^0-9a-z])(?:ep?|odc)?\s*0*(\d{1,4})(?![0-9])/ig)) {
      const n = +m[1];
      if (n === 0 || n === 480 || n === 720 || n === 1080 || n === 2160 || n === 264 || n === 265 || (n >= 1900 && n <= 2100)) continue;
      out.add(n);
    }
    return out;
  }

  // query: { title, episodes: [n…] }  → ranked index entries (+ group).
  //   Every title word (season words aside) must appear in the folder path or
  //   file name; a different explicit season excludes the file; with episodes
  //   given, the file name must carry one of them.
  function search(index, { title, episodes } = {}, limit = 40) {
    const hits = searchStrict(index, title, episodes, limit);
    if (hits.length) return hits;
    // Groups shorten long titles: "Mushoku Tensei: Isekai Ittara Honki Dasu
    // Season 3" is filed as "Mushoku Tensei III".  Retry with the part before
    // the colon / dash (plus the season), if that part is specific enough.
    const m = /^(.+?)\s*[:：]|^(.+?)\s+[-–]\s/.exec(String(title || ''));
    const head = m && (m[1] || m[2]);
    if (!head) return hits;
    const hw = words(head);
    if (hw.length < 2 && head.replace(/[^a-z0-9]/gi, '').length < 5) return hits;
    const season = seasonOf(words(title));
    return searchStrict(index, head + (season && !seasonOf(hw) ? ` season ${season}` : ''), episodes, limit);
  }
  function searchStrict(index, title, episodes, limit) {
    const tw = words(title);
    const season = seasonOf(tw);
    const core = tw.filter((w, i) => w !== 'season' && !(tw[i - 1] === 'season'));
    if (!core.length) return [];
    const eps = (episodes || []).filter((n) => Number.isInteger(n) && n > 0);
    const hits = [];
    for (const f of index) {
      const pw = words(f.dir + ' ' + f.name);
      const set = new Set(pw);
      if (!core.every((w) => set.has(w))) continue;
      const fs = seasonOf(pw);
      if (season && season > 1 && fs !== season) continue;
      if ((!season || season === 1) && fs && fs > 1) continue;
      let score = 1;
      if (eps.length) {
        const nums = episodeNumbers(f.name);
        const hit = eps.findIndex((e) => nums.has(e));
        if (hit < 0) continue;
        score += hit === 0 ? 2 : 1;
      }
      if (/\.(ass|ssa)$/i.test(f.name)) score += 0.5;
      hits.push({ ...f, score });
    }
    hits.sort((a, b) => b.score - a.score || (a.order ?? 0) - (b.order ?? 0) || (a.dir + a.name).localeCompare(b.dir + b.name));
    return hits.slice(0, limit);
  }

  // Does a per-series folder (its `titles`) belong to this search?  Either
  // side may be the longer one: "Akuyaku Reijou Level 99" vs AniList's
  // "Akuyaku Reijou Level 99: Watashi wa Ura-Boss desu ga Maou dewa Arimasen".
  function seriesMatches(titles, query) {
    const core = (t) => { const w = words(t); return w.filter((x, i) => x !== 'season' && w[i - 1] !== 'season'); };
    const q = new Set(core(query));
    if (!q.size) return false;
    return (titles || []).some((t) => {
      const tw = core(t);
      if (!tw.length) return false;
      if (tw.every((w) => q.has(w))) return true;
      // A shorter query must still name most of the series ("Nonbiri Nouka").
      return [...q].every((w) => tw.includes(w)) && q.size >= 0.6 * tw.length;
    });
  }

  NS.CRSubFix.mega = {
    seriesMatches,
    API, DEFAULT_FOLDERS, parseFolderLink, b64urlDecode, b64Encode,
    decryptListing, buildIndex, search, episodeNumbers, fileAesKey, fileCtrIv,
  };
})();
