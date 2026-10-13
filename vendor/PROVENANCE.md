# vendor: provenance

Files in this folder are unchanged copies from another NumaCore / Calibre tool. **Never edit a vendored file.** To take a
newer version: replace the file, update this table, re-run the reader comparison (`tools/reader-check.html`) on the test
files, and record the change in `record-of-change.html`.

| File | What it is | Version | SHA-256 | Source | Copied |
|---|---|---|---|---|---|
| `wor_xlsx_rows.js` | An .xlsx read one row at a time (no spreadsheet library; the zip directory by hand + `DecompressionStream`). Gives the cell values SheetJS 0.20.3 gives. | 0.1.0 | `1604dec93dedf28d8e980f89f2f1d1e4761be6743fac9722efdcce4a20acfc11` | WO Readiness `engine/wor_xlsx_rows.js`, release 0.5.6 (tag `v0.5.6`, 2026-10-08). Building Blocks harvest log entry H-26 (`ingest`, `read.file`). | 2026-10-13 |

## Why it is here

SheetJS holds a whole sheet as one piece of text, and a browser allows about 512 MB for one text. An MB51 sheet above that
size came back from the library **empty and without an error** (APP-INT-ROWREAD, 2026-10-13). `shared/parsers.js` now reads
every `.xlsx` through this reader and keeps only the mapped columns: on its own thread first (the page loads this same file
into the thread with `importScripts`), on the page where a thread cannot start. The library stays as the reader for `.xls`
and as the fallback where the browser has no `DecompressionStream`. `tools/mb51-check.html` uses the reader too.

## What Tune adds around it (in `shared/parsers.js`, not in the vendored file)

The reader hands over plain rows. Tune's own code reproduces what `sheet_to_json` did before, so the result is the same:
the header names (blank header = `__EMPTY`, a repeated header gets `_1`, `_2`), blank rows left out, the sheet choice, and
dates converted from the Excel serial number.
