/*
 wor_xlsx_rows.js: an .xlsx read one row at a time.

 Why: the spreadsheet library holds a whole sheet as one text, and the browser's limit for one text is about 512 MB. That is half a
 million rows of 25 columns. This reader unpacks a sheet in pieces and hands over one row at a time, so the size of a sheet is not a
 limit, and a caller that keeps only what it uses never holds the sheet.

 What it gives is what the library gives (XLSX.read, then sheet_to_json with header: 1, raw: true, defval: null, blankrows: true),
 cell for cell: the same range, the same types, the same text. The rules below are the library's own (xlsx 0.20.3), kept in its order.
 tools/compare_readers.js checks the two against each other on any folder of files. Run it after any change here.

 One thing differs, and it carries no value: a row with no value whose cell has a comment or a link. The library gives a full row
 of blanks for it, this reader an empty row. The ingest core treats both as a blank row.

 It reads values only: no styles, no number formats; a formula's stored result is the value.
 It needs DecompressionStream('deflate-raw'), ReadableStream and TextDecoder: Chrome and Edge 103+, Node 20.12+.
 Each rule below that looks odd was found by a comparison that failed: change one only with the comparison at hand.
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorXlsxRows = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const VERSION = '0.1.0';

function bytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('not the bytes of a file');
}

/* ───── the zip: its directory, and one part unpacked as a stream ───── */
function directory(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), n16 = o => dv.getUint16(o, true), n32 = o => dv.getUint32(o, true), n64 = o => Number(dv.getBigUint64(o, true));
  let e = b.length - 22; const stop = Math.max(0, b.length - 22 - 65535);
  while (e >= stop && n32(e) !== 0x06054b50) e--;
  if (e < stop) throw new Error('not an .xlsx file (no zip directory found)');
  let count = n16(e + 10), p = n32(e + 16);
  if (count === 0xFFFF || p === 0xFFFFFFFF) {
    const loc = e - 20; if (loc < 0 || n32(loc) !== 0x07064b50) throw new Error('not an .xlsx file (its zip directory is damaged)');
    const z = n64(loc + 8); count = n64(z + 32); p = n64(z + 48);
  }
  const out = [], dec = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (n32(p) !== 0x02014b50) throw new Error('not an .xlsx file (its zip directory is damaged)');
    const method = n16(p + 10), nl = n16(p + 28), xl = n16(p + 30), cl = n16(p + 32); let cs = n32(p + 20), us = n32(p + 24), at = n32(p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nl));
    for (let x = p + 46 + nl, xe = x + xl; x + 4 <= xe;) {
      const id = n16(x), sz = n16(x + 2);
      if (id === 1) { let q = x + 4; if (us === 0xFFFFFFFF) { us = n64(q); q += 8; } if (cs === 0xFFFFFFFF) { cs = n64(q); q += 8; } if (at === 0xFFFFFFFF) at = n64(q); }
      x += 4 + sz;
    }
    out.push({ name, method, cs, us, at });
    p += 46 + nl + xl + cl;
  }
  return out;
}
function unpacked(b, en) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(en.at, true) !== 0x04034b50) throw new Error('not an .xlsx file (a part of it is damaged)');
  const s = en.at + 30 + dv.getUint16(en.at + 26, true) + dv.getUint16(en.at + 28, true), end = s + en.cs, STEP = 1 << 20;
  let p = s;
  const src = new ReadableStream({ pull(c) { if (p >= end) { c.close(); return; } const q = Math.min(end, p + STEP); c.enqueue(b.slice(p, q)); p = q; } });
  if (en.method === 0) return src;
  if (en.method !== 8) throw new Error('a part of the file is packed in a way this reader does not know (method ' + en.method + ')');
  return src.pipeThrough(new DecompressionStream('deflate-raw'));
}
async function textOf(b, en) {
  if (!en) return '';
  const r = unpacked(b, en).getReader(), d = new TextDecoder('utf-8'); let s = '';
  for (;;) { const { done, value } = await r.read(); if (done) break; s += d.decode(value, { stream: true }); }
  return s + d.decode();
}

/* ───── text: the library's own unescape (entities, then _xHHHH_; \r\n to \n where it does so) ───── */
const ENC = /&(?:quot|apos|gt|lt|amp|#x?([\da-fA-F]+));/gi, COD = /_x([\da-fA-F]{4})_/gi, ENT = { '&quot;': '"', '&apos;': "'", '&gt;': '>', '&lt;': '<', '&amp;': '&' };
function unesc0(n) {
  const i = n.indexOf('<![CDATA[');
  if (i === -1) return n.replace(ENC, (m, r) => ENT[m] || String.fromCharCode(parseInt(r, m.indexOf('x') > -1 ? 16 : 10)) || m).replace(COD, (m, r) => String.fromCharCode(parseInt(r, 16)));
  const s = n.indexOf(']]>');
  return unesc0(n.slice(0, i)) + n.slice(i + 9, s) + unesc0(n.slice(s + 3));
}
function unesc(s, nl) {
  if (s.indexOf('&') < 0 && s.indexOf('_x') < 0 && s.indexOf('_X') < 0 && s.indexOf('<![CDATA[') < 0) return nl && s.indexOf('\r') >= 0 ? s.replace(/\r\n/g, '\n') : s;
  const a = unesc0(s); return nl ? a.replace(/\r\n/g, '\n') : a;
}
/* a short text cut out of a long one keeps the long one in memory: give it a copy of its own */
const own = s => s.length < 13 ? s : (' ' + s).slice(1);
const TAGS = /<[\/\?]?[a-zA-Z0-9:_-]+(?:\s+[^"\s?<>\/]+\s*=\s*(?:"[^"]*"|'[^']*'|[^'"<>\s=]+))*\s*[\/\?]?>/mg;
const T_ALL = /<(?:\w+:)?t\b[^<>]*>([^<]*)<\/(?:\w+:)?t>/g;
/* one string item: plain <t>, or runs <r> whose <t> are joined (phonetic text left out); anything else has no text */
function siText(e) {
  if (!e) return '';
  if (e.charCodeAt(0) === 60 && e.charCodeAt(1) === 116 && e.charCodeAt(2) === 62) { const z = e.indexOf('</t>', 3); return own(unesc(z < 0 ? e.slice(3) : e.slice(3, z), true)); }
  if (/^\s*<(?:\w+:)?t[^>]*>/.test(e)) return own(unesc(e.slice(e.indexOf('>') + 1).split(/<\/(?:\w+:)?t>/)[0] || '', true));
  if (/<(?:\w+:)?r\b[^<>]*>/.test(e)) return own(unesc((e.replace(/<(?:\w+:)?rPh\b[^<>]*>[\s\S]*?<\/(?:\w+:)?rPh>/g, '').match(T_ALL) || []).join('').replace(TAGS, ''), true));
  return undefined;
}

async function sharedStrings(b, en) {
  const out = []; if (!en) return out;
  const r = unpacked(b, en).getReader(), d = new TextDecoder('utf-8');
  let buf = '', pos = 0, inside = false, close = '</si>', open = /<(?:\w+:)?(?:si|sstItem)>/g;
  const take = piece => { const v = siText(piece.replace(open, '').trim()); out.push(v); };
  for (;;) {
    const { done, value } = await r.read();
    buf = (pos ? buf.slice(pos) : buf) + (done ? d.decode() : d.decode(value, { stream: true })); pos = 0;
    if (!inside) {
      const m = /<((?:\w+:)?)sst\b[^<>]*>/.exec(buf);
      if (m) { if (m[0].charAt(m[0].length - 2) === '/') return out; inside = true; pos = m.index + m[0].length; if (m[1]) close = '</' + m[1] + 'si>'; }
      else if (done) return out; else continue;
    }
    for (;;) {
      const z = buf.indexOf(close, pos); if (z < 0) break;
      take(buf.slice(pos, z)); pos = z + close.length;
    }
    if (done) break;
  }
  /* the library also counts what follows the last item, up to the end of the table (an empty entry) */
  const tail = buf.slice(pos), end = tail.search(/<\/(?:\w+:)?sst>/); if (end >= 0) take(tail.slice(0, end));
  return out;
}

/* ───── a range such as A1:Y4475, the way the library decodes it ───── */
function decodeRange(ref) {
  const cell = s => { let c = 0, r = 0, i = 0, ch; for (; i < s.length; i++) { ch = s.charCodeAt(i); if (ch === 36) continue; if (ch >= 97 && ch <= 122) ch -= 32; if (ch < 65 || ch > 90) break; c = 26 * c + (ch - 64); } for (; i < s.length; i++) { ch = s.charCodeAt(i); if (ch === 36) continue; if (ch < 48 || ch > 57) break; r = 10 * r + (ch - 48); } return { c: c - 1, r: r - 1 }; };
  const k = ref.indexOf(':'); if (k < 0) { const o = cell(ref); return { s: o, e: { c: o.c, r: o.r } }; }
  return { s: cell(ref.slice(0, k)), e: cell(ref.slice(k + 1)) };
}

const R_ATTR = /\sr\s*=\s*(?:"([^"]*)"|'([^']*)')/, R_ANY = /r=["']([^"']*)["']/, T_ATTR = /\st\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/* One sheet. opt.onRow(row, index): called for each row in order, and the rows are not kept; without it the rows are returned.
   opt.limit: stop after this many rows (a look at the top of a sheet). The result says the range and whether the sheet stated it.
   A sheet that does not state its range is gone through twice: once to find the smallest box around its rows and cells (the
   library's rule), once to hand the rows over. opt.range (from an earlier result) saves the first time. Nothing is held either way. */
async function readSheet(b, en, sst, opt) {
  opt = opt || {};
  const first = await pass(b, en, sst, opt);
  if (first.stated || opt.range || !first.range) return first;
  const second = await pass(b, en, sst, Object.assign({}, opt, { range: first.range }));
  second.stated = false; return second;
}
async function pass(b, en, sst, opt) {
  const onRow = opt.onRow || null, limit = opt.limit > 0 ? opt.limit : 0, rows = [];
  const res = { rows, range: null, stated: false, rowTags: 0, cells: 0, odd: 0 };
  if (!en) return res;
  const reader = unpacked(b, en).getReader(), dec = new TextDecoder('utf-8');
  let buf = '', pos = 0, state = 0, closeRow = '</row>', closeData = '</sheetData>', strip = null;
  let stated = null, said = false, W = 0, emitted = 0, stop = false;
  const guess = { s: { r: 2e6, c: 2e6 }, e: { r: 0, c: 0 } };
  const masters = {};
  let T = 0;
  const give = row => { if (stop) return; if (onRow) onRow(row, emitted); else rows.push(row); emitted++; if (limit && emitted >= limit) stop = true; };
  /* rows go out as they come, gaps as empty rows; with no range yet (the first time through) nothing goes out.
     A row with no cell is an empty list, except the first row of the range: the library always makes that one full width. */
  let next = 0;
  const gap = R => (R === stated.s.r ? new Array(W).fill(null) : []);
  const out = (R, cols, vals, any) => {
    if (!stated) return;
    if (R < stated.s.r || R > stated.e.r) return;
    if (R < next) { res.odd++; return; }
    while (next < R && !stop) { give(gap(next)); next++; }
    if (stop) return;
    let row;
    if (!any) row = gap(R);
    else { row = new Array(W).fill(null); for (let i = 0; i < cols.length; i++) { const c = cols[i] - stated.s.c; if (c >= 0 && c < W) row[c] = vals[i]; } }
    give(row); next = R + 1;
  };

  function rowPiece(d0) {
    let d = d0.trim(); if (d.length === 0) return;
    if (strip) d = d.replace(strip, '<$1');
    /* the row's own tag: the first '>' that does not close a tag by itself, and the last '<' before it */
    let g = d.indexOf('>'); while (g > 0 && d.charCodeAt(g - 1) === 47) g = d.indexOf('>', g + 1);
    const u = g < 0 ? d.length : g + 1; let H = g < 0 ? d.lastIndexOf('<') : d.lastIndexOf('<', g); if (H < 0) H = 0;
    if (H >= u) return;
    const tag = d.slice(H, u), ra = R_ATTR.exec(tag);
    T = ra ? parseInt(ra[1] != null ? ra[1] : ra[2], 10) : T + 1;
    res.rowTags++;
    if (guess.s.r > T - 1) guess.s.r = T - 1; if (guess.e.r < T - 1) guess.e.r = T - 1;
    const cols = [], vals = []; let any = false, y = -1;
    const nextCell = from => { let i = from; for (;;) { i = d.indexOf('<c', i); if (i < 0) return -1; const ch = d.charCodeAt(i + 2); if (ch === 32 || ch === 47 || ch === 62) return i; i += 2; } };
    let i = nextCell(u);
    while (i >= 0) {
      const nx = nextCell(i + 3);
      let a = i + 3, z = nx < 0 ? d.length : nx;
      while (a < z && d.charCodeAt(a) <= 32) a++; while (z > a && d.charCodeAt(z - 1) <= 32) z--;
      i = nx;
      if (a >= z) continue;
      let t = null, w0, w1 = z;
      if (d.charCodeAt(a) === 114 && d.charCodeAt(a + 1) === 61 && d.charCodeAt(a + 2) === 34) {
        /* the usual cell: r="AD12" first */
        let m = 0, q = a + 3, bb; while ((bb = d.charCodeAt(q) - 64) >= 1 && bb <= 26) { m = 26 * m + bb; q++; }
        y = m - 1;
        let rn = 0; while ((bb = d.charCodeAt(q) - 48) >= 0 && bb <= 9) { rn = 10 * rn + bb; q++; }
        if (rn !== T) res.odd++;
        const gt = d.indexOf('>', q);
        if (gt < 0 || gt >= z) { w0 = z; }
        else {
          w0 = gt + 1;
          const ti = d.indexOf(' t="', q);
          if (ti >= 0 && ti < gt) t = d.slice(ti + 4, d.indexOf('"', ti + 4));
          else if (d.indexOf("'", q) >= 0 && d.indexOf("'", q) < gt) { const tm = T_ATTR.exec(d.slice(a - 1, gt)); if (tm) t = tm[1] != null ? tm[1] : tm[2]; }
        }
      } else {
        /* any other form, taken the library's way: the first r="…" anywhere in the piece, or the next column */
        const piece = d.slice(a, z), p = R_ANY.exec(piece), dd = '<c ' + (piece.charAt(0) === '<' ? '>' : '') + piece;
        if (p) { let m = 0, bb; for (let k = 0; k < p[1].length; k++) { if ((bb = p[1].charCodeAt(k) - 64) < 1 || bb > 26) break; m = 26 * m + bb; } y = m - 1; if (parseInt(p[1].replace(/^[A-Z]+/, ''), 10) !== T) res.odd++; } else y++;
        let gt = dd.indexOf('>'); if (gt < 0) gt = dd.length - 1;
        const tm = T_ATTR.exec(dd.slice(0, gt + 1)); if (tm) t = tm[1] != null ? tm[1] : tm[2];
        w0 = a + (gt + 1 - (dd.length - piece.length)); if (w0 < a) w0 = a; if (w0 > z) w0 = z;
      }
      res.cells++;
      /* the stored value: <v>…</v>, not empty */
      let v, hasV = false;
      let vi = w0 < w1 ? d.indexOf('<v', w0) : -1;
      while (vi >= 0 && vi < w1) {
        const ch = d.charCodeAt(vi + 2);
        if (ch === 62 || ch === 32 || ch === 47 || ch === 9 || ch === 10 || ch === 13) {
          const vs = ch === 62 ? vi + 3 : d.indexOf('>', vi) + 1, ve = vs > 0 ? d.indexOf('</v>', vs) : -1;
          if (ve >= 0 && ve + 4 <= w1 && ve > vs) { v = d.slice(vs, ve); hasV = true; }
          break;
        }
        vi = d.indexOf('<v', vi + 2);
      }
      let f = false;
      const fi = w0 < w1 ? d.indexOf('<f', w0) : -1;
      if (fi >= 0 && fi < w1) {
        const ch = d.charCodeAt(fi + 2);
        if (ch === 62 || ch === 32 || ch === 47) {
          const gt = d.indexOf('>', fi), selfc = d.charCodeAt(gt - 1) === 47, head = d.slice(fi, gt + 1); let inner = '';
          if (!selfc) { const fe = d.indexOf('</f>', gt); inner = fe >= 0 && fe <= w1 ? d.slice(gt + 1, fe) : ''; }
          const shared = head.indexOf('t="shared"') > -1, sm = shared ? /\ssi="(\d+)"/.exec(head) : null;
          if (inner !== '') { f = true; if (sm) masters[sm[1]] = 1; } else if (sm && masters[sm[1]]) f = true;
        }
      }
      if (hasV) v = unesc(v);
      if (t == null && !hasV) { if (f) { v = 0; hasV = true; t = 'n'; } else continue; }
      else if (t == null || t === '') t = 'n';
      if (guess.s.c > y) guess.s.c = y; if (guess.e.c < y) guess.e.c = y;
      let val;
      switch (t) {
        /* a formula with no stored result: the library sets 0, then drops the cell (0 == "" in its test), so it counts for the range only */
        case 'n': if (!hasV || v === '' || typeof v === 'number') continue; val = parseFloat(v); break;
        case 's': if (!hasV) continue; val = sst[parseInt(v, 10)]; break;
        case 'str': val = hasV ? own(unesc(v, true)) : ''; break;
        case 'inlineStr': { const s0 = d.indexOf('<is', w0); let e = null; if (s0 >= 0 && s0 < w1) { const gt = d.indexOf('>', s0), ie = d.indexOf('</is>', gt); if (gt >= 0 && ie >= 0 && ie <= w1) e = d.slice(gt + 1, ie); } const tx = e != null && e !== '' ? siText(e) : (e === '' ? '' : null); val = tx == null ? (e != null && e !== '' ? undefined : '') : tx; break; }
        case 'b': val = v === '1' || v === 'true' || v === 'TRUE'; break;
        case 'd': { const ms = Date.parse(v); val = isNaN(ms) ? NaN : (ms - Date.UTC(1899, 11, 30)) / 86400000; break; }
        case 'e': val = null; break;
        default: val = hasV ? v : undefined;
      }
      any = true;
      if (val !== undefined && val !== null) { cols.push(y); vals.push(val); }
    }
    out(T - 1, cols, vals, any);
  }

  for (;;) {
    const { done, value } = await reader.read();
    buf = (pos ? buf.slice(pos) : buf) + (done ? dec.decode() : dec.decode(value, { stream: true })); pos = 0;
    if (state === 0) {
      /* the part before the rows: the range the sheet states (a single cell such as "A1" does not count, as in the library) */
      const m = /<((?:\w+:)?)sheetData\b[^<>]*>/.exec(buf);
      if (!m && !done) continue;
      const head = m ? buf.slice(0, m.index) : buf, di = head.search(/<(?:\w*:)?dimension/);
      if (di > 0) { const dm = /"(\w*:\w*)"/.exec(head.slice(di, di + 50)); if (dm) { const rg = decodeRange(dm[1]); if (rg.s.r <= rg.e.r && rg.s.c <= rg.e.c && rg.s.r >= 0 && rg.s.c >= 0) { stated = rg; said = true; } } }
      if (!stated && opt.range) stated = opt.range;
      if (stated) { W = stated.e.c - stated.s.c + 1; next = stated.s.r; }
      if (!m || m[0].charAt(m[0].length - 2) === '/') { state = 2; }
      else { state = 1; pos = m.index + m[0].length; if (m[1]) { closeRow = '</' + m[1] + 'row>'; closeData = '</' + m[1] + 'sheetData>'; strip = new RegExp('<(/?)' + m[1], 'g'); } }
    }
    if (state === 1) {
      for (;;) {
        const z = buf.indexOf(closeRow, pos); if (z < 0) break;
        rowPiece(buf.slice(pos, z)); pos = z + closeRow.length;
        if (stop) break;
      }
      if (!stop) { const z = buf.indexOf(closeData, pos); if (z >= 0) { rowPiece(buf.slice(pos, z)); state = 2; } }
    }
    if (stop) { try { await reader.cancel(); } catch (e) { /* the stream is closed either way */ } break; }
    if (done || state === 2) { if (!done) { try { await reader.cancel(); } catch (e) { /* closed */ } } break; }
  }
  res.stated = said;
  if (stated) { while (next <= stated.e.r && !stop) { give(gap(next)); next++; } res.range = stated; }
  /* no range stated: it is the smallest box around the rows and cells found, known only now */
  else if (guess.e.c >= guess.s.c && guess.e.r >= guess.s.r) res.range = guess;
  return res;
}

/* Open a workbook: its sheets in order, what wrote it, and a way to read a sheet. */
async function open(data) {
  const b = bytes(data), dir = directory(b), find = n => dir.find(e => e.name === n) || dir.find(e => e.name.toLowerCase() === n.toLowerCase());
  const wbx = await textOf(b, find('xl/workbook.xml')), relx = await textOf(b, find('xl/_rels/workbook.xml.rels'));
  if (!wbx) throw new Error('not an .xlsx file (it has no workbook part)');
  const attr = (tag, name) => { const m = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')').exec(tag); return m ? (m[1] != null ? m[1] : m[2]) : null; };
  const rels = {}; (relx.match(/<(?:\w+:)?Relationship\b[^<>]*>/g) || []).forEach(t => { rels[attr(t, 'Id')] = { target: attr(t, 'Target') || '', type: attr(t, 'Type') || '' }; });
  const part = target => target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  const sheets = (wbx.match(/<(?:\w+:)?sheet\b[^<>]*>/g) || []).map(t => { const rel = rels[attr(t, 'r:id') || attr(t, 'id')] || {}; return { name: unesc(attr(t, 'name') || ''), entry: rel.target ? find(part(rel.target)) : null, isSheet: /\/worksheet$/.test(rel.type || '') }; });
  const sstRel = Object.values(rels).find(r => /\/sharedStrings$/.test(r.type));
  const sstEntry = (sstRel && find(part(sstRel.target))) || find('xl/sharedStrings.xml');
  /* what wrote the file: the two property parts, found the library's way (by their type in the list of contents, not by their name) */
  const ctx = await textOf(b, find('[Content_Types].xml'));
  const listed = type => (ctx.match(/<(?:\w+:)?Override\b[^<>]*>/g) || []).find(x => attr(x, 'ContentType') === type) || null;
  const typed = type => { const t = listed(type); return t ? find((attr(t, 'PartName') || '').replace(/^\//, '')) : null; };
  const CORE = 'application/vnd.openxmlformats-package.core-properties+xml', APP = 'application/vnd.openxmlformats-officedocument.extended-properties+xml';
  /* the library reads the application's name only in a file that lists a core-properties part */
  const core = await textOf(b, typed(CORE)), app = listed(CORE) ? await textOf(b, typed(APP)) : '';
  const inTag = (x, re) => { const m = re.exec(x); return m ? unesc(m[1]) : undefined; };
  const props = { Application: inTag(app, /<(?:\w+:)?Application>([^<]*)</), LastAuthor: inTag(core, /<(?:\w+:)?lastModifiedBy>([^<]*)</) };
  let sst = null;
  return {
    sheetNames: sheets.map(s => s.name), props, parts: dir,
    sizeOf: name => { const s = sheets.find(x => x.name === name); return s && s.entry ? s.entry.us : 0; },
    async strings() { if (!sst) sst = await sharedStrings(b, sstEntry); return sst; },
    async sheet(name, opt) { const s = sheets.find(x => x.name === name); if (!s || !s.entry || !s.isSheet) return { rows: [], range: null, stated: false, rowTags: 0, cells: 0, odd: 0 }; return readSheet(b, s.entry, await this.strings(), opt); }
  };
}

return { VERSION, open, decodeRange, unesc };
});
