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

importScripts('lib/protocol.js', 'lib/animesub.js', 'lib/title-map.js', 'lib/vendor/aes.js', 'lib/mega.js');
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

async function megaIndex(folder, refresh) {
  const key = MEGA_INDEX_PREFIX + folder.handle;
  if (!refresh) {
    const { [key]: hit } = await chrome.storage.local.get(key);
    if (hit && Date.now() - hit.at < MEGA_INDEX_TTL_MS) return hit.files;
  }
  const listing = await megaApi(folder.handle, { a: 'f', c: 1, ca: 1, r: 1 });
  const files = MEGA.buildIndex(MEGA.decryptListing(listing, folder.keyB64));
  await chrome.storage.local.set({ [key]: { at: Date.now(), files } });
  return files;
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
  const g = await megaApi(folder.handle, { a: 'g', g: 1, ssl: 1, n: file.h });
  if (!g || !g.g) return { ok: false, error: 'no-download-url' };
  const resp = await fetch(g.g, { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) return { ok: false, error: 'MEGA HTTP ' + resp.status };
  const enc = new Uint8Array(await resp.arrayBuffer());
  const k32 = Uint8Array.from(atob(file.k), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', MEGA.fileAesKey(k32), 'AES-CTR', false, ['decrypt']);
  const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CTR', counter: MEGA.fileCtrIv(k32), length: 64 }, key, enc));
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
           : msg.type === MSG.MEGA_FOLDERS ? megaFoldersMsg : null;
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
