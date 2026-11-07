/**
 * lib/title-map.js — Crunchyroll episode → AnimeSub search query (fork).
 *
 * Crunchyroll shows localized series titles and (for long shows) absolute
 * episode numbers: "Zapiski Zielarki, Sezon 3, E53".  AnimeSub files the same
 * release under the AniList-style romaji title with the in-season number:
 * "Kusuriya no Hitorigoto 3rd Season ep05".  This module bridges the two:
 *
 *   1. metaFromCms(json)   — CR /content/v2/cms/objects/<guid> → episode meta
 *      (sequence_number is the in-season episode; episode_number is absolute).
 *   2. metaFromDom(doc)    — fallback from og:title + the /series/ link slug.
 *   3. anilistBody(search) — GraphQL request body for AniList's search.
 *   4. pickMedia(media, {seasonNumber, airDate}) — which AniList entry is
 *      this CR season (AniList keeps one entry per season).
 *
 * Pure: no fetch, no DOM writes.  Loaded in the MAIN world, the service worker
 * and tools/test-animesub.mjs.
 */
(function () {
  'use strict';

  const NS = (typeof self !== 'undefined' ? self : globalThis);
  NS.CRSubFix = NS.CRSubFix || {};

  const ANILIST_URL = 'https://graphql.anilist.co';

  function int(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }

  // "the-apothecary-diaries" → "the apothecary diaries" (AniList search is
  // case- and punctuation-insensitive, so this is a good-enough English title).
  function slugToTitle(slug) {
    return String(slug || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function metaFromCms(json) {
    const d  = json && Array.isArray(json.data) ? json.data[0] : null;
    const em = d && d.episode_metadata;
    if (!em) return null;
    return {
      seriesTitle:     String(em.series_title || '').trim(),
      seriesSlug:      String(em.series_slug_title || ''),
      seasonNumber:    int(em.season_number) ?? int(em.season_sequence_number),
      episodeAbs:      int(em.episode_number) ?? int(em.episode),
      episodeInSeason: int(em.sequence_number),
      airDate:         String(em.episode_air_date || em.premium_available_date || '').slice(0, 10) || null,
      source:          'cms',
    };
  }

  // og:title is "Sezon 3 | E53 - Nimfa białego węża" (or "Season 3 | E53 - …");
  // the series link is /<lang>/series/<id>/<slug>.  No in-season number here,
  // so the caller falls back to the absolute one.
  function metaFromDom(doc) {
    const og   = doc.querySelector('meta[property="og:title"]')?.content || '';
    const link = doc.querySelector('a[href*="/series/"]');
    const slug = (/\/series\/[^/]+\/([^/?#]+)/.exec(link?.getAttribute('href') || '') || [])[1] || '';
    if (!slug) return null;
    return {
      seriesTitle:     (link?.textContent || '').trim(),
      seriesSlug:      slug,
      seasonNumber:    int((/(\d+)\s*\|/.exec(og) || [])[1]),
      episodeAbs:      int((/\bE(\d+)\b/.exec(og) || [])[1]),
      episodeInSeason: null,
      airDate:         null,
      source:          'dom',
    };
  }

  function anilistBody(search) {
    return JSON.stringify({
      query: 'query($s:String){Page(perPage:15){media(search:$s,type:ANIME){' +
             'id format title{romaji english} startDate{year month day} endDate{year month day}}}}',
      variables: { s: String(search || '').slice(0, 100) },
    });
  }

  // AniList fuzzy date {year, month, day} (any part may be null) → 'YYYY-MM-DD'
  // or null.  Missing month/day are filled to the start of the period.
  function fuzzyDate(fd) {
    if (!fd || !fd.year) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${fd.year}-${p(fd.month || 1)}-${p(fd.day || 1)}`;
  }

  // Choose the AniList entry that matches this Crunchyroll season.
  //   media:        AniList search results — [{ id, format ('TV', 'ONA', 'MOVIE'…),
  //                 title:{romaji, english}, startDate, endDate }]; the dates are
  //                 AniList fuzzy dates — fuzzyDate(m.startDate) → 'YYYY-MM-DD' | null
  //                 (endDate is null-year while a season is still airing)
  //   seasonNumber: CR's season number (1, 2, 3…) or null
  //   airDate:      the episode's air date 'YYYY-MM-DD' or null
  // Returns one media object, or null when nothing fits.
  function pickMedia(media, { seasonNumber, airDate } = {}) {
    // Season entries only: TV first, ONA when a show only exists as ONA.
    const dated = (list) => list.filter((m) => fuzzyDate(m && m.startDate))
      .sort((a, b) => fuzzyDate(a.startDate).localeCompare(fuzzyDate(b.startDate)));
    let cands = dated((media || []).filter((m) => m && (m.format === 'TV' || m.format === 'TV_SHORT')));
    if (!cands.length) cands = dated((media || []).filter((m) => m && m.format === 'ONA'));
    if (!cands.length) return null;
    // Air date first — CR's episode_air_date is the original Japanese airing
    // (verified: Death Note 2006 on CR since 2025), while CR season_number is
    // just its listing order (Black Clover "Season 2" = 6).
    if (airDate) {
      const inRange = cands.filter((m) => {
        const start = fuzzyDate(m.startDate);
        // A partial end date ("2027-04") is filled to the 1st — compare by its
        // precision instead, so the whole month/year counts as inside.
        const e = m.endDate || {};
        const end = !e.year ? null : e.day ? fuzzyDate(e) : e.month ? `${fuzzyDate(e).slice(0, 7)}-31` : `${e.year}-12-31`;
        return start <= airDate && (!end || airDate <= end);
      });
      if (inRange.length) return inRange[inRange.length - 1];   // latest start wins on overlap
      // Aired between cours (no range fits): the closest earlier entry.
      const before = cands.filter((m) => fuzzyDate(m.startDate) <= airDate);
      if (before.length) return before[before.length - 1];
    }
    if (seasonNumber && cands[seasonNumber - 1]) return cands[seasonNumber - 1];
    return cands[0];
  }

  // The in-season number when CR gave one, else the absolute number.
  function episodeForQuery(meta) {
    return meta ? (meta.episodeInSeason ?? meta.episodeAbs ?? null) : null;
  }

  // AnimeSub's search splits on characters like "×" and then matches any
  // "ep13" on the site — so "SPY×FAMILY" must be sent as "SPY x FAMILY".
  function queryTitle(t) {
    return String(t || '').replace(/\s*[×✕]\s*/g, ' x ').replace(/\s+/g, ' ').trim();
  }
  // Uploaders write a season as "3rd Season", "Season 3" or "S3" — fold all
  // to "season3" before comparing, so only the season number has to agree.
  const norm = (t) => queryTitle(t).toLowerCase()
    .replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/g, 'season $1')
    .replace(/\bs(\d+)\b/g, 'season $1')
    .replace(/[^a-z0-9]+/g, '');

  // A search "hit" only counts when a result is actually this title — guards
  // against a broken query matching unrelated "epNN" files.
  function resultsMatch(results, title) {
    const want = norm(title);
    if (!want) return false;
    return (results || []).some((r) => [r.titleOrg, r.titleEn, r.titleAlt].some((x) => norm(x).includes(want)));
  }

  // Earliest TV entry — the base title some groups keep for every cour.
  function firstTv(media) {
    const tv = (media || []).filter((m) => m && (m.format === 'TV' || m.format === 'TV_SHORT') && fuzzyDate(m.startDate));
    tv.sort((a, b) => fuzzyDate(a.startDate).localeCompare(fuzzyDate(b.startDate)));
    return tv[0] || null;
  }

  // Ordered AnimeSub queries to try (the panel stops at the first real hit).
  // AnimeSub numbers episodes the way each group did: in-season (Kusuriya 3rd
  // Season ep05), continuous across a split cour (Spy x Family ep13) or
  // absolute inside one long AniList entry (Black Clover ep52).  CR gives both
  // the in-season (sequence) and absolute number; which one the AniList entry
  // uses is estimated from how many weeks it had been airing by this episode.
  //   entry / first: { romaji, startDate:'YYYY-MM-DD'|null } — the picked AniList
  //   entry and the series' first TV entry (may be the same).
  function candidateQueries({ entry, first, meta }) {
    const AS = NS.CRSubFix.animesub;
    const seq = meta?.episodeInSeason ?? null, abs = meta?.episodeAbs ?? null;
    const t1 = queryTitle(entry?.romaji), t0 = queryTitle(first?.romaji);
    let primary = seq ?? abs, secondary = (seq != null && abs != null && abs !== seq) ? abs : null;
    if (secondary != null && entry?.startDate && meta?.airDate) {
      const weeks = Math.round((Date.parse(meta.airDate) - Date.parse(entry.startDate)) / (7 * 864e5)) + 1;
      if (Math.abs(weeks - abs) < Math.abs(weeks - seq)) [primary, secondary] = [abs, seq];
    }
    const out = [];
    const add = (title, ep) => {
      if (!title) return;
      const q = AS.buildQuery(title, ep);
      if (!out.some((c) => c.query === q)) out.push({ query: q, title });
    };
    add(t1, primary);
    if (t0 && t0 !== t1) add(t0, abs ?? primary); else add(t1, secondary);
    add(t1, null);
    return out.filter((c) => c.title).slice(0, 3);
  }

  NS.CRSubFix.titleMap = {
    ANILIST_URL, slugToTitle, metaFromCms, metaFromDom, anilistBody, fuzzyDate, pickMedia, episodeForQuery,
    queryTitle, resultsMatch, firstTv, candidateQueries,
  };
})();
