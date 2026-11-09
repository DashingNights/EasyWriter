# WordCraft's metafile reader as WebAssembly

EMF and WMF pictures in a .docx draw through this module on every platform (docs/plans/word/briefs/metafile-wasm.md). It is
WordCraft's `crates/metafile` (MIT OR Apache-2.0, LICENSE-MIT and LICENSE-APACHE here) at the commit in PIN, with EasyWriter's
binding, built for wasm32 with wasm-bindgen. The WordCraft evaluation (docs/plans/word/wordcraft-eval.md, section 4) measured it.

## Files

- The crate's source is `engine/crates/metafile` (package ew-metafile), in the engine's workspace with its other crates
  (engine/README.md), which share these changes.
- `binding/`: the binding. It parses a file, places it with the crate's `Picture::place` and writes SVG: paths, bitmaps as PNG,
  text runs as `<text>` at the file's own advances, and clip boxes as clipPaths. ANSI text in a code page other than
  Windows-1252 is decoded with the platform's TextDecoder (Encoding Standard labels, so it works in a worker and in the web app). From the evaluation's `wcmeta`, without its
  native resvg comparison binary.
- `wcmeta_bg.wasm`: the built module. `wcmeta_bg.mjs` is wasm-bindgen's glue for it (the bundler target, kept as .mjs), and
  `wasm-bytes.mjs` holds the same bytes as base64. Inlining them lets the module load from file:// in Electron and from a web
  server alike, with no fetch. All three are generated: do not edit them.
- `index.mjs`: the entry point. `drawMetafile(bytes, w, h)` returns an SVG data URL or null, `emfPlusOnly(bytes)` reads the
  file's records, and `summary(bytes)` is for tests. It uses plain web APIs only, so it runs in a worker, on a page and in Node.

A page that loads it needs `'wasm-unsafe-eval'` in its Content-Security-Policy's script-src (index.html has it). Without that,
`drawMetafile` returns null and the caller falls back.

## Changes to the crate

- WMF text: CREATEFONTINDIRECT (the font now has its character set), SETTEXTCOLOR, SETTEXTALIGN, TEXTOUT and EXTTEXTOUT, and
  EMF EMR_EXTTEXTOUTA. ANSI strings are decoded as Windows-1252, or byte for byte for a symbol font. A font whose character set
  has its own code page (Greek, Cyrillic, Chinese, Japanese, Korean and the rest) keeps the run's bytes and code page
  (`Text::ansi`) for the renderer to decode. A NUL ends a string; trailing spaces stay.
- EXTTEXTOUT with ETO_CLIPPED (WMF and EMF) clips its run to the record's rectangle.
- Clipping: INTERSECTCLIPRECT (WMF and EMF) and EMR_EXTSELECTCLIPRGN with RGN_COPY or RGN_AND, kept as one box per item
  (`Picture::clips`, `PlacedItem` `clip`), saved and restored with the DC.

Each has a test in `engine/crates/metafile/src/tests.rs`.

## Gaps

- EMF+ records are not read. `emfPlusOnly` finds an EMF+ only file from its EMF+ header, and the import sends such files to the
  system's renderer (src/metafile-main.js, GDI+ on Windows); the web app shows a placeholder.
- Clip regions are boxes. EXCLUDECLIPRECT, SELECTCLIPPATH, WMF SELECTCLIPREGION and regions of several rectangles (beyond their
  bounds) are not applied.
- Background mode and colour, ETO_OPAQUE text backgrounds and hatch brushes are not drawn. Text in Johab (character set 130)
  is left out: the Encoding Standard has no decoder for it.
- A text cell height is taken as 1.2 em; the crate's `Text::layout` would use the font's metrics.

## Rebuilding

```
node scripts/build-metafile-wasm.mjs
```

It needs the toolchain engine/rust-toolchain.toml pins, with its `wasm32-unknown-unknown` target, and wasm-bindgen-cli 0.2.129, the
version binding/Cargo.toml pins.
Cargo builds outside the repository (`%TEMP%\easywriter-wcmeta-target`). To run the crate's tests, set `CARGO_TARGET_DIR` outside
the repository too and run `cargo test --manifest-path engine/Cargo.toml -p ew-metafile`.

After a change to the crate, rebuild and run test/word-metafile-wasm.test.mjs. The engine follows no upstream WordCraft
(engine/ORIGIN.md), so there is no re-pin.
