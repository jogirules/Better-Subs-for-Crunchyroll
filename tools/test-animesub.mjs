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
const FXJ = (n) => JSON.parse(readFileSync(join(ROOT, 'tools/fixtures/animesub', n), 'utf8'));
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
  'extension/lib/title-map.js',
  'extension/lib/vendor/aes.js',
  'extension/lib/mega.js',
  'extension/lib/font-names.js',
]) load(p);
const { animesub: AS, zipRead: ZIP, legacySubs: LEG, textDecode: TD, customSource: CUSTOM, subIngest: ING, titleMap: TM } = globalThis.CRSubFix;
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

// ── Title mapping: CR episode → AniList romaji ────────────────────────────
section('title map');
{
  const meta = TM.metaFromCms(FXJ('cr-cms-kusuriya-e53.json'));
  eq('cms meta', [meta.seriesTitle, meta.seasonNumber, meta.episodeAbs, meta.episodeInSeason, meta.airDate],
    ['The Apothecary Diaries', 3, 53, 5, '2026-10-30']);
  eq('in-season number wins', TM.episodeForQuery(meta), 5);
  eq('absolute number as fallback', TM.episodeForQuery({ episodeAbs: 53, episodeInSeason: null }), 53);
  eq('metaFromCms on junk', TM.metaFromCms({ data: [] }), null);
  eq('slugToTitle', TM.slugToTitle('the-apothecary-diaries'), 'the apothecary diaries');
  eq('fuzzyDate full', TM.fuzzyDate({ year: 2026, month: 10, day: 2 }), '2026-10-02');
  eq('fuzzyDate partial', TM.fuzzyDate({ year: 2027, month: 4, day: null }), '2027-04-01');
  eq('fuzzyDate empty', TM.fuzzyDate({ year: null }), null);
  ok('anilistBody is JSON with the search', JSON.parse(TM.anilistBody('Frieren')).variables.s === 'Frieren');

  const ku = FXJ('anilist-kusuriya.json'), fr = FXJ('anilist-frieren.json');
  const pick = (m, o) => TM.pickMedia(m, o)?.title?.romaji ?? null;
  eq('Kusuriya S3 by air date', pick(ku, { seasonNumber: 3, airDate: '2026-10-30' }), 'Kusuriya no Hitorigoto 3rd Season');
  eq('Kusuriya S2 by air date', pick(ku, { seasonNumber: 2, airDate: '2025-02-14' }), 'Kusuriya no Hitorigoto 2nd Season');
  eq('Kusuriya S1, no date', pick(ku, { seasonNumber: 1, airDate: null }), 'Kusuriya no Hitorigoto');
  eq('Kusuriya S3, no date', pick(ku, { seasonNumber: 3, airDate: null }), 'Kusuriya no Hitorigoto 3rd Season');
  eq('Frieren S2 (ONA mini-shorts ignored)', pick(fr, { seasonNumber: 2, airDate: '2026-01-16' }), 'Sousou no Frieren 2nd Season');
  eq('no season, no date → first TV', pick(fr, {}), 'Sousou no Frieren');
  // CR season numbers are not AniList seasons: Spy x Family CR "Season 1" holds
  // both AniList cours; Black Clover's CR "Season 2" has season_number 6.
  const tv = (romaji, s, e) => ({ format: 'TV', title: { romaji }, startDate: s, endDate: e });
  const D = (y, m, d) => ({ year: y, month: m, day: d });
  const spy = [tv('SPY×FAMILY', D(2022, 4, 9), D(2022, 6, 25)), tv('SPY×FAMILY Part 2', D(2022, 10, 1), D(2022, 12, 24)),
               tv('SPY×FAMILY Season 2', D(2023, 10, 7), D(2023, 12, 23))];
  eq('date beats CR season number (split cour)', pick(spy, { seasonNumber: 1, airDate: '2022-10-01' }), 'SPY×FAMILY Part 2');
  const bc = [tv('Black Clover', D(2017, 10, 3), D(2021, 3, 30)), tv('Black Clover (2026)', D(2026, 10, 3), D(null))];
  eq('date beats CR season number 6', pick(bc, { seasonNumber: 6, airDate: '2026-11-07' }), 'Black Clover (2026)');
  eq('empty results', TM.pickMedia([], { seasonNumber: 1 }), null);
  // Candidate queries — cases checked live against CR / AniList / AnimeSub (2026-11-07).
  const cq = (o) => TM.candidateQueries(o).map((c) => c.query);
  eq('Kusuriya S3 E53 (in-season numbering)', cq({
    entry: { romaji: 'Kusuriya no Hitorigoto 3rd Season', startDate: '2026-10-02' },
    first: { romaji: 'Kusuriya no Hitorigoto', startDate: '2023-10-22' },
    meta: { episodeInSeason: 5, episodeAbs: 53, airDate: '2026-10-30' } }),
    ['Kusuriya no Hitorigoto 3rd Season ep05', 'Kusuriya no Hitorigoto ep53', 'Kusuriya no Hitorigoto 3rd Season']);
  eq('Black Clover "Part 2" E52 (absolute inside one AniList entry)', cq({
    entry: { romaji: 'Black Clover', startDate: '2017-10-03' }, first: { romaji: 'Black Clover', startDate: '2017-10-03' },
    meta: { episodeInSeason: 1, episodeAbs: 52, airDate: '2018-10-02' } }),
    ['Black Clover ep52', 'Black Clover ep01', 'Black Clover']);
  eq('Spy x Family E13 (split cour, × normalized)', cq({
    entry: { romaji: 'SPY×FAMILY Part 2', startDate: '2022-10-01' }, first: { romaji: 'SPY×FAMILY', startDate: '2022-04-09' },
    meta: { episodeInSeason: 13, episodeAbs: 13, airDate: '2022-10-01' } }),
    ['SPY x FAMILY Part 2 ep13', 'SPY x FAMILY ep13', 'SPY x FAMILY Part 2']);
  eq('no AniList match → CR title only', cq({ entry: { romaji: 'Some Show', startDate: null }, first: null,
    meta: { episodeInSeason: 3, episodeAbs: 3, airDate: null } }), ['Some Show ep03', 'Some Show']);
  ok('resultsMatch: real hit', TM.resultsMatch([{ titleOrg: 'Spy x Family ep13' }], 'SPY x FAMILY'));
  ok('resultsMatch: unrelated epNN is not a hit', !TM.resultsMatch([{ titleOrg: '.hack//Roots ep13' }, { titleOrg: '11eyes OVA ep13' }], 'SPY x FAMILY'));
  // Live AnimeSub response for "Kusuriya no Hitorigoto 3rd Season ep05": loose search, S2 files too.
  const kuRes = [{ titleOrg: 'Kusuriya no Hitorigoto Season 2 ep05' }, { titleOrg: 'Kusuriya no Hitorigoto 2nd Season ep05' }];
  ok('resultsMatch: other season is not a hit', !TM.resultsMatch(kuRes, 'Kusuriya no Hitorigoto 3rd Season'));
  ok('resultsMatch: "Season 3" = "3rd Season"', TM.resultsMatch([...kuRes, { titleOrg: 'Kusuriya no Hitorigoto Season 3 ep05' }], 'Kusuriya no Hitorigoto 3rd Season'));
  eq('firstTv', TM.firstTv(fr)?.title?.romaji, 'Sousou no Frieren');
  const q = AS.buildQuery(pick(ku, { seasonNumber: 3, airDate: meta.airDate }), TM.episodeForQuery(meta));
  eq('end to end query', q, 'Kusuriya no Hitorigoto 3rd Season ep05');
}

// ── MEGA group folders: link parsing, listing decryption, search ───────────
// Synthetic folder (own random keys) encrypted the way MEGA does it.
section('mega');
{
  const MG = globalThis.CRSubFix.mega, aesjs = globalThis.aesjs;
  eq('folder link', MG.parseFolderLink('https://mega.nz/folder/KQ00iCLb#0jW1zZcli8N-EUtbZszXYw'), { handle: 'KQ00iCLb', keyB64: '0jW1zZcli8N-EUtbZszXYw' });
  eq('legacy link', MG.parseFolderLink('https://mega.nz/#F!U3ZBTZoZ!wJZumsXp5bzLXc6Hef5PXQ')?.handle, 'U3ZBTZoZ');
  eq('bad link', MG.parseFolderLink('https://mega.nz/file/abc'), null);

  const rnd = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + seed * 11 + 5) & 255);
  const b64url = (u8) => MG.b64Encode(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fk = rnd(16, 1);
  const enc = (key, name) => {
    const t = new TextEncoder().encode('MEGA' + JSON.stringify({ n: name }));
    const pad = new Uint8Array(Math.ceil(t.length / 16) * 16); pad.set(t);
    return b64url(new aesjs.ModeOfOperation.cbc(key, new Uint8Array(16)).encrypt(pad));
  };
  const nodeKey = (k) => b64url(new aesjs.ModeOfOperation.ecb(fk).encrypt(k));
  const nodes = [];
  const dir = (h, p, name, seed) => { const k = rnd(16, seed); nodes.push({ h, p, t: 1, a: enc(k, name), k: `${'ROOT0000'}:${nodeKey(k)}` }); };
  const file = (h, p, name, seed, s = 1000) => {
    const k = rnd(32, seed);
    // A second, foreign key part first — must be skipped.
    nodes.push({ h, p, t: 0, s, a: enc(MG.fileAesKey(k), name), k: `OTHER000:${nodeKey(rnd(32, seed + 50))}/ROOT0000:${nodeKey(k)}` });
  };
  dir('R', '', 'SUBY', 2); dir('K', 'R', 'K', 3); dir('K3', 'K', 'Kusuriya no Hitorigoto Season 3', 4); dir('K1', 'K', 'Kusuriya no Hitorigoto', 5);
  dir('F', 'K3', 'Czcionki', 6);
  file('f1', 'K3', '[FrixySubs] Kusuriya no Hitorigoto - S03E05 (53).ass', 7);
  file('f2', 'K3', '[FrixySubs] Kusuriya no Hitorigoto - S03E06 (54).ass', 8);
  file('f3', 'K1', 'Kusuriya_no_Hitorigoto_05_1080p.ass', 9);
  file('f4', 'K1', 'Kusuriya_no_Hitorigoto_2023_720p_x265.srt', 10);
  file('f5', 'F', 'Arial.ttf', 11);
  const listed = MG.decryptListing({ f: nodes }, b64url(fk));
  eq('all nodes decrypted', listed.length, nodes.length);
  const idx = MG.buildIndex(listed);
  eq('index = subtitle files only', idx.map((f) => f.h), ['f1', 'f2', 'f3', 'f4']);
  eq('index path', idx[0].dir, 'SUBY/K/Kusuriya no Hitorigoto Season 3');

  eq('episode numbers S03E05 (53)', [...MG.episodeNumbers('[FrixySubs] Kusuriya no Hitorigoto - S03E05 (53).ass')].sort((a, b) => a - b), [5, 53]);
  eq('episode numbers skip 1080p/2023/x265', [...MG.episodeNumbers('Kusuriya_no_Hitorigoto_2023_720p_x265.srt')], []);
  const names = (r) => r.map((f) => f.h);
  eq('season 3 ep 5', names(MG.search(idx, { title: 'Kusuriya no Hitorigoto 3rd Season', episodes: [5, 53] })), ['f1']);
  eq('season 3 abs 54 only', names(MG.search(idx, { title: 'Kusuriya no Hitorigoto Season 3', episodes: [54] })), ['f2']);
  eq('season 1 excludes season 3 folder', names(MG.search(idx, { title: 'Kusuriya no Hitorigoto', episodes: [5] })), ['f3']);
  eq('no episodes = whole season', names(MG.search(idx, { title: 'kusuriya no hitorigoto s3' })), ['f1', 'f2']);
  eq('unknown title', MG.search(idx, { title: 'Frieren', episodes: [1] }).length, 0);
  // Shisha-style layout: roman season numerals, shortened titles.
  const sh = [
    { h: 's1', dir: 'Suby/Mushoku Tensei/Mushoku Tensei III', name: '[shisha] Mushoku Tensei III - 08.ass' },
    { h: 's2', dir: 'Suby/Mushoku Tensei/Mushoku Tensei II', name: '[shisha] Mushoku Tensei II - 08.ass' },
    { h: 's3', dir: 'Suby/Spy x Family', name: '[shisha] Spy x Family - 08.ass' },
    { h: 's4', dir: 'Suby/Re：Zero kara Hajimeru Isekai Seikatsu/Re：Zero kara Hajimeru Isekai Seikatsu IV', name: '[shisha] Re Zero IV - 03.ass' },
  ];
  eq('roman III + shortened title', names(MG.search(sh, { title: 'Mushoku Tensei: Isekai Ittara Honki Dasu Season 3', episodes: [8] })), ['s1']);
  eq('roman II', names(MG.search(sh, { title: 'Mushoku Tensei: Isekai Ittara Honki Dasu 2nd Season', episodes: [8] })), ['s2']);
  eq('x is not a numeral', names(MG.search(sh, { title: 'SPY x FAMILY', episodes: [8] })), ['s3']);
  eq('full-width colon, 4th season', names(MG.search(sh, { title: 'Re:Zero kara Hajimeru Isekai Seikatsu 4th Season', episodes: [3] })), ['s4']);
  eq('tie-break by folder order', names(MG.search([{ h: 'b', dir: 'A', name: 'Spy x Family - 08.ass', order: 1 }, { h: 'a', dir: 'B', name: 'Spy x Family - 08.ass', order: 0 }], { title: 'Spy x Family', episodes: [8] })), ['a', 'b']);
  eq('series folder: long AniList title', MG.seriesMatches(['Akuyaku Reijou Level 99'], 'Akuyaku Reijou Level 99: Watashi wa Ura-Boss desu ga Maou dewa Arimasen'), true);
  eq('series folder: short query', MG.seriesMatches(['Isekai Nonbiri Nouka'], 'isekai nonbiri nouka 2nd season'), true);
  eq('series folder: other title', MG.seriesMatches(['Isekai Nonbiri Nouka'], 'Kusuriya no Hitorigoto'), false);
  eq('series folder: one shared word', MG.seriesMatches(['Akuyaku Reijou Level 99'], 'Level 99'), false);
  eq('short head not used ("Re")', MG.search(sh, { title: 'Re:Monster', episodes: [3] }).length, 0);

  // File body: AES-CTR under the folded key / nonce (WebCrypto, as in the SW).
  const k32 = Uint8Array.from(atob(idx[0].k), (c) => c.charCodeAt(0));
  const plain = new TextEncoder().encode('[Script Info]\nTitle: Kusuriya 05\n'.repeat(3));
  const key = await crypto.subtle.importKey('raw', MG.fileAesKey(k32), 'AES-CTR', false, ['encrypt', 'decrypt']);
  const algo = { name: 'AES-CTR', counter: MG.fileCtrIv(k32), length: 64 };
  const back = new Uint8Array(await crypto.subtle.decrypt(algo, key, await crypto.subtle.encrypt(algo, key, plain)));
  eq('ctr round trip', new TextDecoder().decode(back), new TextDecoder().decode(plain));
  // aes-js CTR with the same counter must agree with WebCrypto (MEGA's layout).
  const ref = new aesjs.ModeOfOperation.ctr(MG.fileAesKey(k32), new aesjs.Counter(MG.fileCtrIv(k32))).encrypt(plain);
  eq('ctr matches aes-js', MG.b64Encode(new Uint8Array(await crypto.subtle.encrypt(algo, key, plain))), MG.b64Encode(ref));
}

// ── Group fonts ────────────────────────────────────────────────────────────
section('fonts');
{
  const FN = globalThis.CRSubFix.fontNames;
  const MG = globalThis.CRSubFix.mega;
  // Synthetic sfnt: 'name' (ids 1, 4 on Windows; 6 on Mac) + 'OS/2'.
  function sfnt(family, full, ps, weight, italic, magic = 0x00010000) {
    const recs = [[3, 1, 1, family], [3, 1, 4, full], [1, 0, 6, ps]];
    const strs = recs.map(([p, , , t]) => p === 3
      ? Uint8Array.from([...t].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255]))
      : Uint8Array.from([...t].map((c) => c.charCodeAt(0))));
    const nameLen = 6 + recs.length * 12 + strs.reduce((a, b) => a + b.length, 0);
    const os2Len = 78, off0 = 12 + 2 * 16;
    const buf = new Uint8Array(off0 + nameLen + os2Len), dv = new DataView(buf.buffer);
    dv.setUint32(0, magic); dv.setUint16(4, 2);
    const tbl = (i, tag, off, len) => { for (let j = 0; j < 4; j++) buf[12 + i * 16 + j] = tag.charCodeAt(j); dv.setUint32(12 + i * 16 + 8, off); dv.setUint32(12 + i * 16 + 12, len); };
    tbl(0, 'OS/2', off0 + nameLen, os2Len); tbl(1, 'name', off0, nameLen);
    let o = off0; dv.setUint16(o + 2, recs.length); dv.setUint16(o + 4, 6 + recs.length * 12);
    let so = 0;
    recs.forEach(([p, e, id], i) => { const r = o + 6 + i * 12; dv.setUint16(r, p); dv.setUint16(r + 2, e); dv.setUint16(r + 6, id); dv.setUint16(r + 8, strs[i].length); dv.setUint16(r + 10, so); buf.set(strs[i], o + 6 + recs.length * 12 + so); so += strs[i].length; });
    dv.setUint16(off0 + nameLen + 4, weight); dv.setUint16(off0 + nameLen + 62, italic ? 1 : 0);
    return buf;
  }
  const faces = FN.parseFontFaces(sfnt('Gandhi Sans', 'Gandhi Sans Bold Italic', 'GandhiSans-BoldItalic', 700, true));
  eq('ttf names', faces[0] && faces[0].names, ['gandhi sans', 'gandhi sans bold italic', 'gandhisans-bolditalic']);
  eq('ttf weight/italic', faces[0] && [faces[0].weight, faces[0].italic], [700, true]);
  eq('otf magic', FN.parseFontFaces(sfnt('A', 'A', 'A', 400, false, 0x4f54544f)).length, 1);
  {
    const a = sfnt('One', 'One', 'One', 400, false), b = sfnt('Two', 'Two Bold', 'Two-Bold', 700, false);
    const ttc = new Uint8Array(20 + a.length + b.length), dv = new DataView(ttc.buffer);
    dv.setUint32(0, 0x74746366); dv.setUint32(8, 2); dv.setUint32(12, 20); dv.setUint32(16, 20 + a.length);
    // Table offsets inside a TTC are file-relative: shift them.
    const shift = (f, by) => { const c = f.slice(), d = new DataView(c.buffer); for (let i = 0; i < 2; i++) d.setUint32(12 + i * 16 + 8, d.getUint32(12 + i * 16 + 8) + by); return c; };
    ttc.set(shift(a, 20), 20); ttc.set(shift(b, 20 + a.length), 20 + a.length);
    eq('ttc faces', FN.parseFontFaces(ttc).map((f) => f.names[0]), ['one', 'two']);
  }
  eq('not a font', FN.parseFontFaces(new TextEncoder().encode('[Script Info]\nTitle: x')), []);
  eq('norm @vertical', FN.normFontName('@MS  Gothic '), 'ms gothic');

  eq('fontBase Czcionki', MG.fontBase('SUBY/F/Fumetsu/Czcionki'), 'SUBY/F/Fumetsu');
  eq('fontBase "X Fonty"', MG.fontBase('Suby/Darling/Darling in the FranXX Fonty'), 'Suby/Darling');
  eq('fontBase loose', MG.fontBase('Suby/Rakudai'), 'Suby/Rakudai');
  const fonts = [
    { h: 'a', dir: 'SUBY/F/Fumetsu/Czcionki', name: 'a.ttf' },
    { h: 'b', dir: 'SUBY/F/Fumetsu 2/Czcionki', name: 'b.ttf' },
    { h: 'c', dir: 'SUBY/Fonty', name: 'c.ttf' },
  ];
  const subs = [{ dir: 'SUBY/F/Fumetsu' }, { dir: 'SUBY/F/Fumetsu 2/BD' }];
  eq('fontsForDir series', MG.fontsForDir(fonts, subs, 'SUBY/F/Fumetsu').map((f) => f.h), ['a']);
  eq('fontsForDir deeper sub', MG.fontsForDir(fonts, subs, 'SUBY/F/Fumetsu 2/BD').map((f) => f.h), ['b']);
  eq('fontsForDir no prefix clash', MG.fontsForDir(fonts.slice(0, 1), subs, 'SUBY/F/Fumetsu 2/BD').map((f) => f.h), []);
  const many = Array.from({ length: 50 }, (_, i) => ({ dir: 'SUBY/X/S' + i }));
  eq('fontsForDir group root skipped', MG.fontsForDir(fonts, many, 'SUBY/X/S3').map((f) => f.h), []);
  const tf = [
    { h: '1', dir: 'Suby/Overlord/Czcionki', name: 'x.ttf' },
    { h: '4', dir: 'Suby/Overlord IV/Czcionki', name: 'y.ttf' },
    { h: 'k', dir: 'Suby/Kingdom/Czcionki', name: 'z.ttf' },
  ];
  eq('fontBasesForTitle season first', MG.fontBasesForTitle(tf, 'Overlord IV').map((b) => b.base), ['Suby/Overlord IV', 'Suby/Overlord']);
  eq('fontBasesForTitle s1', MG.fontBasesForTitle(tf, 'Overlord')[0].base, 'Suby/Overlord');
  eq('hint exact', MG.fontFileHint('GandhiSans.otf', ['gandhi sans']), 3);
  eq('hint prefix', MG.fontFileHint('GandhiSans-Bold.otf', ['gandhi sans']), 2);
  eq('hint none', MG.fontFileHint('Arimo.ttf', ['gandhi sans']), 0);
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
