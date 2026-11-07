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

importScripts('lib/protocol.js', 'lib/animesub.js');
const { MSG } = self.CRSubFix.protocol;
const AS = self.CRSubFix.animesub;

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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  const fn = msg.type === MSG.AS_SEARCH ? animesubSearch : msg.type === MSG.AS_DOWNLOAD ? animesubDownload : null;
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
