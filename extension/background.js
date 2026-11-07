/**
 * background.js — MV3 service worker.
 *
 * Responsibilities:
 * 1. Relay the Alt+J keyboard shortcut to the active tab's content script.
 * 2. Update the extension action badge when content.js reports overlay state.
 * 3. Machine translation: the ONLY place the user's BYOK API key is read.  The
 *    key lives in chrome.storage.local and never crosses into a page/content
 *    world — content.js forwards just the text batch; the SW attaches the key
 *    and calls DeepL.  Cross-origin fetch here relies on the
 *    optional_host_permissions the popup requests when the user enables MT.
 */

importScripts('lib/protocol.js', 'lib/animesub.js', 'lib/title-map.js', 'lib/vendor/aes.js', 'lib/mega.js', 'lib/font-names.js');
const FONTN = self.CRSubFix.fontNames;
const { MSG } = self.CRSubFix.protocol;
const AS = self.CRSubFix.animesub;
const TM = self.CRSubFix.titleMap;
const MEGA = self.CRSubFix.mega;

// ── AnimeSub.info (fork) ───────────────────────────────────────────────────
// Every request is user-initiated (a click in the player).  One shared queue
// with a minimum gap keeps us polite: no parallel requests, no bursts.
// Cookies: the search response sets `ansi_sciagnij`, and the download must
// carry it back — credentials:'include' + the http://animesub.info host
// permission lets Chrome attach it from the service worker.
const AS_MIN_GAP_MS = 3000;
let asQueue = Promise.resolve();
let asLastAt = 0;
function asRequest(url, init) {
  const run = async () => {
    const wait = asLastAt + AS_MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try {
      return await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(20000), ...init });
    } finally {
      asLastAt = Date.now();
    }
  };
  const p = asQueue.then(run, run);
  asQueue = p.catch(() => {});
  return p;
}

async function asSearchRaw({ query, titleType, page }) {
  const resp = await asRequest(AS.searchUrl({ query, titleType, page }));
  if (!resp.ok) throw new Error('AnimeSub HTTP ' + resp.status);
  // No charset header; the page's <meta> says ISO-8859-2.
  const html = new TextDecoder('iso-8859-2').decode(await resp.arrayBuffer());
  return AS.parseSearch(html);
}

// Search results are cached for 24 h (without `sh` — it is single-use anyway),
// so re-opening the panel or flipping back a page costs AnimeSub nothing.
const AS_CACHE_KEY = 'asSearchCache';
const AS_CACHE_TTL_MS = 24 * 3600 * 1000;
const AS_CACHE_MAX = 50;
async function asCacheGet(key) {
  const { [AS_CACHE_KEY]: c = {} } = await chrome.storage.local.get(AS_CACHE_KEY);
  const hit = c[key];
  return hit && Date.now() - hit.at < AS_CACHE_TTL_MS ? hit : null;
}
async function asCachePut(key, value) {
  const { [AS_CACHE_KEY]: c = {} } = await chrome.storage.local.get(AS_CACHE_KEY);
  const now = Date.now();
  c[key] = { ...value, at: now };
  const keep = Object.entries(c).filter(([, v]) => now - v.at < AS_CACHE_TTL_MS)
    .sort((a, b) => b[1].at - a[1].at).slice(0, AS_CACHE_MAX);
  await chrome.storage.local.set({ [AS_CACHE_KEY]: Object.fromEntries(keep) });
}

async function animesubSearch(payload) {
  const query = String(payload?.query || '').trim();
  if (!query) return { ok: false, error: 'empty-query' };
  const args = { query, titleType: payload.titleType, page: payload.page | 0 };
  const key = AS.searchUrl(args);
  if (!payload.refresh) {
    const hit = await asCacheGet(key);
    if (hit) return { ok: true, results: hit.results, hasNext: hit.hasNext, cached: true };
  }
  const { results, hasNext } = await asSearchRaw(args);
  // Tokens (sh) are deliberately NOT returned or cached: they expire with the next search.
  await asCachePut(key, { results, hasNext });
  return { ok: true, results, hasNext };
}

// Download = fresh search (for a current `sh`) + POST, back to back in the queue.
async function animesubDownload(payload) {
  const id = String(payload?.id || '');
  if (!/^\d+$/.test(id)) return { ok: false, error: 'bad-id' };
  const { tokens } = await asSearchRaw({ query: payload.query, titleType: payload.titleType, page: payload.page | 0 });
  const sh = tokens[id];
  if (!sh) return { ok: false, error: 'not-in-results' };
  const resp = await asRequest(AS.BASE + '/sciagnij.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: AS.downloadBody(id, sh),
  });
  if (!resp.ok) return { ok: false, error: 'AnimeSub HTTP ' + resp.status };
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) {
    const text = new TextDecoder('iso-8859-2').decode(bytes.subarray(0, 2000));
    return { ok: false, error: AS.isSecurityError(text) ? 'security-error' : 'not-a-zip' };
  }
  const cd = resp.headers.get('Content-Disposition') || '';
  const filename = (/filename=([^;]+)/i.exec(cd) || [])[1]?.trim().replace(/^"|"$/g, '') || `animesub_${id}.zip`;
  // chrome.runtime messages are JSON — ship the archive as base64.
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { ok: true, filename, base64: btoa(bin), size: bytes.length };
}

// ── AniList: English/localized series title + CR season → romaji (fork) ────
// One request per (title, season), cached 30 days — AniList titles don't move.
const TITLE_CACHE_KEY = 'asTitleCache2';   // v2: + first-entry fields
const TITLE_TTL_MS = 30 * 24 * 3600 * 1000;
async function resolveTitle(payload) {
  const search = String(payload?.search || '').trim();
  if (!search) return { ok: false, error: 'empty-title' };
  const season = payload.seasonNumber ?? null, airDate = payload.airDate ?? null;
  // Air date is part of the key: one CR season can span two AniList entries (split cours).
  const key = `${search.toLowerCase()}|${season ?? ''}|${airDate ?? ''}`;
  const { [TITLE_CACHE_KEY]: c = {} } = await chrome.storage.local.get(TITLE_CACHE_KEY);
  if (c[key] && Date.now() - c[key].at < TITLE_TTL_MS) return { ok: true, ...c[key], cached: true };
  const resp = await fetch(TM.ANILIST_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: TM.anilistBody(search), signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) return { ok: false, error: 'AniList HTTP ' + resp.status };
  const media = (await resp.json())?.data?.Page?.media || [];
  const m = TM.pickMedia(media, { seasonNumber: season, airDate });
  if (!m) return { ok: false, error: 'no-match' };
  const f = TM.firstTv(media) || m;
  const value = {
    romaji: m.title?.romaji || '', english: m.title?.english || '', anilistId: m.id,
    startDate: TM.fuzzyDate(m.startDate),
    firstRomaji: f.title?.romaji || '', firstStartDate: TM.fuzzyDate(f.startDate),
    at: Date.now(),
  };
  c[key] = value;
  const keep = Object.entries(c).sort((a, b) => b[1].at - a[1].at).slice(0, 200);
  await chrome.storage.local.set({ [TITLE_CACHE_KEY]: Object.fromEntries(keep) });
  return { ok: true, ...value };
}

// ── Public MEGA folders of fansub groups (fork) ────────────────────────────
// A folder listing is one API call (FrixySubs: ~10k nodes, ~0.3 s); the
// decrypted subtitle index is cached per folder for 12 h, so a search is
// local and only a download touches MEGA again.  Requests are user-initiated
// and serialized (same politeness rule as AnimeSub).
const MEGA_INDEX_PREFIX = 'megaIndex_';
const MEGA_INDEX_TTL_MS = 12 * 3600 * 1000;
const MEGA_FOLDERS_KEY = 'megaFolders';          // user-added [{group, link}]
const MEGA_MAX_FILE = 20 * 1024 * 1024;
let megaQueue = Promise.resolve();
let megaSeq = Math.floor(Math.random() * 1e6);
function megaApi(handle, cmd) {
  const run = async () => {
    const resp = await fetch(`${MEGA.API}?id=${++megaSeq}&n=${handle}`, {
      method: 'POST', body: JSON.stringify([cmd]), signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error('MEGA HTTP ' + resp.status);
    const body = await resp.json();
    const r = Array.isArray(body) ? body[0] : body;
    if (typeof r === 'number') throw new Error('MEGA error ' + r);   // e.g. -9 not found, -3 retry
    return r;
  };
  const p = megaQueue.then(run, run);
  megaQueue = p.catch(() => {});
  return p;
}

async function megaFolders() {
  const { [MEGA_FOLDERS_KEY]: extra = [] } = await chrome.storage.local.get(MEGA_FOLDERS_KEY);
  const seen = new Set();
  return [...MEGA.DEFAULT_FOLDERS.map(f => ({ ...f, builtin: true })), ...extra]
    .map(f => ({ ...f, ...MEGA.parseFolderLink(f.link) }))
    .filter(f => f.handle && !seen.has(f.handle) && seen.add(f.handle));
}
// Folder chips in the panel: one per group (per-series folders collapse).
function megaFolderList(folders) {
  const out = [];
  for (const { group, handle, builtin, titles } of folders) {
    const prev = out.find(f => f.group === group && f.builtin && builtin);
    if (prev) prev.series = (prev.series || 1) + 1;
    else out.push({ group, handle, builtin: !!builtin, ...(titles ? { series: 1 } : {}) });
  }
  return out;
}

// One listing call → subtitle files + font files (cached together, 12 h).
async function megaListing(folder, refresh) {
  const key = MEGA_INDEX_PREFIX + folder.handle;
  if (!refresh) {
    const { [key]: hit } = await chrome.storage.local.get(key);
    if (hit && hit.fonts && Date.now() - hit.at < MEGA_INDEX_TTL_MS) return hit;
  }
  const listing = await megaApi(folder.handle, { a: 'f', c: 1, ca: 1, r: 1 });
  const nodes = MEGA.decryptListing(listing, folder.keyB64);
  const entry = { at: Date.now(), files: MEGA.buildIndex(nodes), fonts: MEGA.buildFontIndex(nodes) };
  await chrome.storage.local.set({ [key]: entry });
  return entry;
}
async function megaIndex(folder, refresh) {
  return (await megaListing(folder, refresh)).files;
}

// Download + AES-CTR decrypt one indexed file.  `cache`: keep the plaintext in
// Cache Storage (fonts — reused across episodes of a series).
async function megaFileBytes(folder, file, cache) {
  const url = 'https://mega-cache.invalid/' + file.h;
  const store = cache ? await caches.open('crsub-mega-files') : null;
  if (store) {
    const hit = await store.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  }
  const g = await megaApi(folder.handle, { a: 'g', g: 1, ssl: 1, n: file.h });
  if (!g || !g.g) throw new Error('no-download-url');
  const resp = await fetch(g.g, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error('MEGA HTTP ' + resp.status);
  const enc = new Uint8Array(await resp.arrayBuffer());
  const k32 = Uint8Array.from(atob(file.k), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', MEGA.fileAesKey(k32), 'AES-CTR', false, ['decrypt']);
  const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CTR', counter: MEGA.fileCtrIv(k32), length: 64 }, key, enc));
  if (store) { try { await store.put(url, new Response(bytes)); } catch (_) {} }
  return bytes;
}

// Fonts a subtitle file asks for, from its group's font folder.
//   { folder, dir }  — a MEGA subtitle: that series' font folder;
//   { title }        — any other subtitle (AnimeSub): a series folder of that
//                      title in any group's MEGA (the same season first);
//   names            — Style Fontname + \fn names used by the file.
// Face names come from each font's `name` table (cached per file handle);
// unknown files are fetched name-hinted first, within a download budget.
const MEGA_FONT_META_KEY = 'megaFontMeta';
const MEGA_FONT_BUDGET = 80e6;        // bytes fetched per call to discover names
const MEGA_FONT_RETURN_MAX = 40e6;    // bytes sent back to the page
async function megaFonts(payload) {
  const needed = [...new Set((payload?.names || []).map(FONTN.normFontName).filter(Boolean))].slice(0, 100);
  if (!needed.length) return { ok: true, fonts: [], missing: [] };
  const folders = await megaFolders();
  let cands = [], from = null;
  const src = folders.find(f => f.handle === payload.folder);
  if (src) {
    const L = await megaListing(src, false);
    cands = MEGA.fontsForDir(L.fonts, L.files, String(payload.dir || '')).map(file => ({ folder: src, file }));
    if (cands.length) from = src.group;
  }
  if (!cands.length && payload.title) {
    for (const f of folders.filter(f => !f.titles || MEGA.seriesMatches(f.titles, payload.title))) {
      try {
        const best = MEGA.fontBasesForTitle((await megaListing(f, false)).fonts, payload.title)[0];
        if (best) { cands = best.fonts.map(file => ({ folder: f, file })); from = `${f.group}: ${best.base}`; break; }
      } catch (_) {}
    }
  }
  if (!cands.length) return { ok: true, fonts: [], missing: needed, from: null };

  const want = new Set(needed), found = new Set();
  const { [MEGA_FONT_META_KEY]: meta = {} } = await chrome.storage.local.get(MEGA_FONT_META_KEY);
  const mark = (faces) => { let hit = false; for (const fc of faces) for (const n of fc.names) if (want.has(n)) { found.add(n); hit = true; } return hit; };
  for (const c of cands) if (meta[c.file.h]) mark(meta[c.file.h]);
  const unknown = cands.filter(c => !meta[c.file.h])
    .map(c => ({ ...c, hint: MEGA.fontFileHint(c.file.name, needed) }))
    .sort((a, b) => b.hint - a.hint || a.file.size - b.file.size);
  const fresh = new Map();
  let spent = 0, dirty = false, next = 0;
  // Four downloads in flight (API calls stay queued in megaApi; the CDN
  // transfers overlap).  A worker stops once every name is found.
  const worker = async () => {
    while (next < unknown.length && !needed.every(n => found.has(n))) {
      const c = unknown[next++];
      if (spent + c.file.size > MEGA_FONT_BUDGET) continue;
      spent += c.file.size;
      let bytes;
      try { bytes = await megaFileBytes(c.folder, c.file, true); } catch (_) { continue; }
      meta[c.file.h] = FONTN.parseFontFaces(bytes).map(f => ({ names: f.names.slice(0, 8), weight: f.weight, italic: f.italic }));
      dirty = true;
      if (mark(meta[c.file.h])) fresh.set(c.file.h, bytes);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  // Second pass: names the series folder lacks ("Lato", a font the group only
  // shipped with another show) — files NAMED like them anywhere in the big
  // group folders (series-only folders skipped: one listing each).
  const missing = () => needed.filter(n => !found.has(n));
  if (missing().length) {
    const seen = new Set(cands.map(c => c.file.h));
    const extra = [];
    for (const f of folders.filter(f => !f.titles || f === src)) {
      let L; try { L = await megaListing(f, false); } catch (_) { continue; }
      for (const file of L.fonts) {
        if (seen.has(file.h)) continue;
        const hint = MEGA.fontFileHint(file.name, missing());
        if (hint >= 2) { seen.add(file.h); extra.push({ folder: f, file, hint }); }
      }
    }
    // One file per name spelling: groups re-upload the same font per series.
    const byName = new Map();
    for (const c of extra.sort((a, b) => b.hint - a.hint || a.file.size - b.file.size)) {
      const k = c.file.name.toLowerCase();
      if (!byName.has(k)) byName.set(k, c);
    }
    let budget = 30e6;
    for (const c of [...byName.values()].slice(0, 24)) {
      if (!missing().length) break;
      if (!meta[c.file.h]) {
        if (c.file.size > budget) continue;
        budget -= c.file.size;
        let bytes;
        try { bytes = await megaFileBytes(c.folder, c.file, true); } catch (_) { continue; }
        meta[c.file.h] = FONTN.parseFontFaces(bytes).map(f => ({ names: f.names.slice(0, 8), weight: f.weight, italic: f.italic }));
        dirty = true;
        if (mark(meta[c.file.h])) fresh.set(c.file.h, bytes);
      } else mark(meta[c.file.h]);
      if ((meta[c.file.h] || []).some(fc => fc.names.some(n => want.has(n)))) cands.push(c);
    }
  }
  if (dirty) await chrome.storage.local.set({ [MEGA_FONT_META_KEY]: meta });

  const fonts = [], have = new Set();
  const faceKey = (fc) => fc.names.filter(n => want.has(n)).sort().join('|') + '|' + fc.weight + (fc.italic ? 'i' : '');
  let sent = 0;
  for (const c of cands) {
    const faces = (meta[c.file.h] || []).filter(fc => fc.names.some(n => want.has(n)));
    // The same face twice ("A-OTF_X.otf" next to "A-OTF X.otf"): send one.
    if (!faces.length || faces.every(fc => have.has(faceKey(fc))) || sent + c.file.size > MEGA_FONT_RETURN_MAX) continue;
    faces.forEach(fc => have.add(faceKey(fc)));
    let bytes = fresh.get(c.file.h);
    if (!bytes) { try { bytes = await megaFileBytes(c.folder, c.file, true); } catch (_) { continue; } }
    sent += bytes.length;
    fonts.push({
      h: c.file.h, name: c.file.name, base64: MEGA.b64Encode(bytes),
      faces: faces.map(fc => ({ names: fc.names.filter(n => want.has(n)), weight: fc.weight, italic: fc.italic })),
    });
  }
  return { ok: true, fonts, missing: needed.filter(n => !found.has(n)), from };
}

async function megaSearch(payload) {
  const title = String(payload?.title || '').trim();
  if (!title) return { ok: false, error: 'empty-query' };
  const episodes = (payload.episodes || []).map(n => parseInt(n, 10)).filter(n => n > 0);
  // Per-series folders (with `titles`) are opened only when the title matches —
  // the index decides, so a search touches MEGA for at most a few of them.
  const folders = (await megaFolders()).filter(f => !f.titles || MEGA.seriesMatches(f.titles, title));
  const all = [], errors = [];
  for (const [order, f] of folders.entries()) {
    try {
      for (const file of await megaIndex(f, !!payload.refresh)) all.push({ ...file, group: f.group, folder: f.handle, order });
    } catch (e) {
      errors.push(`${f.group}: ${e && e.message}`);
    }
  }
  // Keys stay in the SW — the page gets what it shows and what it sends back.
  const results = MEGA.search(all, { title, episodes })
    .map(({ h, dir, name, size, group, folder, score }) => ({ h, dir, name, size, group, folder, score }));
  return { ok: true, results, errors, folders: folders.length };
}

async function megaDownload(payload) {
  const folder = (await megaFolders()).find(f => f.handle === payload?.folder);
  if (!folder) return { ok: false, error: 'unknown-folder' };
  const file = (await megaIndex(folder, false)).find(f => f.h === payload.h);
  if (!file) return { ok: false, error: 'not-in-index' };
  if (file.size > MEGA_MAX_FILE) return { ok: false, error: 'too-large' };
  let bytes;
  try { bytes = await megaFileBytes(folder, file, false); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, filename: file.name, base64: MEGA.b64Encode(bytes), size: bytes.length, group: folder.group, dir: file.dir };
}

// list | add {link, group?} | remove {handle}
async function megaFoldersMsg(payload) {
  const op = payload?.op || 'list';
  const { [MEGA_FOLDERS_KEY]: extra = [] } = await chrome.storage.local.get(MEGA_FOLDERS_KEY);
  if (op === 'add') {
    const parsed = MEGA.parseFolderLink(payload.link);
    if (!parsed) return { ok: false, error: 'bad-link' };
    if ((await megaFolders()).some(f => f.handle === parsed.handle)) return { ok: false, error: 'exists' };
    const group = String(payload.group || '').trim().slice(0, 40) || parsed.handle;
    // Validate before saving: the key must decrypt the listing.
    const files = await megaIndex({ ...parsed, group }, true);
    extra.push({ group, link: `https://mega.nz/folder/${parsed.handle}#${parsed.keyB64}` });
    await chrome.storage.local.set({ [MEGA_FOLDERS_KEY]: extra });
    return { ok: true, files: files.length, folders: megaFolderList(await megaFolders()) };
  }
  if (op === 'remove') {
    const keep = extra.filter(f => MEGA.parseFolderLink(f.link)?.handle !== payload.handle);
    await chrome.storage.local.set({ [MEGA_FOLDERS_KEY]: keep });
    await chrome.storage.local.remove(MEGA_INDEX_PREFIX + payload.handle);
  }
  return { ok: true, folders: megaFolderList(await megaFolders()) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  const fn = msg.type === MSG.AS_SEARCH ? animesubSearch : msg.type === MSG.AS_DOWNLOAD ? animesubDownload
           : msg.type === MSG.AS_TITLE ? resolveTitle
           : msg.type === MSG.MEGA_SEARCH ? megaSearch : msg.type === MSG.MEGA_DOWNLOAD ? megaDownload
           : msg.type === MSG.MEGA_FOLDERS ? megaFoldersMsg : msg.type === MSG.MEGA_FONTS ? megaFonts : null;
  if (!fn) return;
  fn(msg.payload).then(sendResponse).catch(e => {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    sendResponse({ ok: false, error: timedOut ? 'timeout' : 'fetch-failed: ' + (e && e.message) });
  });
  return true;
});

// ── Machine translation ────────────────────────────────────────────────────
// DeepL free keys end in ':fx' and use a different host from pro keys.
function deeplHost(key) {
  return key.trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
}
// DeepL source codes are 2-letter (no region); target codes may be regional.
function deeplSource(loc) { return loc ? loc.slice(0, 2).toUpperCase() : ''; }
function deeplTarget(loc) {
  const m = { 'pt-BR': 'PT-BR', 'pt-PT': 'PT-PT', 'en': 'EN-US', 'en-US': 'EN-US', 'en-GB': 'EN-GB' };
  return m[loc] ?? (loc ? loc.slice(0, 2).toUpperCase() : '');
}
async function deeplTranslate(key, texts, source, target) {
  const params = new URLSearchParams();
  for (const t of texts) params.append('text', t);
  params.append('target_lang', deeplTarget(target));
  const src = deeplSource(source);
  if (src) params.append('source_lang', src);
  const resp = await fetch(deeplHost(key) + '/v2/translate', {
    method:  'POST',
    headers: { 'Authorization': 'DeepL-Auth-Key ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
    // Bound the request: a stalled DeepL connection would otherwise leave the
    // content-script caller's RPC hanging forever, and the MV3 worker may be
    // torn down at the idle limit mid-flight with no response ever sent.
    signal:  AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    let msg = '';
    try { msg = (JSON.parse(body)?.message) || ''; } catch (_) {}
    console.warn('[Better Subs] DeepL HTTP ' + resp.status + ': ' + body.slice(0, 300));
    return { ok: false, error: 'DeepL HTTP ' + resp.status + (msg ? ': ' + msg.slice(0, 130) : ''), status: resp.status };
  }
  const data = await resp.json();
  if (!data || !Array.isArray(data.translations)) return { ok: false, error: 'DeepL: bad response' };
  return { ok: true, translations: data.translations.map(t => t.text) };
}

async function handleTranslate(payload) {
  const texts = Array.isArray(payload?.texts) ? payload.texts : null;
  if (!texts || !texts.length) return { ok: false, error: 'no-texts' };
  const { mtApiKey } = await chrome.storage.local.get(['mtApiKey']);
  // Strip ALL whitespace (paste artifacts: stray spaces/newlines).  An embedded
  // newline in the key would otherwise throw "Invalid header value" from fetch
  // and surface to the user as a confusing 'fetch-failed' rather than 'no-key'.
  const key = String(mtApiKey || '').replace(/\s+/g, '');
  if (!key) return { ok: false, error: 'no-key' };
  try {
    const out = await deeplTranslate(key, texts, payload.source || '', payload.target || 'ja-JP');
    if (out.ok && out.translations.length !== texts.length) {
      console.warn('[Better Subs] translate count mismatch:', texts.length, '→', out.translations.length);
      return { ok: false, error: 'count-mismatch' };
    }
    if (!out.ok) console.warn('[Better Subs] translate error:', out.error);
    return out;
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    console.warn('[Better Subs] translate fetch threw:', e && e.message);
    return { ok: false, error: timedOut ? 'timeout' : 'fetch-failed: ' + (e && e.message) };
  }
}

// ── Keyboard shortcut → active tab relay ──────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-jp-cc') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: MSG.TOGGLE_JP_CC }).catch(() => {});
  }
});

// ── Badge updates from content script ─────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== MSG.SET_BADGE || !sender.tab?.id) return;
  const tabId = sender.tab.id;
  chrome.action.setBadgeText({ text: msg.active ? 'ON' : '', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#ff6b35', tabId });
});

// ── Machine-translation requests from content script ──────────────────────
// Only our own content scripts can reach the SW (no externally_connectable),
// so sender.id is implicitly this extension.  Returns true to keep the async
// sendResponse channel open while the provider fetch is in flight.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || msg.type !== MSG.MT_TRANSLATE) return;
  handleTranslate(msg.payload).then(sendResponse).catch(e =>
    sendResponse({ ok: false, error: 'handler: ' + (e && e.message) }));
  return true;
});
