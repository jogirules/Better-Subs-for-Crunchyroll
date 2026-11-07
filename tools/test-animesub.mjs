/**
 * tools/test-animesub.mjs — dependency-free tests for the AnimeSub source:
 * search-page parsing, query encoding, ZIP extraction (stored / deflate /
 * LZMA), text-encoding detection and the legacy-format → SRT converters, plus
 * one end-to-end pass into CRSubFix.customSource.makeLocalSource.
 *
 * Fixtures live in tools/fixtures/animesub/.  Search pages are trimmed real
 * responses (2026-11-07); subtitle texts and archives are synthetic.
 *
 * Run:  node tools/test-animesub.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FX = (n) => new Uint8Array(readFileSync(join(ROOT, 'tools/fixtures/animesub', n)));
const load = (p) => (0, eval)(readFileSync(join(ROOT, p), 'utf8'));

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push(name); } }
function eq(name, got, want) {
  ok(`${name} — got ${JSON.stringify(got)}`, JSON.stringify(got) === JSON.stringify(want));
}
function section(s) { console.log(`\n— ${s}`); }

for (const p of [
  'extension/lib/vendor/lzma-d.js',
  'extension/lib/zip-read.js',
  'extension/lib/animesub.js',
  'extension/lib/legacy-subs.js',
  'extension/lib/text-decode.js',
  'extension/lib/subtitle-parser.js',
  'extension/lib/sign-track.js',
  'extension/lib/custom-source.js',
  'extension/lib/sub-ingest.js',
]) load(p);
const { animesub: AS, zipRead: ZIP, legacySubs: LEG, textDecode: TD, customSource: CUSTOM, subIngest: ING } = globalThis.CRSubFix;
const iso2 = (u8) => new TextDecoder('iso-8859-2').decode(u8);
const PL = 'ąęłóśźżćńĄĘŁÓŚŹŻĆŃ';

// ── Query building ─────────────────────────────────────────────────────────
section('query');
eq('buildQuery pads episode', AS.buildQuery('Sousou no Frieren', 5), 'Sousou no Frieren ep05');
eq('buildQuery keeps 3 digits', AS.buildQuery('One Piece', 1120), 'One Piece ep1120');
eq('buildQuery without episode', AS.buildQuery('  Frieren ', null), 'Frieren');
eq('searchUrl', AS.searchUrl({ query: 'Sousou no Frieren ep01', titleType: 'org' }),
  'http://animesub.info/szukaj.php?szukane=Sousou+no+Frieren+ep01&pTitle=org');
eq('searchUrl page + bad type', AS.searchUrl({ query: 'x', titleType: 'zz', page: 2 }),
  'http://animesub.info/szukaj.php?szukane=x&pTitle=org&od=2');
eq('query is ISO-8859-2 percent-encoded', AS.searchQueryParams('Pamiętnik ŻÓŁW'), 'Pami%EAtnik+%AF%D3%A3W');
eq('non-Latin-2 characters dropped', AS.searchQueryParams('薬屋 Kusuriya'), '+Kusuriya');
eq('downloadBody', AS.downloadBody('79471', 'abc123'), 'id=79471&sh=abc123&single_file=Pobierz+napisy');

// ── Search page parsing ────────────────────────────────────────────────────
section('parseSearch');
{
  const { results, tokens, hasNext } = AS.parseSearch(iso2(FX('search-results.html')));
  eq('result count', results.length, 4);
  eq('hasNext', hasNext, true);
  eq('token count matches', Object.keys(tokens).length, 4);
  const [a] = results;
  eq('first id', a.id, '79471');
  eq('first titleOrg', a.titleOrg, 'Sousou no Frieren ep01');
  eq('first episode', a.episode, '1');
  eq('first format', a.format, 'Advanced SSA');
  eq('first date', a.date, '2023.10.01');
  ok('first titleEn non-empty', a.titleEn.length > 0);
  ok('first uploader non-empty', a.uploader.length > 0);
  ok('first size like 12kB', /^\d+kB$/.test(a.size));
  ok('downloads numeric', Number.isInteger(a.downloads) && a.downloads > 0);
  ok('sh is 40 hex', /^[0-9a-f]{40}$/.test(tokens[a.id]));
  const h = results.find(r => r.id === '773');
  ok('Hotaru TMPlayer present', !!h);
  if (h) {
    eq('Hotaru format', h.format, 'TMPlayer');
    eq('Hotaru author', h.author, 'Flix');
    ok('Hotaru description keeps release info', /681 661 952/.test(h.description));
    eq('Hotaru titleAlt', h.titleAlt, 'Grobowiec swietlikow');
    eq('Hotaru episode (movie)', h.episode, null);
  }
  ok('no field leaks raw HTML', results.every(r => Object.values(r).every(v => typeof v !== 'string' || !/[<>]/.test(v))));
}
{
  const empty = AS.parseSearch(iso2(FX('search-empty.html')));
  eq('empty page → no results', empty.results.length, 0);
  eq('empty page → no next', empty.hasNext, false);
}
ok('security error page detected', AS.isSecurityError(iso2(FX('download-security-error.html'))));
ok('search page is not a security error', !AS.isSecurityError(iso2(FX('search-results.html'))));

// ── ZIP ────────────────────────────────────────────────────────────────────
section('zip');
for (const kind of ['stored', 'deflate', 'lzma']) {
  const u8 = FX(`archive-${kind}.zip`);
  const entries = ZIP.listEntries(u8);
  eq(`${kind}: entry names`, entries.map(e => e.name), ['[Grupa] Seria 01.ass', 'readme.txt']);
  const bytes = await ZIP.extract(u8, entries[0]);
  const { text, encoding } = TD.decodeSubtitleBytes(bytes);
  eq(`${kind}: decoded as`, encoding, 'utf-8');
  ok(`${kind}: Polish letters intact`, text.includes('Zażółć gęślą jaźń') && text.includes('ŹDŹBŁO'));
}
{
  let threw = false;
  try { ZIP.listEntries(FX('download-security-error.html')); } catch (_) { threw = true; }
  ok('HTML is rejected as non-ZIP', threw);
}

// ── Text encoding ──────────────────────────────────────────────────────────
section('encoding');
{
  const want = 'Zażółć gęślą jaźń';
  const cp = TD.decodeSubtitleBytes(FX('tmplayer-cp1250.txt'));
  eq('cp1250 detected', cp.encoding, 'windows-1250');
  ok('cp1250 text correct', cp.text.includes(want) && cp.text.includes('ŹDŹBŁO, ŚWIĘTY, ĄCZKA'));
  const iso = TD.decodeSubtitleBytes(FX('tmplayer-iso88592.txt'));
  eq('iso-8859-2 detected', iso.encoding, 'iso-8859-2');
  ok('iso text correct', iso.text.includes(want) && iso.text.includes('ŹDŹBŁO, ŚWIĘTY, ĄCZKA'));
  const u = TD.decodeSubtitleBytes(FX('sample-utf8bom.ass'));
  eq('utf-8 BOM detected', u.encoding, 'utf-8');
  ok('BOM stripped', u.text.startsWith('[Script Info]'));
  eq('plain utf-8 without BOM', TD.decodeSubtitleBytes(new TextEncoder().encode(PL)).text, PL);
  eq('pure ASCII', TD.decodeSubtitleBytes(new TextEncoder().encode('abc')).encoding, 'ascii');
  // A file with only shared letters (ł ó ż …) is identical in both charsets,
  // so either answer must produce the same text.
  const shared = new Uint8Array([0xb3, 0xf3, 0xbf, 0xe6, 0xf1, 0xea]);   // ł ó ż ć ń ę
  eq('shared-only letters decode the same', TD.decodeSubtitleBytes(shared).text, 'łóżćńę');
}

// ── Legacy formats ─────────────────────────────────────────────────────────
section('legacy formats');
{
  const tmp = TD.decodeSubtitleBytes(FX('tmplayer-cp1250.txt')).text;
  eq('detect tmplayer', LEG.detect(tmp), 'tmplayer');
  const r = LEG.toSrt(tmp);
  ok('tmplayer → srt', !!r && r.format === 'tmplayer');
  ok('pipe becomes newline', r.srt.includes('Zażółć gęślą jaźń\nŹDŹBŁO'));
  ok('end time = next start', r.srt.includes('00:00:01,000 --> 00:00:04,000'));
  ok('blank line clears: cue 2 ends by reading cap before 9 s', /00:00:04,000 --> 00:00:0[5-8],\d{3}/.test(r.srt));
  const cues = globalThis.CRSubFix.parser.parseSubtitles(r.srt, 'x.srt');
  eq('parser reads converted cues', cues.length, 3);

  const mdvd = TD.decodeSubtitleBytes(FX('microdvd-cp1250.sub')).text;
  eq('detect microdvd', LEG.detect(mdvd), 'microdvd');
  const m = LEG.toSrt(mdvd);
  eq('microdvd fps from {1}{1}', m.fps, 25);
  ok('microdvd frames → time', m.srt.includes('00:00:01,000 --> 00:00:03,000'));
  ok('microdvd style tags stripped', m.srt.includes('Zażółć\ngęślą jaźń') && !m.srt.includes('{y:i}'));
  eq('microdvd fps override', LEG.toSrt(mdvd, { fps: 50 }).fps, 50);

  const mpl = '[10][35]/Kursywa|druga\n[40][]Bez końca\n';
  eq('detect mpl2', LEG.detect(mpl), 'mpl2');
  ok('mpl2 deciseconds', LEG.toSrt(mpl).srt.includes('00:00:01,000 --> 00:00:03,500\nKursywa\ndruga'));
  eq('ASS is not legacy', LEG.detect(TD.decodeSubtitleBytes(FX('sample-utf8bom.ass')).text), null);
}


// ── Shared ingest path ─────────────────────────────────────────────────────
section('sub-ingest');
{
  const zip = FX('archive-deflate.zip');
  ok('isZip on archive', ING.isZip(zip));
  ok('isZip false on text', !ING.isZip(FX('tmplayer-cp1250.txt')));
  const cands = await ING.candidatesFrom(zip, 'paczka.zip');
  eq('archive candidates: subs before readme', cands.map(c => c.name), ['[Grupa] Seria 01.ass', 'readme.txt']);
  const r = ING.toSubtitleText(await cands[0].load(), cands[0].name);
  eq('ass keeps its name', r.parseName, '[Grupa] Seria 01.ass');
  eq('ass format', r.format, 'ass');
  const single = await ING.candidatesFrom(FX('tmplayer-cp1250.txt'), 'dir/Odcinek 05.txt');
  eq('single file → one candidate, base name', single.map(c => c.name), ['Odcinek 05.txt']);
  const t = ING.toSubtitleText(await single[0].load(), single[0].name);
  eq('tmplayer renamed to .srt for the parser', t.parseName, 'Odcinek 05.srt');
  eq('tmplayer encoding', t.encoding, 'windows-1250');
  const rec = CUSTOM.makeLocalSource(t.parseName, t.text);
  ok('tmplayer → record with Polish text', !!rec && rec.srcCues[0].text.includes('Zażółć'));
  const m = ING.toSubtitleText(FX('microdvd-cp1250.sub'), 'x.sub', { fps: 25 });
  eq('microdvd via ingest', [m.format, m.fps], ['microdvd', 25]);
}

// ── End to end: archive → custom source record ─────────────────────────────
section('end to end');
{
  const u8 = FX('archive-lzma.zip');
  const [e] = ZIP.listEntries(u8);
  const { text } = TD.decodeSubtitleBytes(await ZIP.extract(u8, e));
  const rec = CUSTOM.makeLocalSource(e.name, text);
  ok('record built', !!rec);
  eq('record cue count', rec && rec.srcCues.length, 2);
  ok('record cue text Polish', rec && rec.srcCues[1].text.includes('ŚWIĘTY ĄCZKA'));
}

console.log('\n========================================');
console.log(`${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailures:'); for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
console.log('All AnimeSub tests passed.');
