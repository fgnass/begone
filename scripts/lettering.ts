// Turns handwritten text into inline SVG at build time.
//
// The few Borel texts in index.html are marked with `data-lettering`. This
// plugin replaces their text with the glyph outlines, so the app needs no web
// font: no flash of the fallback font on the first visit, and ~10 KB instead
// of a 40 KB font. To change a text, edit it in index.html.
//
// Borel joins its letters with contextual alternates (calt), so the text is
// shaped with HarfBuzz, the same engine browsers use.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import * as hb from 'harfbuzzjs';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);
const FONT = require.resolve('@fontsource/borel/files/borel-latin-400-normal.woff');

// One vertical box for all texts, in font units (y down): from the top of the
// ascenders to the bottom of the descenders. Borel's own line box is much
// taller (986 to -1014), which made the text sit high.
const TOP = -990;
const BOTTOM = 530;

/** Unpacks a WOFF 1.0 file into a plain sfnt, which HarfBuzz can read. */
function woffToSfnt(woff: Uint8Array) {
  const v = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (v.getUint32(0) !== 0x774f4646) throw new Error('Not a WOFF file');
  const n = v.getUint16(12);
  const tables = [];
  for (let i = 0; i < n; i++) {
    const e = 44 + i * 20;
    const offset = v.getUint32(e + 4);
    const compLength = v.getUint32(e + 8);
    const origLength = v.getUint32(e + 12);
    const raw = woff.subarray(offset, offset + compLength);
    tables.push({
      tag: v.getUint32(e),
      checksum: v.getUint32(e + 16),
      data: compLength < origLength ? new Uint8Array(inflateSync(raw)) : raw,
    });
  }
  let size = 12 + n * 16;
  for (const t of tables) size += (t.data.length + 3) & ~3;
  const out = new Uint8Array(size);
  const o = new DataView(out.buffer);
  const pow = 2 ** Math.floor(Math.log2(n));
  o.setUint32(0, v.getUint32(4)); // flavor
  o.setUint16(4, n);
  o.setUint16(6, pow * 16);
  o.setUint16(8, Math.log2(pow));
  o.setUint16(10, n * 16 - pow * 16);
  let pos = 12 + n * 16;
  tables.forEach((t, i) => {
    const r = 12 + i * 16;
    o.setUint32(r, t.tag);
    o.setUint32(r + 4, t.checksum);
    o.setUint32(r + 8, pos);
    o.setUint32(r + 12, t.data.length);
    out.set(t.data, pos);
    pos += (t.data.length + 3) & ~3;
  });
  return out;
}

let font: hb.Font | undefined;

function loadFont() {
  font ??= new hb.Font(new hb.Face(new hb.Blob(woffToSfnt(readFileSync(FONT)).buffer)));
  return font;
}

function escape(text: string) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** SVG of `text`, shaped like a browser would. CSS font-size sets its size. */
export function lettering(text: string) {
  const f = loadFont();
  const buffer = new hb.Buffer();
  buffer.addText(text);
  buffer.guessSegmentProperties();
  hb.shape(f, buffer);
  const infos = buffer.getGlyphInfos();
  const positions = buffer.getGlyphPositions();

  // Put all glyphs into one path. Glyph outlines are y-up, SVG is y-down.
  let pen = 0;
  let minX = 0;
  let maxX = 0;
  let d = '';
  for (const [i, glyph] of infos.entries()) {
    const p = positions[i];
    const dx = pen + p.xOffset;
    const dy = -p.yOffset;
    d += f.glyphToPath(glyph.codepoint).replace(/(-?[\d.]+),(-?[\d.]+)/g, (_, x: string, y: string) => {
      const px = Math.round(Number(x) + dx);
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      return `${px} ${Math.round(dy - Number(y))}`;
    });
    pen += p.xAdvance;
  }
  maxX = Math.max(maxX, pen);

  const em = f.face.upem;
  const height = BOTTOM - TOP;
  return (
    `<svg class="lettering" viewBox="${minX} ${TOP} ${maxX - minX} ${height}" ` +
    `style="height:${(height / em).toFixed(3)}em" role="img" aria-label="${escape(text)}">` +
    `<path fill="currentColor" d="${d}"/></svg>`
  );
}

/** Replaces the text of every element with `data-lettering` in index.html. */
export function letteringPlugin(): Plugin {
  return {
    name: 'lettering',
    transformIndexHtml(html) {
      return html.replace(
        /(<(\w+)[^>]*\sdata-lettering[^>]*>)([^<]*)(<\/\2>)/g,
        (_, open: string, _tag: string, text: string, close: string) => open + lettering(text.trim()) + close,
      );
    },
  };
}
