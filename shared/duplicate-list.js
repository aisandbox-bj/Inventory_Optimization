/*═══ BUILD-STAMP ═══════════════════════════════════════════════════════════
   Inventory Optimization App · shared/duplicate-list.js · v2.2.0-dev
   APP-DUP-FLAG (data layer)

   Parses an operator-uploaded "potential duplicates" list into a canonical,
   additive block and provides a fast per-material lookup. Two file shapes are
   auto-detected (no fixed SAP column schema — this is an operator worklist, not
   an ERP export):

     (1) FLAT LIST — a single column of SAP material numbers. Every listed
         material is flagged a potential duplicate; there are no families.

     (2) FAMILIES — column A = the REFERENCE material; its potential duplicates
         are either spread across the remaining columns of the same row, OR
         given as a comma/semicolon/pipe/line-break (or all-numeric space-)separated
         list of SAP #s in one cell. Tokens must look like a material number (no
         spaces, at least one digit) — description text in any column is ignored
         (both are handled, even mixed). The reference material is itself part of
         its family (so the family view can show the reference's own details
         alongside the candidates), and is marked isReference.

   Canonical block (additive — no SCHEMA_VERSION bump):
     json.duplicates = {
       hasFamilies: <bool>,
       materials:   [ "<sap>", ... ],                     // every flagged material (flat ∪ all family members incl. refs)
       families:    [ { ref:"<sap>", refDesc:"", members:["<sap>", ...] }, ... ]   // members INCLUDE the ref
     }

   Nothing here mutates any existing data; a material simply gains a lookup.
═════════════════════════════════════════════════════════════════════════════*/
(function (global) {
  'use strict';

  // A SAP material number as it appears in this dataset: keep leading zeros,
  // trim surrounding whitespace, coerce numbers to strings. Blank → null.
  function norm(v) {
    if (v == null) return null;
    var s = String(v).trim();
    return s ? s : null;
  }

  // A token that can be a SAP material number: no spaces, only id-ish characters, and
  // at least one digit. Description words ("SLACK", "O-RING") fail this and are ignored.
  function isMaterialToken(t) {
    return /^[A-Za-z0-9._\/-]+$/.test(t) && /\d/.test(t);
  }

  // Split one cell that may itself carry several SAP #s. Separators are comma,
  // semicolon, pipe or line break. A piece containing spaces is only split further
  // if EVERY space-separated part looks like a material number ("7000002 7000003");
  // otherwise it's free text (a description column) and is dropped — never turned
  // into fake duplicate materials (code-review 2026-09-25).
  function splitCell(v) {
    if (v == null) return [];
    var out = [];
    String(v).split(/[,;|\r\n\t]+/).forEach(function (piece) {
      piece = piece.trim();
      if (!piece) return;
      var parts = piece.split(/\s+/);
      if (parts.every(isMaterialToken)) parts.forEach(function (p) { out.push(p); });
    });
    return out;
  }

  /* Parse a matrix of rows (each row an array of cell values, as SheetJS
     sheet_to_json({header:1}) or PapaParse produce) into the canonical block.
     A single-column array of strings is also accepted (treated as a flat list).
     `descOf` (optional) maps a material → description for the family header. */
  function parse(rows, descOf) {
    descOf = descOf || function () { return ''; };
    if (!Array.isArray(rows)) return { hasFamilies: false, materials: [], families: [] };

    // Drop a header row, judged on the RAW first cell (before token filtering): a
    // label such as "Reference" / "Material" has letters and no digit. Header cells
    // like "Dup1" contain a digit, so the check must use column A, not the tokens.
    if (rows.length > 1) {
      var first = Array.isArray(rows[0]) ? rows[0][0] : rows[0];
      var a0 = first == null ? '' : String(first).trim();
      if (/[a-z]/i.test(a0) && !/\d/.test(a0)) rows = rows.slice(1);
    }

    // Normalise every row to an array of cell tokens (splitting multi-value cells).
    var norml = rows.map(function (row) {
      if (Array.isArray(row)) {
        // flatten: each cell may hold several SAP #s
        var out = [];
        row.forEach(function (cell) { splitCell(cell).forEach(function (t) { out.push(t); }); });
        return out;
      }
      // a bare scalar row (single-column CSV) — may still be a multi-value cell
      return splitCell(row);
    }).map(function (cells) { return cells.map(norm).filter(Boolean); })
      .filter(function (cells) { return cells.length > 0; });

    if (!norml.length) return { hasFamilies: false, materials: [], families: [] };

    var hasFamilies = norml.some(function (cells) { return cells.length > 1; });
    var seen = Object.create(null);
    var materials = [];
    function add(m) { if (m && !seen[m]) { seen[m] = true; materials.push(m); } }

    if (!hasFamilies) {
      norml.forEach(function (cells) { add(cells[0]); });
      return { hasFamilies: false, materials: materials, families: [] };
    }

    // Families — col A is the reference, the remaining tokens are candidates.
    // The reference is included in members so the review view shows it too.
    var families = [];
    norml.forEach(function (cells) {
      var ref = cells[0];
      if (!ref) return;
      var memSeen = Object.create(null);
      var members = [];
      cells.forEach(function (m) { if (m && !memSeen[m]) { memSeen[m] = true; members.push(m); } });
      if (members.length < 2) return;   // a lone material in "families" mode isn't a family; skip (still flagged below via flat pass)
      members.forEach(add);
      families.push({ ref: ref, refDesc: descOf(ref) || '', members: members });
    });

    // Any single-token rows in a families file are still flagged as plain duplicates.
    norml.forEach(function (cells) { if (cells.length === 1) add(cells[0]); });

    return { hasFamilies: families.length > 0, materials: materials, families: families };
  }

  /* Build a lookup over a parsed (or stored) duplicates block. Safe on null. */
  function index(dup) {
    dup = dup || {};
    var mats = new Set((dup.materials || []).map(String));
    var families = (dup.families || []).map(function (f) {
      return { ref: String(f.ref), refDesc: f.refDesc || '', members: (f.members || []).map(String) };
    });
    var famByMember = new Map();
    var refs = new Set();
    families.forEach(function (f) {
      refs.add(f.ref);
      f.members.forEach(function (m) { if (!famByMember.has(m)) famByMember.set(m, f); });
    });
    return {
      loaded: mats.size > 0 || families.length > 0,
      hasFamilies: families.length > 0,
      isDuplicate: function (m) { return mats.has(String(m)); },
      isReference: function (m) { return refs.has(String(m)); },
      familyOf: function (m) { return famByMember.get(String(m)) || null; },
      allDuplicateMaterials: function () { return [...mats]; },
      families: function () { return families; },
      count: function () { return mats.size; },
      familyCount: function () { return families.length; }
    };
  }

  /* Read an uploaded file as a raw matrix of rows (NO header interpretation — the
     shared AppParsers.parseFile treats row 1 as headers, which would swallow the
     first SAP # of a headerless list). CSV/TXT via PapaParse (delimiter auto-
     detected); XLSX/XLS via SheetJS, taking the sheet with the most rows, as
     displayed text (so leading zeros shown in Excel are kept). */
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var ext = (String(file && file.name || '').split('.').pop() || '').toLowerCase();
      var text = (ext === 'csv' || ext === 'tsv' || ext === 'txt');
      var r = new FileReader();
      r.onerror = function () { reject(r.error); };
      r.onload = function () {
        try {
          if (text) {
            var out = Papa.parse(r.result, { header: false, skipEmptyLines: true });
            resolve(out.data || []);
          } else {
            var wb = XLSX.read(new Uint8Array(r.result), { type: 'array' });
            var best = [], bestN = -1;
            wb.SheetNames.forEach(function (n) {
              var rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null, blankrows: false, raw: false });
              if (rows.length > bestN) { best = rows; bestN = rows.length; }
            });
            resolve(best);
          }
        } catch (e) { reject(e); }
      };
      if (text) r.readAsText(file); else r.readAsArrayBuffer(file);
    });
  }

  global.DuplicateList = { parse: parse, index: index, norm: norm, splitCell: splitCell, isMaterialToken: isMaterialToken, readFile: readFile };

})(window);
