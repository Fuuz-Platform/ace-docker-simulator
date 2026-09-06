/*
 * FILE PARSERS — deconstruct a file into metadata, deterministically, with no dependencies.
 *
 * WHY NO LIBRARIES. These run inside Fuuz's vm2 sandbox (spec A.1): no npm, no require, no import,
 * eval and WebAssembly blocked, ES2017 built-ins only. So every parser here is self-contained and
 * reads bytes directly. That is a constraint, but it is also the right shape — a parser that only
 * ever reads and never fetches is auditable and cannot behave differently in the tenant than it did
 * on a laptop.
 *
 * WHY PARSING BEATS A VISION MODEL FOR MOST OF THIS. A vision model is the right tool for a scanned
 * raster drawing and the wrong tool for everything else. A CSV has a header row, an SVG has its
 * labels as text nodes, a PNG states its own dimensions in the first 24 bytes. Asking a model to
 * infer facts a file already declares is slower, costs money, and can be wrong — the SVG P&ID in
 * archive/pid carries all 44 of its tags as <text> elements, so JavaScript extracts them EXACTLY
 * while a vision pass would only approximate them.
 *
 * EVERY PARSER FAILS SOFT AND SAYS WHY. A malformed file is normal input, not an exception: the
 * caller gets {ok:false, reason} and the row records that it could not be read. A parser that
 * throws would fail a whole batch over one bad file.
 *
 * Shape returned by every parser:
 *   { ok, parser, parserVersion, reason?, metadata: {...}, promoted: { title?, rowCount?, ... } }
 * `promoted` is the handful of values worth being real columns — the rest stays in the JSON blob,
 * because inventing forty columns for facts nobody filters on is how a schema rots.
 */
'use strict';

const PARSER_VERSION = '1.0.0';

/* ── tiny helpers (no deps, sandbox-safe) ──────────────────────────────────────────────────── */

/* Latin-1 rather than UTF-8 for the binary sniffers: byte-for-byte, so a signature check can never
   be thrown off by a multi-byte sequence being folded into one replacement character. */
function latin1(bytes, from, to) {
  let s = '';
  const end = Math.min(to === undefined ? bytes.length : to, bytes.length);
  for (let i = from || 0; i < end; i++) { s += String.fromCharCode(bytes[i]); }
  return s;
}

/* Minimal UTF-8 decode. Node has TextDecoder; the sandbox is not guaranteed to, and a parser that
   only works in one of the two places it runs is worse than one that is slightly longer. */
function utf8(bytes) {
  let s = '', i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) { s += String.fromCharCode(b); i += 1; }
    else if (b >= 0xc0 && b < 0xe0 && i + 1 < bytes.length) {
      s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2;
    } else if (b >= 0xe0 && b < 0xf0 && i + 2 < bytes.length) {
      s += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3;
    } else if (b >= 0xf0 && i + 3 < bytes.length) {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      const u = cp - 0x10000;
      s += String.fromCharCode(0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff)); i += 4;
    } else { s += '�'; i += 1; }
  }
  return s;
}

const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const decodeEntities = s => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
  .replace(/&amp;/g, '&');

const result = (parser, metadata, promoted) => ({
  ok: true, parser, parserVersion: PARSER_VERSION, metadata: metadata || {}, promoted: promoted || {}
});
const failed = (parser, reason) => ({
  ok: false, parser, parserVersion: PARSER_VERSION, reason, metadata: {}, promoted: {}
});

/* ── CSV / TSV ─────────────────────────────────────────────────────────────────────────────── */

/* Delimiter is SNIFFED, not assumed. A European export is semicolon-delimited and guessing comma
   turns a 12-column file into a 1-column file with no error anywhere — the row count still looks
   plausible, which is what makes it dangerous. */
function sniffDelimiter(firstLine) {
  const cands = [',', ';', '\t', '|'];
  let best = ',', bestN = 0;
  for (const d of cands) {
    const n = firstLine.split(d).length - 1;
    if (n > bestN) { bestN = n; best = d; }
  }
  return { delimiter: best, count: bestN };
}

/* RFC4180 quoting: a delimiter inside quotes is data, and "" is an escaped quote. Splitting on the
   delimiter without this silently shreds any row containing an address. */
function splitCsvLine(line, d) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else { q = false; } }
      else { cur += c; }
    } else if (c === '"') { q = true; }
    else if (c === d) { out.push(cur); cur = ''; }
    else { cur += c; }
  }
  out.push(cur);
  return out;
}

const looksNumeric = v => v !== '' && /^-?\d+(\.\d+)?$/.test(v.trim());
const looksDate = v => /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(v.trim());
const looksBool = v => /^(true|false|yes|no|y|n)$/i.test(v.trim());

function parseCsv(bytes, name) {
  const text = utf8(bytes);
  if (!text.trim()) { return failed('csv', 'file is empty'); }
  const lines = text.split(/\r\n|\n|\r/).filter(l => l.length);
  if (!lines.length) { return failed('csv', 'no lines'); }
  const { delimiter, count } = sniffDelimiter(lines[0]);
  if (!count) { return failed('csv', 'no delimiter found in the first line — not delimited text'); }

  const header = splitCsvLine(lines[0], delimiter).map(h => h.trim().replace(/^"|"$/g, ''));
  const dataLines = lines.slice(1);
  /* Type inference from a SAMPLE, not the whole file: a million-row export should not cost a
     million regex passes to learn that column 3 is a date. */
  const sample = dataLines.slice(0, 200).map(l => splitCsvLine(l, delimiter));
  const columns = header.map((h, i) => {
    const vals = sample.map(r => (r[i] === undefined ? '' : r[i].trim())).filter(v => v !== '');
    let type = 'string';
    if (vals.length) {
      if (vals.every(looksNumeric)) { type = 'number'; }
      else if (vals.every(looksDate)) { type = 'date'; }
      else if (vals.every(looksBool)) { type = 'boolean'; }
    }
    return { name: h || '(unnamed ' + (i + 1) + ')', index: i, type,
             nonEmptyInSample: vals.length, example: vals.length ? clip(vals[0], 60) : null };
  });
  /* Ragged rows are the single most common real defect in a hand-edited CSV and the one thing a
     row count will never tell you. */
  const ragged = sample.filter(r => r.length !== header.length).length;

  return result('csv', {
    delimiter: delimiter === '\t' ? '\\t' : delimiter,
    headerRow: header, columns, sampledRows: sample.length,
    raggedRowsInSample: ragged,
    hasQuotedFields: /"/.test(text.slice(0, 5000))
  }, {
    title: name, rowCount: dataLines.length, columnCount: header.length,
    textPreview: clip(lines.slice(0, 3).join('\n'), 400)
  });
}

/* ── JSON ──────────────────────────────────────────────────────────────────────────────────── */

function shapeOf(v, depth) {
  if (v === null) { return 'null'; }
  if (Array.isArray(v)) { return depth > 3 ? 'array' : 'array<' + (v.length ? shapeOf(v[0], depth + 1) : 'empty') + '>'; }
  if (typeof v === 'object') { return 'object'; }
  return typeof v;
}
function deepest(v, d) {
  if (v === null || typeof v !== 'object') { return d; }
  let m = d;
  for (const k of Object.keys(v)) { const x = deepest(v[k], d + 1); if (x > m) { m = x; } }
  return m;
}

function parseJson(bytes, name) {
  const text = utf8(bytes);
  let v;
  try { v = JSON.parse(text); }
  catch (e) { return failed('json', 'not valid JSON: ' + String(e.message).slice(0, 120)); }
  const isArr = Array.isArray(v);
  const root = isArr ? (v.length ? v[0] : null) : v;
  const keys = root && typeof root === 'object' && !Array.isArray(root) ? Object.keys(root) : [];
  return result('json', {
    rootType: isArr ? 'array' : typeof v,
    arrayLength: isArr ? v.length : null,
    keys: keys.slice(0, 100),
    keyTypes: keys.slice(0, 100).map(k => ({ key: k, type: shapeOf(root[k], 0) })),
    maxDepth: deepest(v, 0)
  }, {
    title: name,
    rowCount: isArr ? v.length : null,
    columnCount: keys.length || null,
    textPreview: clip(text.replace(/\s+/g, ' '), 400)
  });
}

/* ── XML / SVG ─────────────────────────────────────────────────────────────────────────────── */

/* Regex, not a real XML parser, and the limits are deliberate: this extracts structure and text,
   it does not validate or resolve namespaces. Anything needing a true DOM belongs outside the
   sandbox. It does strip comments/CDATA first, because a tag name inside a comment is not a tag. */
function xmlElements(text) {
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const counts = {};
  const re = /<([A-Za-z_][\w.:-]*)/g;
  let m;
  while ((m = re.exec(stripped)) !== null) { counts[m[1]] = (counts[m[1]] || 0) + 1; }
  return { stripped, counts };
}

/* SVG text nodes carry x/y so they can be re-joined by POSITION. That matters for engineering
   drawings: an instrument bubble is drawn as two stacked labels ("TT" over "6002"), which are two
   separate <text> elements and one tag. Joining them by proximity recovers "TT-6002" exactly —
   something a vision model can only approximate. */
function svgTextNodes(stripped) {
  const nodes = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const attrs = m[1];
    const inner = decodeEntities(m[2].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    if (!inner) { continue; }
    const ax = /\bx\s*=\s*"([-\d.]+)"/.exec(attrs);
    const ay = /\by\s*=\s*"([-\d.]+)"/.exec(attrs);
    nodes.push({ text: inner, x: ax ? Number(ax[1]) : null, y: ay ? Number(ay[1]) : null });
  }
  return nodes;
}

/* Stacked labels: same x (within tolerance), y within a line-height, in reading order.
 *
 * ONLY SHORT, SPACELESS FRAGMENTS ARE JOINED, and that restriction is the whole correctness of this
 * function. An instrument bubble is "TT" stacked over "6002" — two fragments, one tag. An equipment
 * box is "CHILLER 2" stacked over "HOU-UTL-CHL-002" — a caption and a tag, which must NOT be
 * joined. Both pairs sit at the same x with an 18px gap, so geometry alone cannot separate them.
 * Joining indiscriminately produced "CHILLER 2-HOU-UTL-CHL-002" and lost all 8 equipment tags on
 * the reference drawing while appearing to work, because the 6 instrument tags still came out.
 *
 * Returns joins IN ADDITION TO the originals rather than replacing them, so a label that is already
 * a whole tag survives and the caller filters. */
const joinable = t => t.length <= 6 && !/\s/.test(t);

function joinStackedLabels(nodes, xTol, yGap) {
  const out = nodes.map(n => ({ text: n.text, x: n.x, y: n.y, joinedFrom: 1 }));
  const sorted = nodes.slice().sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0));
  const taken = {};
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (a.x === null || !joinable(a.text)) { continue; }
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (taken[j] || b.x === null || !joinable(b.text)) { continue; }
      if (Math.abs(b.x - a.x) <= xTol && b.y - a.y > 0 && b.y - a.y <= yGap) {
        out.push({ text: a.text + '-' + b.text, x: a.x, y: a.y, joinedFrom: 2 });
        taken[j] = 1;
        break;
      }
    }
  }
  return out;
}

/* An engineering tag, conservatively: letters+digits with separators, at least one digit, not a
   sentence. Deliberately narrow — a false tag becomes a candidate that matches nothing, and a
   drawing title turning into an "asset" is worse than missing one label. */
const TAG_RE = /^[A-Z0-9]{1,6}(?:[-_/][A-Z0-9]{1,6}){1,5}$/;
const isTagLike = s => TAG_RE.test(s) && /\d/.test(s) && s.length <= 40;

function parseXml(bytes, name, mimeType) {
  const text = utf8(bytes);
  if (!/<[A-Za-z_?!]/.test(text.slice(0, 2000))) { return failed('xml', 'no XML declaration or root element found'); }
  const { stripped, counts } = xmlElements(text);
  const rootM = /<([A-Za-z_][\w.:-]*)[\s>]/.exec(stripped.replace(/<\?[\s\S]*?\?>/g, ''));
  const root = rootM ? rootM[1] : null;
  const isSvg = root === 'svg' || /svg/.test(String(mimeType));

  const meta = {
    rootElement: root,
    elementCounts: Object.keys(counts).sort((a, b) => counts[b] - counts[a])
      .slice(0, 30).map(k => ({ element: k, count: counts[k] })),
    distinctElements: Object.keys(counts).length,
    namespaces: (text.match(/xmlns(:[\w.-]+)?="[^"]*"/g) || []).slice(0, 10)
  };
  const promoted = { title: name, textPreview: null };

  if (isSvg) {
    const wm = /\bwidth\s*=\s*"([\d.]+)/.exec(text);
    const hm = /\bheight\s*=\s*"([\d.]+)/.exec(text);
    const vb = /viewBox\s*=\s*"([^"]+)"/.exec(text);
    const nodes = svgTextNodes(stripped);
    const joined = joinStackedLabels(nodes, 6, 20);
    /* Dedupe: a tag can arrive both as a whole label and as a join, and it is one tag either way. */
    const seenTag = {};
    const tags = joined.filter(n => isTagLike(n.text)).filter(n => {
      if (seenTag[n.text]) { return false; }
      seenTag[n.text] = 1; return true;
    });
    /* A title element, else the largest/first label, is the closest thing an SVG has to a name. */
    const tm = /<title\b[^>]*>([\s\S]*?)<\/title>/.exec(stripped);

    meta.svg = {
      widthAttr: wm ? Number(wm[1]) : null,
      heightAttr: hm ? Number(hm[1]) : null,
      viewBox: vb ? vb[1] : null,
      textNodes: nodes.length,
      labels: nodes.map(n => n.text).slice(0, 200),
      /* The payload the P&ID pipeline actually wants — extracted, not inferred. */
      tagCandidates: tags.map(n => ({ tag: n.text, x: n.x, y: n.y, joinedFrom: n.joinedFrom }))
    };
    promoted.title = tm ? decodeEntities(tm[1]).trim() : (nodes.length ? nodes[0].text : name);
    promoted.widthPx = meta.svg.widthAttr;
    promoted.heightPx = meta.svg.heightAttr;
    promoted.tagCount = tags.length;
    promoted.textPreview = clip(nodes.map(n => n.text).join(' | '), 400);
    return result('svg', meta, promoted);
  }

  promoted.textPreview = clip(stripped.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), 400);
  return result('xml', meta, promoted);
}

/* ── PNG ───────────────────────────────────────────────────────────────────────────────────── */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_COLOR = { 0: 'greyscale', 2: 'rgb', 3: 'palette', 4: 'greyscale+alpha', 6: 'rgba' };

function parsePng(bytes, name) {
  if (bytes.length < 24) { return failed('png', 'shorter than a PNG header'); }
  for (let i = 0; i < 8; i++) { if (bytes[i] !== PNG_SIG[i]) { return failed('png', 'PNG signature missing'); } }
  /* IHDR is required to be the first chunk, so its offsets are fixed. */
  if (latin1(bytes, 12, 16) !== 'IHDR') { return failed('png', 'IHDR is not the first chunk — file is malformed'); }
  const width = be32(bytes, 16), height = be32(bytes, 20);
  /* Walk the chunk list for text metadata; stop at IDAT — everything interesting precedes the
     pixels, and walking compressed image data would be pointless work on a large file. */
  const chunks = [];
  const texts = [];
  let off = 8;
  while (off + 8 <= bytes.length && chunks.length < 50) {
    const len = be32(bytes, off);
    const type = latin1(bytes, off + 4, off + 8);
    chunks.push(type);
    if (type === 'tEXt' && len < 4096) {
      const raw = latin1(bytes, off + 8, off + 8 + len);
      const z = raw.indexOf(' ');
      if (z > 0) { texts.push({ key: raw.slice(0, z), value: clip(raw.slice(z + 1), 200) }); }
    }
    if (type === 'IDAT' || type === 'IEND') { break; }
    off += 12 + len;
  }
  return result('png', {
    width, height, bitDepth: bytes[24], colorType: PNG_COLOR[bytes[25]] || bytes[25],
    interlaced: bytes[28] === 1, chunks, textChunks: texts
  }, {
    title: (texts.find(t => /title/i.test(t.key)) || {}).value || name,
    widthPx: width, heightPx: height
  });
}

/* ── JPEG ──────────────────────────────────────────────────────────────────────────────────── */

function parseJpeg(bytes, name) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) { return failed('jpeg', 'SOI marker missing'); }
  let off = 2, width = null, height = null, exif = false, comment = null, progressive = false;
  while (off + 4 < bytes.length) {
    if (bytes[off] !== 0xff) { off++; continue; }              /* resync on padding */
    const marker = bytes[off + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    if (marker === 0xda || marker === 0xd9) { break; }          /* scan data — stop */
    const len = be16(bytes, off + 2);
    /* SOF0..SOF15 except the non-frame markers carry the real dimensions. Reading them from the
       first SOF rather than assuming SOF0 is what makes progressive JPEGs work. */
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (width === null) { height = be16(bytes, off + 5); width = be16(bytes, off + 7); }
      if (marker === 0xc2) { progressive = true; }
    }
    if (marker === 0xe1 && latin1(bytes, off + 4, off + 8) === 'Exif') { exif = true; }
    if (marker === 0xfe && len < 2048) { comment = clip(latin1(bytes, off + 4, off + 2 + len).replace(/ /g, ''), 200); }
    off += 2 + len;
  }
  if (width === null) { return failed('jpeg', 'no SOF frame header found'); }
  return result('jpeg', { width, height, progressive, hasExif: exif, comment },
    { title: name, widthPx: width, heightPx: height });
}

/* ── PDF ───────────────────────────────────────────────────────────────────────────────────── */

/* Structure and the Info dictionary only. Page TEXT is not extracted: content streams are usually
   Flate-compressed and the sandbox has no inflate, so anything claiming to read the words out of an
   arbitrary PDF here would be lying. Stated rather than silently returning empty text. */
function parsePdf(bytes, name) {
  const head = latin1(bytes, 0, 1024);
  const vm = /^%PDF-(\d\.\d)/.exec(head);
  if (!vm) { return failed('pdf', 'no %PDF header'); }
  const text = latin1(bytes);
  const countPages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const kidsCount = (() => { const m = /\/Count\s+(\d+)/.exec(text); return m ? Number(m[1]) : null; })();
  const info = {};
  for (const k of ['Title', 'Author', 'Subject', 'Creator', 'Producer', 'CreationDate', 'ModDate']) {
    const m = new RegExp('/' + k + '\\s*\\(((?:[^()\\\\]|\\\\.)*)\\)').exec(text);
    if (m) { info[k[0].toLowerCase() + k.slice(1)] = clip(m[1].replace(/\\([()\\])/g, '$1'), 200); }
  }
  const encrypted = /\/Encrypt\b/.test(text);
  return result('pdf', {
    pdfVersion: vm[1],
    pageCount: kidsCount !== null ? kidsCount : countPages,
    pageObjectsFound: countPages,
    encrypted,
    info,
    compressedStreams: (text.match(/\/FlateDecode/g) || []).length,
    textExtractable: false,
    textNote: 'page text is not extracted — content streams are Flate-compressed and the sandbox has no inflate'
  }, {
    title: info.title || name,
    pageCount: kidsCount !== null ? kidsCount : countPages
  });
}

/* ── plain text ────────────────────────────────────────────────────────────────────────────── */

function parseText(bytes, name) {
  const text = utf8(bytes);
  const lines = text.split(/\r\n|\n|\r/);
  const nonEmpty = lines.filter(l => l.trim()).length;
  /* Markdown headings are the only text structure worth promoting — they are the file's own outline. */
  const headings = lines.filter(l => /^#{1,6}\s+\S/.test(l)).slice(0, 40).map(l => l.replace(/^#+\s*/, '').trim());
  return result('text', {
    lineCount: lines.length, nonEmptyLines: nonEmpty,
    headings, hasTabs: /\t/.test(text),
    longestLine: lines.reduce((a, l) => Math.max(a, l.length), 0)
  }, {
    title: headings.length ? headings[0] : name,
    rowCount: lines.length,
    textPreview: clip(text.replace(/\s+/g, ' ').trim(), 400)
  });
}

/* ── dispatch ──────────────────────────────────────────────────────────────────────────────── */

/* Content sniffing BEFORE the declared mimeType. A browser upload of a .csv routinely arrives as
   application/vnd.ms-excel, and a drop folder guesses from the extension — the bytes are the only
   source that cannot be wrong. */
function sniff(bytes, name, mimeType) {
  if (bytes.length >= 8) {
    let png = true;
    for (let i = 0; i < 8; i++) { if (bytes[i] !== PNG_SIG[i]) { png = false; break; } }
    if (png) { return 'png'; }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) { return 'jpeg'; }
  if (latin1(bytes, 0, 5) === '%PDF-') { return 'pdf'; }
  const head = utf8(bytes.slice ? bytes.slice(0, 2048) : bytes).replace(/^﻿/, '').trim();
  if (/^<\?xml|^<svg[\s>]/i.test(head)) { return /svg/i.test(head.slice(0, 300)) ? 'xml' : 'xml'; }
  if (/^[[{]/.test(head)) { return 'json'; }
  if (/^</.test(head)) { return 'xml'; }
  const ext = String(name || '').toLowerCase().replace(/^.*\./, '');
  if (ext === 'csv' || ext === 'tsv') { return 'csv'; }
  if (ext === 'json') { return 'json'; }
  if (ext === 'xml' || ext === 'svg') { return 'xml'; }
  /* Delimited text is the last structural guess before falling back to prose. */
  const firstLine = head.split(/\r\n|\n|\r/)[0] || '';
  if (sniffDelimiter(firstLine).count >= 2) { return 'csv'; }
  if (/^(text\/|application\/(x-)?(yaml|toml))/.test(String(mimeType))) { return 'text'; }
  return bytes.length && head.replace(/[\x20-\x7e\s]/g, '').length / Math.max(1, head.length) > 0.3 ? 'binary' : 'text';
}

function parse(bytes, name, mimeType) {
  const kind = sniff(bytes, name, mimeType);
  switch (kind) {
    case 'png':  return parsePng(bytes, name);
    case 'jpeg': return parseJpeg(bytes, name);
    case 'pdf':  return parsePdf(bytes, name);
    case 'json': return parseJson(bytes, name);
    case 'xml':  return parseXml(bytes, name, mimeType);
    case 'csv':  return parseCsv(bytes, name);
    case 'text': return parseText(bytes, name);
    default:
      return failed('binary', 'unrecognised binary format (' + (mimeType || 'unknown mime') + ') — ' +
        'no parser claims it, so nothing is asserted about its contents');
  }
}

module.exports = { parse, sniff, PARSER_VERSION,
                   parseCsv, parseJson, parseXml, parsePng, parseJpeg, parsePdf, parseText,
                   utf8, latin1, isTagLike, joinStackedLabels, svgTextNodes };
