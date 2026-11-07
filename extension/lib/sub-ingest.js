/**
 * lib/sub-ingest.js — one path from "some bytes with a file name" to subtitle
 * text the Better Subs parser understands.  Shared by every external source:
 * a file picked from disk / dropped on the player, an AnimeSub download and a
 * Discord attachment.
 *
 *   bytes ─► ZIP? ─► list subtitle-like entries (user picks if more than one)
 *         └► single file
 *   entry bytes ─► textDecode (UTF-8 / CP1250 / ISO-8859-2)
 *               ─► legacySubs (TMPlayer / MicroDVD / MPL2 → SRT) when needed
 *               ─► { text, parseName } ready for customSource.makeLocalSource
 *
 * Pure — no DOM, no fetch.  Depends on zipRead, textDecode, legacySubs.
 *
 * Public surface:
 *   CRSubFix.subIngest.isZip(u8)                          → boolean
 *   CRSubFix.subIngest.candidatesFrom(u8, name)           → Promise<Candidate[]>
 *       Candidate = { name, size, load: () => Promise<Uint8Array> }
 *       [] when an archive holds no subtitle-like file.
 *   CRSubFix.subIngest.toSubtitleText(u8, name, { fps }?) → { text, parseName, encoding, format }
 *       parseName is the name to hand the parser (legacy formats get ".srt").
 *   CRSubFix.subIngest.SUB_EXT                            — accepted extensions
 */
(function () {
  'use strict';

  const NS = (typeof self !== 'undefined' ? self : globalThis);
  if (!NS.CRSubFix || !NS.CRSubFix.zipRead || !NS.CRSubFix.textDecode || !NS.CRSubFix.legacySubs) return;
  const { zipRead, textDecode, legacySubs } = NS.CRSubFix;

  const SUB_EXT = ['ass', 'ssa', 'srt', 'vtt', 'txt', 'sub', 'mpl'];
  const RE_SUB  = new RegExp(`\\.(?:${SUB_EXT.join('|')})$`, 'i');

  function isZip(u8) {
    return u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;
  }

  function baseName(path) { return String(path).split('/').pop(); }

  async function candidatesFrom(u8, name) {
    if (!isZip(u8)) return [{ name: baseName(name), size: u8.length, load: async () => u8 }];
    return zipRead.listEntries(u8)
      // macOS archive litter and anything that is not a subtitle-like file.
      .filter(e => !/(^|\/)__MACOSX\//.test(e.name) && !/(^|\/)\._/.test(e.name))
      .filter(e => RE_SUB.test(e.name))
      // Uploaders often add a readme.txt next to the subs; real subtitle files
      // first, then by name so episode numbers sort naturally.
      .sort((a, b) => (/readme|info|nfo/i.test(a.name) - /readme|info|nfo/i.test(b.name))
        || a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map(e => ({ name: baseName(e.name), size: e.size, load: () => zipRead.extract(u8, e) }));
  }

  function toSubtitleText(u8, name, opts = {}) {
    const { text, encoding } = textDecode.decodeSubtitleBytes(u8);
    const legacy = legacySubs.toSrt(text, { fps: opts.fps });
    if (legacy) {
      return {
        text: legacy.srt,
        parseName: baseName(name).replace(/\.[^.]*$/, '') + '.srt',
        encoding,
        format: legacy.format,
        fps: legacy.fps,
      };
    }
    const ext = (/\.([^.]+)$/.exec(name) || [])[1];
    return { text, parseName: baseName(name), encoding, format: ext ? ext.toLowerCase() : 'unknown' };
  }

  NS.CRSubFix.subIngest = { isZip, candidatesFrom, toSubtitleText, SUB_EXT };
})();
