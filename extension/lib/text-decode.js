/**
 * lib/text-decode.js — decode subtitle bytes whose encoding nobody declared.
 *
 * Polish fansubs on AnimeSub come as UTF-8 (often with a BOM), Windows-1250 or
 * ISO-8859-2.  Neither legacy charset can be rejected by a decoder: every byte
 * maps to *something* in ISO-8859-2 (0x80–0x9F are invisible C1 controls), so a
 * CP1250 file "decodes fine" as ISO and shows ś/ź/ą as garbage.  Order:
 *   1. BOM            → UTF-8 / UTF-16LE / UTF-16BE
 *   2. strict UTF-8   → UTF-8 if it validates and has any multibyte sequence
 *   3. byte statistics on the letters where the two charsets DIFFER
 *      (pickLegacyEncoding).  ę ł ó ż ć ń Ł Ż Ó have the same byte in both, so
 *      they carry no signal.
 *
 * Pure — no DOM.
 *
 * Public surface:
 *   CRSubFix.textDecode.decodeSubtitleBytes(u8) → { text, encoding }
 *   CRSubFix.textDecode.pickLegacyEncoding(u8)  → 'windows-1250' | 'iso-8859-2'
 */
(function () {
  'use strict';

  const NS = (typeof self !== 'undefined' ? self : globalThis);
  NS.CRSubFix = NS.CRSubFix || {};

  // Bytes of the letters that differ between the two charsets:
  //                 ą     ś     ź     Ą     Ś     Ź
  const CP1250_ONLY = [0xb9, 0x9c, 0x9f, 0xa5, 0x8c, 0x8f];
  const ISO2_ONLY   = [0xb1, 0xb6, 0xbc, 0xa1, 0xa6, 0xac];

  function pickLegacyEncoding(u8) {
    let cp = 0, iso = 0;
    for (const b of u8) {
      if (CP1250_ONLY.includes(b)) cp++;
      else if (ISO2_ONLY.includes(b)) iso++;
    }
    return iso > cp ? 'iso-8859-2' : 'windows-1250';
  }

  function decodeSubtitleBytes(u8) {
    if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
      return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: 'utf-8' };
    }
    if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) {
      return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), encoding: 'utf-16le' };
    }
    if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) {
      return { text: new TextDecoder('utf-16be').decode(u8.subarray(2)), encoding: 'utf-16be' };
    }
    const hasHigh = u8.some(b => b >= 0x80);
    if (!hasHigh) return { text: new TextDecoder('utf-8').decode(u8), encoding: 'ascii' };
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'utf-8' };
    } catch (_) { /* not UTF-8 — fall through to the legacy charsets */ }
    const encoding = pickLegacyEncoding(u8);
    return { text: new TextDecoder(encoding).decode(u8), encoding };
  }

  NS.CRSubFix.textDecode = { decodeSubtitleBytes, pickLegacyEncoding };
})();
